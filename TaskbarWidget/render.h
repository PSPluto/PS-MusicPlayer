#pragma once
#ifndef RENDER_H
#define RENDER_H

#include <windows.h>
#include <gdiplus.h>
#include <string>
#include <memory>

enum class WidgetHitTarget {
    None,
    Pill,
    Prev,
    PlayPause,
    Next
};

struct TrackInfo {
    std::wstring title = L"Music";
    std::wstring artist = L"Artist";
    bool isPlaying = false;
    std::string pictureBase64;
    COLORREF dominantColor = RGB(227, 227, 227);
    bool hasCustomColor = false;
    Gdiplus::Bitmap* coverBitmap = nullptr;
};

class TaskbarRenderer {
public:
    TaskbarRenderer();
    ~TaskbarRenderer();

    void UpdateTrack(const TrackInfo& info);
    void UpdatePlayback(bool isPlaying);
    void UpdateColor(const std::string& colorStr);
    void UpdateDimensions(int width, int height);

    void Render(HDC hdc, int width, int height, float marqueeOffset, WidgetHitTarget hoverTarget);
    WidgetHitTarget HitTest(int x, int y, int width, int height);

    float GetMarqueeTextWidth() const { return m_marqueeTextWidth; }
    float GetMarqueeViewportWidth() const { return m_marqueeViewportWidth; }

private:
    TrackInfo m_track;
    int m_width = 270;
    int m_height = 40;
    float m_marqueeTextWidth = 0.0f;
    float m_marqueeViewportWidth = 130.0f;

    Gdiplus::GdiplusStartupInput m_gdiplusStartupInput;
    ULONG_PTR m_gdiplusToken = 0;

    Gdiplus::Bitmap* m_bmpPrev = nullptr;
    Gdiplus::Bitmap* m_bmpPlay = nullptr;
    Gdiplus::Bitmap* m_bmpPause = nullptr;
    Gdiplus::Bitmap* m_bmpNext = nullptr;

    void FreeCoverBitmap();
    void LoadCoverFromBase64(const std::string& base64Str);
    void LoadButtonBitmaps();
};

#endif // RENDER_H
