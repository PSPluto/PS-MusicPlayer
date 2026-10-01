#include "render.h"
#include <algorithm>
#include <cmath>
#include <sstream>
#include <wincrypt.h>

#pragma comment(lib, "gdiplus.lib")
#pragma comment(lib, "crypt32.lib")

using namespace Gdiplus;

// ===========================================================
//  TaskbarRenderer - GDI+ ウィジェットレンダラー (Material 3 スタイル)
//
//  このファイルは Material Design 3 のトークンに合わせて
//  配色・シェイプ・ステートレイヤーを再構成したものです。
//
//    - Color:  M3 ダークカラースキーム (Surface / Primary トーン)
//    - Shape:  M3 シェイプスケール (Medium=12dp / Full=circle)
//    - State:  M3 ステートレイヤーの不透明度 (Hover=8%, Pressed=12%)
//
//  [ボタンビットマップアイコン] (assets/bitmap/ 内に配置)
//    skip_previous_64dp.png  ... 前のトラックボタン画像
//    play_circle_64dp.png    ... 再生ボタン画像
//    pause_circle_64dp.png   ... 一時停止ボタン画像
//    skip_next_64dp.png      ... 次のトラックボタン画像
//
//  PNGファイルが見つからない場合は、ベクターによるフォールバック描画が使用されます。
// ===========================================================

// -----------------------------------------------------------
//  Material 3 カラートークン (ダークスキーム、ベースライン風のパレット)
//  https://m3.material.io/styles/color/roles
// -----------------------------------------------------------
namespace M3 {
// Surface Container (widget背景) - サーフェスの階調
constexpr BYTE SurfaceContainerR = 0x25, SurfaceContainerG = 0x23,
               SurfaceContainerB = 0x33; // #252329 相当
constexpr BYTE SurfaceContainerHighR = 0x2E, SurfaceContainerHighG = 0x2B,
               SurfaceContainerHighB = 0x33; // ホバー時（一段明るいコンテナ）

// On-Surface (テキスト/アイコンの主色)
constexpr BYTE OnSurfaceR = 0xE6, OnSurfaceG = 0xE1, OnSurfaceB = 0xE5;
// On-Surface Variant (二次テキスト)
constexpr BYTE OnSurfaceVarR = 0xCA, OnSurfaceVarG = 0xC4, OnSurfaceVarB = 0xD0;
// Outline / Outline Variant (境界線)
constexpr BYTE OutlineVarR = 0x49, OutlineVarG = 0x45, OutlineVarB = 0x4F;

// Primary (アクセント。ビジュアライザーカラー未指定時のデフォルト強調色)
constexpr BYTE PrimaryR = 0xD0, PrimaryG = 0xBC, PrimaryB = 0xFF; // #D0BCFF

// Secondary Container (アルバムアート プレースホルダー等の塗り)
constexpr BYTE SecondaryContainerR = 0x4A, SecondaryContainerG = 0x45,
               SecondaryContainerB = 0x58;
constexpr BYTE OnSecondaryContainerR = 0xE8, OnSecondaryContainerG = 0xDE,
               OnSecondaryContainerB = 0xF8;

// ステートレイヤーの不透明度 (M3仕様: ホバー時 8%、フォーカス/押下時 12%)
constexpr BYTE StateHoverAlpha = (BYTE)(255 * 0.08);   // ≈20
constexpr BYTE StatePressedAlpha = (BYTE)(255 * 0.12); // ≈31
} // namespace M3

// TaskbarWidget.exe からの相対パスで assets/bitmap/ へのパスを解決します。
// [編集不要] フォルダ構成が変更されない限り。
static std::wstring GetAssetsPath(const std::wstring &filename) {
  wchar_t exePath[MAX_PATH];
  GetModuleFileNameW(NULL, exePath, MAX_PATH);
  std::wstring path(exePath);
  size_t pos = path.find_last_of(L"\\/");
  if (pos != std::wstring::npos) {
    std::wstring dir = path.substr(0, pos);
    // ../assets/bitmap/ を試行 (標準のビルドレイアウト)
    std::wstring p1 = dir + L"\\..\\assets\\bitmap\\" + filename;
    if (GetFileAttributesW(p1.c_str()) != INVALID_FILE_ATTRIBUTES)
      return p1;
    // 同じフォルダ内の assets/bitmap/ を試行
    std::wstring p2 = dir + L"\\assets\\bitmap\\" + filename;
    if (GetFileAttributesW(p2.c_str()) != INVALID_FILE_ATTRIBUTES)
      return p2;
  }
  return L"assets\\bitmap\\" + filename;
}

TaskbarRenderer::TaskbarRenderer() {
  GdiplusStartup(&m_gdiplusToken, &m_gdiplusStartupInput, NULL);
  LoadButtonBitmaps();
}

TaskbarRenderer::~TaskbarRenderer() {
  FreeCoverBitmap();
  if (m_bmpPrev)
    delete m_bmpPrev;
  if (m_bmpPlay)
    delete m_bmpPlay;
  if (m_bmpPause)
    delete m_bmpPause;
  if (m_bmpNext)
    delete m_bmpNext;
  if (m_gdiplusToken != 0)
    GdiplusShutdown(m_gdiplusToken);
}

// assets/bitmap/ からボタンのPNG画像を読み込みます。
// [カスタマイズ可能] ここでファイル名を変更して、異なるアイコンを使用できます。
void TaskbarRenderer::LoadButtonBitmaps() {
  m_bmpPrev =
      Bitmap::FromFile(GetAssetsPath(L"skip_previous_64dp.png").c_str());
  m_bmpPlay = Bitmap::FromFile(GetAssetsPath(L"play_circle_64dp.png").c_str());
  m_bmpPause =
      Bitmap::FromFile(GetAssetsPath(L"pause_circle_64dp.png").c_str());
  m_bmpNext = Bitmap::FromFile(GetAssetsPath(L"skip_next_64dp.png").c_str());
}

void TaskbarRenderer::FreeCoverBitmap() {
  if (m_track.coverBitmap) {
    delete m_track.coverBitmap;
    m_track.coverBitmap = nullptr;
  }
}

// データURIから "data:image/...;base64," のプレフィックスを取り除きます
static std::string ExtractBase64Payload(const std::string &dataUri) {
  size_t pos = dataUri.find("base64,");
  if (pos != std::string::npos)
    return dataUri.substr(pos + 7);
  return dataUri;
}

// Electronから送信されたアルバムアート（base64データURI）をデコードします
void TaskbarRenderer::LoadCoverFromBase64(const std::string &base64Str) {
  FreeCoverBitmap();
  if (base64Str.empty())
    return;

  std::string rawData = ExtractBase64Payload(base64Str);
  DWORD dwDecodedSize = 0;
  if (!CryptStringToBinaryA(rawData.c_str(), 0, CRYPT_STRING_BASE64, NULL,
                            &dwDecodedSize, NULL, NULL))
    return;

  HGLOBAL hGlobal = GlobalAlloc(GMEM_MOVEABLE, dwDecodedSize);
  if (!hGlobal)
    return;

  void *pBuffer = GlobalLock(hGlobal);
  if (pBuffer) {
    CryptStringToBinaryA(rawData.c_str(), 0, CRYPT_STRING_BASE64,
                         (BYTE *)pBuffer, &dwDecodedSize, NULL, NULL);
    GlobalUnlock(hGlobal);
    IStream *pStream = NULL;
    if (SUCCEEDED(CreateStreamOnHGlobal(hGlobal, TRUE, &pStream))) {
      Bitmap *bmp = Bitmap::FromStream(pStream);
      pStream->Release();
      if (bmp && bmp->GetLastStatus() == Ok)
        m_track.coverBitmap = bmp;
      else {
        if (bmp)
          delete bmp;
        m_track.coverBitmap = nullptr;
      }
    }
  }
}

// Electronの "update-track" コマンドから呼び出されます
void TaskbarRenderer::UpdateTrack(const TrackInfo &info) {
  m_track.title = info.title.empty() ? L"Music" : info.title;
  m_track.artist = info.artist.empty() ? L"Artist" : info.artist;
  m_track.isPlaying = info.isPlaying;
  m_track.pictureBase64 = info.pictureBase64;
  LoadCoverFromBase64(info.pictureBase64);
}

// Electronの "update-playback" コマンドから呼び出されます
void TaskbarRenderer::UpdatePlayback(bool isPlaying) {
  m_track.isPlaying = isPlaying;
}

// "rgb(r, g, b)" 形式のカラー文字列を解析します
static bool ParseRGB(const std::string &str, BYTE &r, BYTE &g, BYTE &b) {
  if (str.find("rgb") == 0) {
    size_t op = str.find('('), cp = str.find(')');
    if (op != std::string::npos && cp != std::string::npos) {
      std::stringstream ss(str.substr(op + 1, cp - op - 1));
      int ir, ig, ib;
      char ch;
      if (ss >> ir >> ch >> ig >> ch >> ib) {
        r = (BYTE)std::clamp(ir, 0, 255);
        g = (BYTE)std::clamp(ig, 0, 255);
        b = (BYTE)std::clamp(ib, 0, 255);
        return true;
      }
    }
  }
  return false;
}

// Electronの "visualizer-color" コマンドから呼び出されます。
// ウィジェットの境界線のアクセント（Primary）の発光色を設定します。
void TaskbarRenderer::UpdateColor(const std::string &colorStr) {
  BYTE r, g, b;
  if (ParseRGB(colorStr, r, g, b)) {
    m_track.dominantColor = RGB(r, g, b);
    m_track.hasCustomColor = true;
  } else {
    m_track.hasCustomColor = false;
  }
}

void TaskbarRenderer::UpdateDimensions(int width, int height) {
  m_width = width;
  m_height = height;
}

// ユーティリティ:
// 角丸矩形のパスを構築します。半径が大きいほど角が丸くなります。
static void AddRoundedRectToPath(GraphicsPath &path, RectF rect, float radius) {
  float d = radius * 2.0f;
  float rx = rect.X + rect.Width, ry = rect.Y + rect.Height;
  path.AddArc(rect.X, rect.Y, d, d, 180, 90);
  path.AddArc(rx - d, rect.Y, d, d, 270, 90);
  path.AddArc(rx - d, ry - d, d, d, 0, 90);
  path.AddArc(rect.X, ry - d, d, d, 90, 90);
  path.CloseFigure();
}

// ===========================================================
//  Render() - メインの描画関数、約30fpsで呼び出されます
//
//  引数:
//    hdc           ... ターゲットDC (DIBSection メモリビットマップ)
//    width, height ... ウィジェットのピクセルサイズ (main.cpp
//    でDPIスケール済み) marqueeOffset ... 曲名のスクロール位置 (ピクセル単位)
//    (1フレームあたり +0.8px) hoverTarget   ... マウスが現在乗っているUI要素
// ===========================================================
void TaskbarRenderer::Render(HDC hdc, int width, int height,
                             float marqueeOffset, WidgetHitTarget hoverTarget) {
  m_width = width;
  m_height = height;

  // -------------------------------------------------------
  // スケールファクター (倍率)
  // 以下のすべてのサイズは、高さ=40px（ベースライン）を基準に作成されています。
  // このファクターにより、すべてが比例してスケールされます。
  // [カスタマイズ可能] ベースラインのサイズを変更するには、40.0f
  // を変更してください。
  // -------------------------------------------------------
  float scale = (float)height / 40.0f;
  if (scale < 0.8f)
    scale = 0.8f; // 最小スケールの保護

  // 高品質な GDI+ レンダリング設定 [編集不要]
  Graphics graphics(hdc);
  graphics.SetSmoothingMode(SmoothingModeAntiAlias);
  graphics.SetTextRenderingHint(TextRenderingHintClearTypeGridFit);
  graphics.SetPixelOffsetMode(PixelOffsetModeHighQuality);
  graphics.SetCompositingQuality(CompositingQualityHighQuality);
  graphics.SetInterpolationMode(InterpolationModeHighQualityBicubic);

  // 完全な透明でクリアする (UpdateLayeredWindow のアルファ合成に必要)
  graphics.Clear(Color(0, 0, 0, 0));

  // -------------------------------------------------------
  // ピル（カプセル型）の背景 == M3の "Surface Container" カプセル
  // -------------------------------------------------------

  // 境界線のストロークがクリッピングされないように、0.5px内側に寄せた外側の矩形
  RectF pillRect(0.5f, 2.0f, (float)width - 1.0f, (float)height - 4.0f);

  // ピルの角丸の半径。
  // M3 シェイプスケール: コンパクトなツールバー/ピル向けの完全な丸（Full）。
  // [カスタマイズ可能] 角の丸みを減らすには、16.0f*scale (Large)
  // に近づけてください。
  float cornerRadius = (std::min)((float)height, (float)width) / 4.0f;

  GraphicsPath pillPath;
  AddRoundedRectToPath(pillPath, pillRect, cornerRadius);

  // 背景の塗りつぶし = M3 Surface Container にドミナントカラーを薄くブレンド
  // hasCustomColor が true のとき、曲のアクセントカラーを約18%ブレンドして
  // 背景をアルバムアートの色と同期させます。
  // [カスタマイズ可能] blendRatio を変更してブレンド量を調整できます。
  BYTE bgR = M3::SurfaceContainerR, bgG = M3::SurfaceContainerG,
       bgB = M3::SurfaceContainerB;
  BYTE bgAlpha = 235; // 約92%の不透明度 (M3のサーフェスはほぼ不透明です)

  if (m_track.hasCustomColor) {
    // ドミナントカラーを Surface Container に薄くブレンドする
    // blendRatio=0.0f で完全に M3 デフォルト、1.0f で完全にドミナントカラー
    constexpr float blendRatio = 0.18f; // 18% blend — 控えめに色を乗せる
    BYTE cr = GetRValue(m_track.dominantColor);
    BYTE cg = GetGValue(m_track.dominantColor);
    BYTE cb = GetBValue(m_track.dominantColor);
    // まずドミナントカラーを暗くして Surface Container レベルに落とす (×0.35)
    float dr = cr * 0.35f, dg = cg * 0.35f, db = cb * 0.35f;
    bgR = (BYTE)(M3::SurfaceContainerR * (1.0f - blendRatio) + dr * blendRatio);
    bgG = (BYTE)(M3::SurfaceContainerG * (1.0f - blendRatio) + dg * blendRatio);
    bgB = (BYTE)(M3::SurfaceContainerB * (1.0f - blendRatio) + db * blendRatio);
  }

  if (hoverTarget == WidgetHitTarget::Pill) {
    // ホバー時は一段明るくする (+10 程度)
    bgR = (BYTE)(((int)bgR + 10 < 255) ? ((int)bgR + 10) : 255);
    bgG = (BYTE)(((int)bgG + 10 < 255) ? ((int)bgG + 10) : 255);
    bgB = (BYTE)(((int)bgB + 10 < 255) ? ((int)bgB + 10) : 255);
    bgAlpha = 245;
  }
  SolidBrush bgBrush(Color(bgAlpha, bgR, bgG, bgB));
  graphics.FillPath(&bgBrush, &pillPath);

  // 境界線のストローク = M3 Outline
  // Variant、またはアクセント（ビジュアライザー）カラーが有効な場合は Primary
  // の色合い。
  Color borderColor(90, M3::OutlineVarR, M3::OutlineVarG, M3::OutlineVarB);
  if (m_track.hasCustomColor) {
    BYTE cr = GetRValue(m_track.dominantColor);
    BYTE cg = GetGValue(m_track.dominantColor);
    BYTE cb = GetBValue(m_track.dominantColor);
    borderColor =
        Color(110, cr, cg, cb); // アクセントで色付けされたアウトライン（発光）
  }
  Pen borderPen(
      borderColor,
      0.0f); // ピクセル単位の境界線の太さ (固定値、スケールされません)
  graphics.DrawPath(&borderPen, &pillPath);

  // -------------------------------------------------------
  // アルバムアート == M3 "Medium" シェイプ (12dpの角丸ファミリー)
  // -------------------------------------------------------

  // カバーアートのサイズと位置
  // [カスタマイズ可能] 34.0f = カバーアートのサイズ(px)、3.5f = 左マージン
  float coverSize = 34.0f * scale;
  float coverY = ((float)height - coverSize) / 2.0f; // 垂直方向の中央揃え
  float coverX = 2.5f * scale; // 左マージン (M3風の4dpグリッド)
  RectF coverRect(coverX, coverY, coverSize, coverSize);

  // アルバムアートの角丸半径 — M3 Medium シェイプ (約12dp)
  float coverRadius = 8.0f * scale;
  GraphicsPath coverPath;
  AddRoundedRectToPath(coverPath, coverRect, coverRadius);

  if (m_track.coverBitmap) {
    // Electronから受信したアルバムアートを描画する
    graphics.SetClip(&coverPath);
    graphics.DrawImage(m_track.coverBitmap, coverRect.X, coverRect.Y,
                       coverRect.Width, coverRect.Height);
    graphics.ResetClip();
  } else {
    // プレースホルダー == M3 "Secondary Container" の色合いに "On-Secondary
    // Container" のグリフ。
    // M3が空状態のアバター/アートを描画する方法に合わせています。
    SolidBrush coverBgBrush(Color(255, M3::SecondaryContainerR,
                                  M3::SecondaryContainerG,
                                  M3::SecondaryContainerB));
    graphics.FillPath(&coverBgBrush, &coverPath);

    // [カスタマイズ可能] L"\u266A" (♪) を好きな文字や記号に変更できます。
    Font noteFont(L"Segoe UI", 14.0f * scale, FontStyleBold, UnitPixel);
    SolidBrush noteBrush(Color(220, M3::OnSecondaryContainerR,
                               M3::OnSecondaryContainerG,
                               M3::OnSecondaryContainerB));
    StringFormat centerSf;
    centerSf.SetAlignment(StringAlignmentCenter);
    centerSf.SetLineAlignment(StringAlignmentCenter);
    graphics.DrawString(L"\u266A", -1, &noteFont, coverRect, &centerSf,
                        &noteBrush);
  }

  // アルバムアート上の控えめな内側のストローク (Outline Variant, 非常に薄い)
  Pen coverPen(Color(35, M3::OutlineVarR, M3::OutlineVarG, M3::OutlineVarB),
               1.0f);
  graphics.DrawPath(&coverPen, &coverPath);

  // -------------------------------------------------------
  // メディアコントロールボタン == M3 "Filled Tonal Icon Button" (円形)
  // -------------------------------------------------------

  // ボタンのサイズとレイアウト
  // [カスタマイズ可能] btnSize = ボタンのタッチターゲットサイズ, 4.0f*scale =
  // 右マージン
  float btnSize = 30.0f * scale; // ボタンの幅と高さ（ヒットエリアでもあります）
  float btnY = ((float)height - btnSize) / 2.0f; // 垂直方向の中央揃え
  float btnGap = 4.0f * scale; // ボタン間のギャップ (M3のスペーシング)
  float nextBtnX = (float)width - btnSize - 5.0f * scale; // "Next" button X
  float playBtnX = nextBtnX - btnSize - btnGap; // "Play/Pause" button X
  float prevBtnX = playBtnX - btnSize - btnGap; // "Prev" button X

  // ボタン内のアイコンの描画サイズ:
  // M3の美学に合わせて、ボタン全体よりわずかに小さくしています。
  float iconScale = 0.72f;
  float iconSize = btnSize * iconScale;
  float iconOffset = (btnSize - iconSize) / 2.0f;

  // M3のアイコンボタンは完全な円形です (Shape: Full)
  float btnRadius = btnSize / 2.0f;

  RectF prevRect(prevBtnX, btnY, btnSize, btnSize);
  RectF playRect(playBtnX, btnY, btnSize, btnSize);
  RectF nextRect(nextBtnX, btnY, btnSize, btnSize);

  // ヘルパー:
  // M3のステートレイヤー（ホバー）を描画してから、アイコン描画関数を呼び出します
  auto DrawIconButton = [&](RectF rect, WidgetHitTarget targetType,
                            auto drawIconFunc) {
    if (hoverTarget == targetType) {
      // ステートレイヤー: M3のホバー時不透明度(8%)の On-Surface の色合い
      GraphicsPath btnPath;
      AddRoundedRectToPath(btnPath, rect, btnRadius);
      SolidBrush hoverBrush(Color(M3::StateHoverAlpha, M3::OnSurfaceR,
                                  M3::OnSurfaceG, M3::OnSurfaceB));
      graphics.FillPath(&hoverBrush, &btnPath);
    }
    drawIconFunc(rect);
  };

  // PREV (戻る) ボタン: assets/bitmap/skip_previous_64dp.png
  // PNGの読み込みに失敗した場合、ベクター描画 (On-Surface の色合い)
  // にフォールバックします
  DrawIconButton(prevRect, WidgetHitTarget::Prev, [&](RectF rect) {
    if (m_bmpPrev && m_bmpPrev->GetLastStatus() == Ok) {
      graphics.DrawImage(m_bmpPrev, rect.X + iconOffset, rect.Y + iconOffset,
                         iconSize, iconSize);
    } else {
      // フォールバックのベクター: |< の図形
      SolidBrush iconBrush(
          Color(255, M3::OnSurfaceR, M3::OnSurfaceG, M3::OnSurfaceB));
      float cx = rect.X + rect.Width / 2.0f;
      float cy = rect.Y + rect.Height / 2.0f;
      float h = 4.2f * scale;
      float w = 3.8f * scale;
      float barW = 1.6f * scale;
      PointF p1[] = {PointF(cx + w * 0.5f + 0.8f * scale, cy - h),
                     PointF(cx - w * 0.5f + 0.8f * scale, cy),
                     PointF(cx + w * 0.5f + 0.8f * scale, cy + h)};
      graphics.FillPolygon(&iconBrush, p1, 3);
      graphics.FillRectangle(&iconBrush, cx - w * 0.5f - barW - 0.8f * scale,
                             cy - h, barW, h * 2.0f);
    }
  });

  // PLAY/PAUSE (再生/一時停止) ボタン == M3 "Filled" アイコンボタン
  // (色付きの塗りつぶし円。 アクセントカラーが有効な場合は Primary
  // を使用し、それ以外は On-Surface の色合いを使用します):
  //   再生中  -> assets/bitmap/pause_circle_64dp.png
  //   停止中  -> assets/bitmap/play_circle_64dp.png
  DrawIconButton(playRect, WidgetHitTarget::PlayPause, [&](RectF rect) {
    Bitmap *targetBmp = m_track.isPlaying ? m_bmpPause : m_bmpPlay;
    if (targetBmp && targetBmp->GetLastStatus() == Ok) {
      graphics.DrawImage(targetBmp, rect.X + iconOffset, rect.Y + iconOffset,
                         iconSize, iconSize);
    } else {
      // フォールバックのベクター: 塗りつぶされた円 (Primary または On-Surface)
      // に、Surface Container
      // カラーで切り抜かれた再生/一時停止シンボルを描画します。M3の "Filled"
      // アイコンボタンの扱いを再現しています。
      float cx = rect.X + rect.Width / 2.0f;
      float cy = rect.Y + rect.Height / 2.0f;
      float r = (iconSize / 2.0f) - 0.5f * scale;

      BYTE fillR = M3::PrimaryR, fillG = M3::PrimaryG, fillB = M3::PrimaryB;
      if (m_track.hasCustomColor) {
        fillR = GetRValue(m_track.dominantColor);
        fillG = GetGValue(m_track.dominantColor);
        fillB = GetBValue(m_track.dominantColor);
      }
      SolidBrush circleBrush(Color(255, fillR, fillG, fillB));
      graphics.FillEllipse(&circleBrush, cx - r, cy - r, r * 2.0f, r * 2.0f);

      // Surface Container カラーで描画される内側の切り抜き (ピルの背景と一致)
      SolidBrush innerBrush(Color(255, M3::SurfaceContainerR,
                                  M3::SurfaceContainerG,
                                  M3::SurfaceContainerB));
      if (m_track.isPlaying) {
        // 2つの角丸の一時停止バー
        float barW = 2.0f * scale;
        float barH = 7.5f * scale;
        float rad = 0.8f * scale;
        GraphicsPath bar1, bar2;
        AddRoundedRectToPath(
            bar1, RectF(cx - 2.6f * scale, cy - barH * 0.5f, barW, barH), rad);
        AddRoundedRectToPath(
            bar2, RectF(cx + 0.6f * scale, cy - barH * 0.5f, barW, barH), rad);
        graphics.FillPath(&innerBrush, &bar1);
        graphics.FillPath(&innerBrush, &bar2);
      } else {
        // 右向きの再生用三角形
        float tw = 5.0f * scale;
        float th = 5.0f * scale;
        PointF p[] = {PointF(cx - tw * 0.5f + 1.0f * scale, cy - th),
                      PointF(cx + tw * 0.5f + 1.0f * scale, cy),
                      PointF(cx - tw * 0.5f + 1.0f * scale, cy + th)};
        graphics.FillPolygon(&innerBrush, p, 3);
      }
    }
  });

  // NEXT (次へ) ボタン: assets/bitmap/skip_next_64dp.png
  DrawIconButton(nextRect, WidgetHitTarget::Next, [&](RectF rect) {
    if (m_bmpNext && m_bmpNext->GetLastStatus() == Ok) {
      graphics.DrawImage(m_bmpNext, rect.X + iconOffset, rect.Y + iconOffset,
                         iconSize, iconSize);
    } else {
      // フォールバックのベクター: >| の図形
      SolidBrush iconBrush(
          Color(255, M3::OnSurfaceR, M3::OnSurfaceG, M3::OnSurfaceB));
      float cx = rect.X + rect.Width / 2.0f;
      float cy = rect.Y + rect.Height / 2.0f;
      float h = 4.2f * scale;
      float w = 3.8f * scale;
      float barW = 1.6f * scale;
      PointF p1[] = {PointF(cx - w * 0.5f - 0.8f * scale, cy - h),
                     PointF(cx + w * 0.5f - 0.8f * scale, cy),
                     PointF(cx - w * 0.5f - 0.8f * scale, cy + h)};
      graphics.FillPolygon(&iconBrush, p1, 3);
      graphics.FillRectangle(&iconBrush, cx + w * 0.5f + 0.8f * scale, cy - h,
                             barW, h * 2.0f);
    }
  });

  // -------------------------------------------------------
  // 曲のテキスト == M3 タイポグラフィスケール (Title Small / Body Small)
  // -------------------------------------------------------

  // テキスト領域は、カバーアートの右端から Prev ボタンの左端まで広がります
  // [カスタマイズ可能] 10.0f = カバーアート後のギャップ, 8.0f =
  // ボタン前のギャップ
  float textX = (coverRect.X + coverRect.Width) + 10.0f * scale;
  float textRight = prevRect.X - 8.0f * scale;
  float textWidth = textRight - textX;
  if (textWidth < 10.0f * scale)
    textWidth = 10.0f * scale; // 最小幅の保護

  m_marqueeViewportWidth = textWidth; // マーキースクロールの検出に使用されます

  // タイトルとアーティスト用のフォント — M3 の Title Small / Body Small
  // にマッピングされています。 [カスタマイズ可能]
  // フォントファミリー名、サイズ、またはスタイルを変更できます。
  Font titleFont(L"Segoe UI", 12.5f * scale, FontStyleBold,
                 UnitPixel); // ≈ M3 Title Small (14sp/Medium 相当)
  Font artistFont(L"Segoe UI", 10.5f * scale, FontStyleRegular,
                  UnitPixel); // ≈ M3 Body Small (12sp/Regular 相当)

  // マーキースクロールが必要かどうかを判断するために、タイトルテキストの幅を測定します
  RectF textBounds;
  graphics.MeasureString(m_track.title.c_str(), -1, &titleFont, PointF(0, 0),
                         &textBounds);
  m_marqueeTextWidth = textBounds.Width;

  // タイトルの垂直方向の位置
  // [カスタマイズ可能] titleY = タイトルテキストの上端
  // (ウィジェットの上端からのpx)
  //                titleH = タイトル行のクリッピング高さ
  float titleY = 3.5f * scale;
  float titleH = 18.0f * scale;
  RectF titleRect(textX, titleY, textWidth, titleH);
  graphics.SetClip(titleRect); // テキストがはみ出さないようにクリップする

  // タイトルのテキストカラー = M3 On-Surface
  SolidBrush titleBrush(
      Color(255, M3::OnSurfaceR, M3::OnSurfaceG, M3::OnSurfaceB));

  if (m_marqueeTextWidth > textWidth) {
    // マーキースクロール (タイトルが長すぎて収まらない場合)
    // スクロール速度は main.cpp で制御されます (TIMER_MARQUEE = 30ms,
    // 1ティックあたり += 0.8f)
    std::wstring unitText = m_track.title + L"        ";
    RectF unitBounds;
    graphics.MeasureString(unitText.c_str(), -1, &titleFont, PointF(0, 0),
                           &unitBounds);
    float cycleWidth = unitBounds.Width;
    if (cycleWidth < 1.0f)
      cycleWidth = 1.0f;

    std::wstring marqueeText = unitText + unitText + unitText;
    float offset = std::fmod(marqueeOffset, cycleWidth);
    if (offset < 0.0f)
      offset += cycleWidth;

    float currentX = textX - offset;
    graphics.DrawString(marqueeText.c_str(), -1, &titleFont,
                        PointF(currentX, titleY), &titleBrush);
  } else {
    // 静的 (ビューポートに収まる場合): 必要に応じて "..." で切り詰めます
    StringFormat sfNoWrap;
    sfNoWrap.SetTrimming(StringTrimmingEllipsisCharacter);
    sfNoWrap.SetFormatFlags(StringFormatFlagsNoWrap);
    graphics.DrawString(m_track.title.c_str(), -1, &titleFont, titleRect,
                        &sfNoWrap, &titleBrush);
  }

  graphics.ResetClip();

  // アーティスト名の位置
  // [カスタマイズ可能] artistY = アーティスト行の上端
  // (タイトル行の下に配置する必要があります)
  //                artistH = クリッピング高さ
  float artistY = 21.5f * scale;
  float artistH = 15.0f * scale;
  RectF artistRect(textX, artistY, textWidth, artistH);

  // アーティストのテキストカラー = M3 On-Surface Variant (二次テキストの色合い)
  SolidBrush artistBrush(
      Color(255, M3::OnSurfaceVarR, M3::OnSurfaceVarG, M3::OnSurfaceVarB));
  StringFormat artistSf;
  artistSf.SetTrimming(StringTrimmingEllipsisCharacter);
  artistSf.SetFormatFlags(StringFormatFlagsNoWrap);
  graphics.DrawString(m_track.artist.c_str(), -1, &artistFont, artistRect,
                      &artistSf, &artistBrush);
}

// ===========================================================
//  HitTest() - マウスクリックの検出
//  Render()
//  と同じ座標計算を使用し、クリック可能な領域が常に見た目と一致するようにします。
//  点 (x, y) がどのUI要素に含まれるかを返します。
// ===========================================================
WidgetHitTarget TaskbarRenderer::HitTest(int x, int y, int width, int height) {
  if (x < 0 || x >= width || y < 0 || y >= height)
    return WidgetHitTarget::None;

  float scale = (float)height / 40.0f;
  if (scale < 0.8f)
    scale = 0.8f;

  float btnSize = 30.0f * scale;
  float btnY = ((float)height - btnSize) / 2.0f;
  float btnGap = 4.0f * scale;
  float nextBtnX = (float)width - btnSize - 5.0f * scale;
  float playBtnX = nextBtnX - btnSize - btnGap;
  float prevBtnX = playBtnX - btnSize - btnGap;

  if (x >= prevBtnX && x < prevBtnX + btnSize && y >= btnY &&
      y < btnY + btnSize)
    return WidgetHitTarget::Prev;
  if (x >= playBtnX && x < playBtnX + btnSize && y >= btnY &&
      y < btnY + btnSize)
    return WidgetHitTarget::PlayPause;
  if (x >= nextBtnX && x < nextBtnX + btnSize && y >= btnY &&
      y < btnY + btnSize)
    return WidgetHitTarget::Next;

  // その他の領域 (ピル本体、テキスト、カバーアート) =
  // ウィジェット全体のクリック
  return WidgetHitTarget::Pill;
}