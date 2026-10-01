#include <windows.h>
#include <uiautomation.h>
#include <iostream>
#include <string>
#include <thread>
#include <mutex>
#include <queue>
#include <atomic>
#include <chrono>
#include "render.h"

#pragma comment(lib, "user32.lib")
#pragma comment(lib, "gdi32.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "oleaut32.lib")

typedef UINT(WINAPI* pfnGetDpiForWindow)(HWND hWnd);

static pfnGetDpiForWindow g_GetDpiForWindow = nullptr;

static TaskbarRenderer g_renderer;
static HWND g_hWnd = NULL;
static HWND g_hMainWnd = NULL;
static HWINEVENTHOOK g_hWinEventHook = NULL;

static int g_widgetWidth = 280;
static int g_widgetHeight = 40;
static float g_marqueeOffset = 0.0f;
static WidgetHitTarget g_hoverTarget = WidgetHitTarget::None;
static bool g_isMouseTracking = false;

static std::mutex g_trackMutex;
static TrackInfo g_pendingTrack;
static std::string g_pendingColor;
static bool g_hasPendingTrack = false;
static bool g_hasPendingPlayback = false;
static bool g_pendingIsPlaying = false;
static bool g_hasPendingColor = false;
static std::atomic<bool> g_running{ true };

#define WM_IPC_UPDATE (WM_USER + 101)
#define TIMER_MARQUEE 1
#define TIMER_POSITION 2

// Forward declarations
static void RedrawWidget();

static float GetDpiScale(HWND hWnd) {
    if (g_GetDpiForWindow && hWnd) {
        UINT dpi = g_GetDpiForWindow(hWnd);
        if (dpi > 0) return (float)dpi / 96.0f;
    }
    HDC hdc = GetDC(NULL);
    int dpiX = GetDeviceCaps(hdc, LOGPIXELSX);
    ReleaseDC(NULL, hdc);
    if (dpiX > 0) return (float)dpiX / 96.0f;
    return 1.0f;
}

static std::string ExtractJsonValue(const std::string& json, const std::string& key) {
    std::string searchKey = "\"" + key + "\":";
    size_t pos = json.find(searchKey);
    if (pos == std::string::npos) {
        searchKey = "\"" + key + "\" :";
        pos = json.find(searchKey);
    }
    if (pos == std::string::npos) return "";

    pos += searchKey.length();
    while (pos < json.length() && (json[pos] == ' ' || json[pos] == '\t')) pos++;
    if (pos >= json.length()) return "";

    if (json[pos] == '"') {
        pos++;
        std::string result;
        while (pos < json.length()) {
            if (json[pos] == '\\' && pos + 1 < json.length()) {
                char next = json[pos + 1];
                if (next == 'n') result += '\n';
                else if (next == 'r') result += '\r';
                else if (next == 't') result += '\t';
                else if (next == '"') result += '"';
                else if (next == '\\') result += '\\';
                else result += next;
                pos += 2;
            } else if (json[pos] == '"') {
                break;
            } else {
                result += json[pos];
                pos++;
            }
        }
        return result;
    } else {
        size_t endPos = json.find_first_of(",}\r\n", pos);
        if (endPos == std::string::npos) endPos = json.length();
        std::string val = json.substr(pos, endPos - pos);
        val.erase(0, val.find_first_not_of(" \t"));
        val.erase(val.find_last_not_of(" \t") + 1);
        return val;
    }
}

static std::wstring Utf8ToWstring(const std::string& str) {
    if (str.empty()) return L"";
    int count = MultiByteToWideChar(CP_UTF8, 0, str.c_str(), (int)str.length(), NULL, 0);
    std::wstring wstr(count, 0);
    MultiByteToWideChar(CP_UTF8, 0, str.c_str(), (int)str.length(), &wstr[0], count);
    return wstr;
}

static int GetTrayLeftX() {
    HWND hTaskbar = FindWindowW(L"Shell_TrayWnd", NULL);
    if (!hTaskbar) return 0;

    int trayLeftX = 0;

    HWND hNotify = FindWindowExW(hTaskbar, NULL, L"TrayNotifyWnd", NULL);
    if (hNotify) {
        RECT rc;
        if (GetWindowRect(hNotify, &rc)) {
            if (rc.left > 300) {
                return rc.left;
            }
        }
    }

    IUIAutomation* pAutomation = NULL;
    HRESULT hr = CoCreateInstance(CLSID_CUIAutomation, NULL, CLSCTX_INPROC_SERVER, IID_IUIAutomation, (void**)&pAutomation);
    if (SUCCEEDED(hr) && pAutomation) {
        IUIAutomationElement* pTaskbarElem = NULL;
        hr = pAutomation->ElementFromHandle(hTaskbar, &pTaskbarElem);
        if (SUCCEEDED(hr) && pTaskbarElem) {
            IUIAutomationCondition* pCondition = NULL;
            pAutomation->CreateTrueCondition(&pCondition);
            if (pCondition) {
                IUIAutomationElementArray* pChildren = NULL;
                pTaskbarElem->FindAll(TreeScope_Descendants, pCondition, &pChildren);
                if (pChildren) {
                    int count = 0;
                    pChildren->get_Length(&count);
                    for (int i = 0; i < count; i++) {
                        IUIAutomationElement* pChild = NULL;
                        if (SUCCEEDED(pChildren->GetElement(i, &pChild)) && pChild) {
                            BSTR bstrAutoId = NULL;
                            BSTR bstrClass = NULL;
                            RECT rect = { 0 };
                            pChild->get_CurrentAutomationId(&bstrAutoId);
                            pChild->get_CurrentClassName(&bstrClass);
                            pChild->get_CurrentBoundingRectangle(&rect);

                            std::wstring autoId = bstrAutoId ? bstrAutoId : L"";
                            std::wstring cls = bstrClass ? bstrClass : L"";

                            if (bstrAutoId) SysFreeString(bstrAutoId);
                            if (bstrClass) SysFreeString(bstrClass);

                            int width = rect.right - rect.left;
                            int height = rect.bottom - rect.top;

                            if (width > 0 && height > 0 && rect.left > 400) {
                                if (cls == L"TrayNotifyWnd" || autoId == L"SystemTrayControlHost" || autoId == L"TaskbarFrame" || autoId.find(L"ControlCenter") != std::wstring::npos) {
                                    if (trayLeftX == 0 || rect.left < trayLeftX) {
                                        trayLeftX = (int)rect.left;
                                    }
                                }
                            }
                            pChild->Release();
                        }
                    }
                    pChildren->Release();
                }
                pCondition->Release();
            }
            pTaskbarElem->Release();
        }
        pAutomation->Release();
    }

    return trayLeftX;
}

static void RepositionWindow() {
    if (!g_hWnd || !IsWindow(g_hWnd)) return;

    HWND hTaskbar = FindWindowW(L"Shell_TrayWnd", NULL);
    if (!hTaskbar) return;

    if (GetParent(g_hWnd) != hTaskbar) {
        LONG_PTR curStyle = GetWindowLongPtrW(g_hWnd, GWL_STYLE);
        curStyle = (curStyle & ~WS_POPUP) | WS_CHILD | WS_CLIPSIBLINGS;
        SetWindowLongPtrW(g_hWnd, GWL_STYLE, curStyle);
        SetParent(g_hWnd, hTaskbar);
    }

    RECT taskbarRect;
    if (!GetWindowRect(hTaskbar, &taskbarRect)) return;

    float dpiScale = GetDpiScale(hTaskbar);
    int taskbarHeight = taskbarRect.bottom - taskbarRect.top;
    if (taskbarHeight <= 0) taskbarHeight = (int)(40.0f * dpiScale);

    // FluentFlyout Scaling: dynamically adjust widget height and width based on DPI and taskbar height
    g_widgetHeight = (int)(taskbarHeight * 0.88f);
    if (g_widgetHeight < (int)(34.0f * dpiScale)) g_widgetHeight = (int)(34.0f * dpiScale);

    g_widgetWidth = (int)(280.0f * dpiScale);

    int screenWidth = GetSystemMetrics(SM_CXSCREEN);
    int screenHeight = GetSystemMetrics(SM_CYSCREEN);

    int trayLeft = GetTrayLeftX();
    int screenX, screenY;

    int gap = (int)(8.0f * dpiScale);
    if (trayLeft > 400) {
        screenX = trayLeft - g_widgetWidth - gap;
    } else {
        screenX = screenWidth - g_widgetWidth - (int)(200.0f * dpiScale);
    }

    screenY = taskbarRect.bottom - g_widgetHeight - (int)(3.0f * dpiScale);
    if (taskbarRect.top <= 0 && taskbarRect.bottom < screenHeight / 2) {
        screenY = taskbarRect.top + (int)(3.0f * dpiScale);
    }

    // Convert screen coordinates to client coordinates of hTaskbar
    POINT pt = { screenX, screenY };
    ScreenToClient(hTaskbar, &pt);

    static int lastX = -999999, lastY = -999999, lastW = -1, lastH = -1;
    if (pt.x == lastX && pt.y == lastY && g_widgetWidth == lastW && g_widgetHeight == lastH) {
        return;
    }
    lastX = pt.x; lastY = pt.y; lastW = g_widgetWidth; lastH = g_widgetHeight;

    SetWindowPos(g_hWnd, HWND_TOP, pt.x, pt.y, g_widgetWidth, g_widgetHeight, SWP_NOACTIVATE | SWP_SHOWWINDOW);
    // SetWindowPos 後に UpdateLayeredWindow の内容がクリアされることがあるため、再描画する。
    RedrawWidget();
}

static void RedrawWidget() {
    if (!g_hWnd || !IsWindow(g_hWnd)) return;

    HDC hdcScreen = GetDC(NULL);
    HDC hdcMem = CreateCompatibleDC(hdcScreen);

    BITMAPINFO bmi = { 0 };
    bmi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    bmi.bmiHeader.biWidth = g_widgetWidth;
    bmi.bmiHeader.biHeight = -g_widgetHeight;
    bmi.bmiHeader.biPlanes = 1;
    bmi.bmiHeader.biBitCount = 32;
    bmi.bmiHeader.biCompression = BI_RGB;

    void* pBits = NULL;
    HBITMAP hBmp = CreateDIBSection(hdcScreen, &bmi, DIB_RGB_COLORS, &pBits, NULL, 0);
    HBITMAP hOldBmp = (HBITMAP)SelectObject(hdcMem, hBmp);

    g_renderer.Render(hdcMem, g_widgetWidth, g_widgetHeight, g_marqueeOffset, g_hoverTarget);

    BLENDFUNCTION blend = { 0 };
    blend.BlendOp = AC_SRC_OVER;
    blend.BlendFlags = 0;
    blend.SourceConstantAlpha = 255;
    blend.AlphaFormat = AC_SRC_ALPHA;

    SIZE sizeDst = { g_widgetWidth, g_widgetHeight };
    POINT ptSrc = { 0, 0 };

    UpdateLayeredWindow(g_hWnd, hdcScreen, NULL, &sizeDst, hdcMem, &ptSrc, 0, &blend, ULW_ALPHA);

    SelectObject(hdcMem, hOldBmp);
    DeleteObject(hBmp);
    DeleteDC(hdcMem);
    ReleaseDC(NULL, hdcScreen);
}

static void SendIpcControl(const std::string& action) {
    std::cout << "{\"event\":\"taskbar-control\",\"action\":\"" << action << "\"}" << std::endl;
}

static LRESULT CALLBACK WndProc(HWND hWnd, UINT msg, WPARAM wParam, LPARAM lParam) {
    switch (msg) {
    case 0x003D: // WM_GETOBJECT
    case 0x0018: // WM_SHOWWINDOW
    case 0x0046: // WM_WINDOWPOSCHANGING
    case 0x0083: // WM_NCCALCSIZE
    case 0x0281: // WM_IME_SETCONTEXT
    case 0x0282: // WM_IME_NOTIFY
        return 0;

    case WM_ERASEBKGND:
        return 1; // Prevent GDI background erase flicker

    case WM_PAINT: {
        PAINTSTRUCT ps;
        HDC hdc = BeginPaint(hWnd, &ps);
        EndPaint(hWnd, &ps);
        return 0;
    }
    }

    switch (msg) {
    case WM_CREATE:
        g_hWnd = hWnd;
        SetTimer(hWnd, TIMER_MARQUEE, 30, NULL);
        SetTimer(hWnd, TIMER_POSITION, 500, NULL);
        break;

    case WM_IPC_UPDATE: {
        std::lock_guard<std::mutex> lock(g_trackMutex);
        if (g_hasPendingTrack) {
            g_renderer.UpdateTrack(g_pendingTrack);
            g_hasPendingTrack = false;
            g_marqueeOffset = 0.0f;
        }
        if (g_hasPendingPlayback) {
            g_renderer.UpdatePlayback(g_pendingIsPlaying);
            g_hasPendingPlayback = false;
        }
        if (g_hasPendingColor) {
            g_renderer.UpdateColor(g_pendingColor);
            g_hasPendingColor = false;
        }
        RedrawWidget();
        break;
    }

    case WM_TIMER:
        if (wParam == TIMER_MARQUEE) {
            if (g_renderer.GetMarqueeTextWidth() > g_renderer.GetMarqueeViewportWidth()) {
                g_marqueeOffset += 0.8f;
                if (g_marqueeOffset > 100000.0f) g_marqueeOffset = 0.0f;
                RedrawWidget();
            }
        } else if (wParam == TIMER_POSITION) {
            RepositionWindow();
        }
        break;

    case WM_MOUSEMOVE: {
        int x = (int)(short)LOWORD(lParam);
        int y = (int)(short)HIWORD(lParam);

        if (!g_isMouseTracking) {
            TRACKMOUSEEVENT tme = { 0 };
            tme.cbSize = sizeof(TRACKMOUSEEVENT);
            tme.dwFlags = TME_LEAVE;
            tme.hwndTrack = hWnd;
            TrackMouseEvent(&tme);
            g_isMouseTracking = true;
        }

        WidgetHitTarget target = g_renderer.HitTest(x, y, g_widgetWidth, g_widgetHeight);
        if (target != g_hoverTarget) {
            g_hoverTarget = target;
            RedrawWidget();
        }
        break;
    }

    case WM_MOUSELEAVE:
        g_isMouseTracking = false;
        if (g_hoverTarget != WidgetHitTarget::None) {
            g_hoverTarget = WidgetHitTarget::None;
            RedrawWidget();
        }
        break;

    case WM_MOUSEWHEEL: {
        // ウィジェットホバー中のスクロールで音量を変更する (1ノッチ = 5%)
        // WHEEL_DELTA = 120 が1ノッチ分。上スクロール(+)で音量Up、下(-)でDown。
        int delta = GET_WHEEL_DELTA_WPARAM(wParam);
        if (delta > 0) {
            SendIpcControl("volume-up");
        } else if (delta < 0) {
            SendIpcControl("volume-down");
        }
        break;
    }

    case WM_LBUTTONDOWN: {
        int x = (int)(short)LOWORD(lParam);
        int y = (int)(short)HIWORD(lParam);
        WidgetHitTarget target = g_renderer.HitTest(x, y, g_widgetWidth, g_widgetHeight);
        if (target == WidgetHitTarget::Prev) {
            SendIpcControl("prev");
        } else if (target == WidgetHitTarget::PlayPause) {
            SendIpcControl("play-pause");
        } else if (target == WidgetHitTarget::Next) {
            SendIpcControl("next");
        } else if (target == WidgetHitTarget::Pill) {
            AllowSetForegroundWindow(ASFW_ANY);
            if (g_hMainWnd && IsWindow(g_hMainWnd)) {
                if (IsIconic(g_hMainWnd)) {
                    ShowWindow(g_hMainWnd, SW_RESTORE);
                }
                SetForegroundWindow(g_hMainWnd);
            }
            SendIpcControl("toggle-main-window");
        }
        break;
    }

    case WM_DESTROY:
        KillTimer(hWnd, TIMER_MARQUEE);
        KillTimer(hWnd, TIMER_POSITION);
        PostQuitMessage(0);
        break;

    default:
        return DefWindowProcW(hWnd, msg, wParam, lParam);
    }
    return 0;
}

static VOID CALLBACK WinEventProc(HWINEVENTHOOK hWinEventHook, DWORD event, HWND hwnd, LONG idObject, LONG idChild, DWORD dwEventThread, DWORD dwmsEventTime) {
    if (event == EVENT_OBJECT_LOCATIONCHANGE || event == EVENT_SYSTEM_FOREGROUND) {
        RepositionWindow();
    }
}

static void StdinIpcThread() {
    std::string line;
    while (g_running) {
        if (!std::getline(std::cin, line)) {
            if (!g_running) break;
            std::this_thread::sleep_for(std::chrono::milliseconds(50));
            std::cin.clear();
            continue;
        }
        if (line.empty()) continue;

        std::string cmd = ExtractJsonValue(line, "cmd");
        if (cmd == "set-main-hwnd") {
            std::string hwndStr = ExtractJsonValue(line, "hwnd");
            if (!hwndStr.empty()) {
                try {
                    g_hMainWnd = (HWND)(uintptr_t)std::stoull(hwndStr);
                } catch (...) {}
            }
        } else if (cmd == "update-track") {
            std::string title = ExtractJsonValue(line, "title");
            std::string artist = ExtractJsonValue(line, "artist");
            std::string picture = ExtractJsonValue(line, "picture");
            std::string isPlayingStr = ExtractJsonValue(line, "isPlaying");
            std::string color = ExtractJsonValue(line, "color"); // optional per-track color

            std::lock_guard<std::mutex> lock(g_trackMutex);
            g_pendingTrack.title = Utf8ToWstring(title);
            g_pendingTrack.artist = Utf8ToWstring(artist);
            g_pendingTrack.pictureBase64 = picture;
            g_pendingTrack.isPlaying = (isPlayingStr == "true");
            g_hasPendingTrack = true;
            // トラックが切り替わったら前の曲のアクセントカラーをリセットする。
            // "color" キーが付いていれば新しい色として適用、なければ空文字でリセット。
            g_pendingColor = color; // color が空文字なら ParseRGB が失敗して hasCustomColor=false になる
            g_hasPendingColor = true;

            if (g_hWnd) PostMessageW(g_hWnd, WM_IPC_UPDATE, 0, 0);
        } else if (cmd == "update-playback") {
            std::string isPlayingStr = ExtractJsonValue(line, "isPlaying");

            std::lock_guard<std::mutex> lock(g_trackMutex);
            g_pendingIsPlaying = (isPlayingStr == "true");
            g_hasPendingPlayback = true;

            if (g_hWnd) PostMessageW(g_hWnd, WM_IPC_UPDATE, 0, 0);
        } else if (cmd == "visualizer-color") {
            std::string color = ExtractJsonValue(line, "color");

            std::lock_guard<std::mutex> lock(g_trackMutex);
            g_pendingColor = color;
            g_hasPendingColor = true;

            if (g_hWnd) PostMessageW(g_hWnd, WM_IPC_UPDATE, 0, 0);
        } else if (cmd == "show") {
            if (g_hWnd) ShowWindow(g_hWnd, SW_SHOWNOACTIVATE);
        } else if (cmd == "hide") {
            if (g_hWnd) ShowWindow(g_hWnd, SW_HIDE);
        } else if (cmd == "quit") {
            g_running = false;
            if (g_hWnd) PostMessageW(g_hWnd, WM_CLOSE, 0, 0);
            break;
        }
    }
}

int main(int argc, char* argv[]) {
    CoInitializeEx(NULL, COINIT_APARTMENTTHREADED);

    HINSTANCE hInstance = GetModuleHandle(NULL);

    typedef BOOL(WINAPI* pfnSetDpiCtx)(HANDLE);
    HMODULE hUser32 = GetModuleHandleW(L"user32.dll");
    if (hUser32) {
        g_GetDpiForWindow = (pfnGetDpiForWindow)GetProcAddress(hUser32, "GetDpiForWindow");
        pfnSetDpiCtx SetDpiCtx = (pfnSetDpiCtx)GetProcAddress(hUser32, "SetProcessDpiAwarenessContext");
        if (SetDpiCtx) {
            SetDpiCtx((HANDLE)-4); // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
        }
    }

    WNDCLASSEXW wc = { 0 };
    wc.cbSize = sizeof(WNDCLASSEXW);
    wc.lpfnWndProc = WndProc;
    wc.hInstance = hInstance;
    wc.lpszClassName = L"FluentFlyoutTaskbarWidgetClass";
    wc.hCursor = LoadCursor(NULL, IDC_ARROW);

    RegisterClassExW(&wc);

    DWORD exStyle = WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_LAYERED;
    DWORD style = WS_POPUP | WS_VISIBLE;

    HWND hWnd = CreateWindowExW(
        exStyle,
        wc.lpszClassName,
        L"FluentFlyoutTaskbarWidget",
        style,
        0, 0, g_widgetWidth, g_widgetHeight,
        NULL, NULL, hInstance, NULL
    );

    if (!hWnd) {
        CoUninitialize();
        return 0;
    }
    g_hWnd = hWnd;

    RepositionWindow();
    RedrawWidget();

    g_hWinEventHook = SetWinEventHook(
        EVENT_SYSTEM_FOREGROUND,
        EVENT_OBJECT_LOCATIONCHANGE,
        NULL,
        WinEventProc,
        0, 0,
        WINEVENT_OUTOFCONTEXT
    );

    std::thread ipcThread(StdinIpcThread);

    MSG msg;
    while (GetMessageW(&msg, NULL, 0, 0)) {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }

    g_running = false;
    if (ipcThread.joinable()) {
        ipcThread.detach();
    }

    if (g_hWinEventHook) {
        UnhookWinEvent(g_hWinEventHook);
    }

    CoUninitialize();
    return (int)msg.wParam;
}
