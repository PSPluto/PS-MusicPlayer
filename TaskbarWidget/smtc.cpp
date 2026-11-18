// smtc.cpp  -  Windows System Media Transport Controls provider
//
// Uses ISystemMediaTransportControlsInterop (Win32 interop interface) to
// attach a SMTC session to a specific HWND without needing a full UWP
// MediaPlayer object.
//
// This file uses ONLY C++/WinRT (no WRL, no ABI:: namespaces).
// Include order: smtc.h (which pulls <windows.h> + winrt headers) first,
// then systemmediatransportcontrolsinterop.h.

#include "smtc.h"

// SMTC interop header (um/) - included AFTER smtc.h so <windows.h> is ready
#include <systemmediatransportcontrolsinterop.h>
#include <winstring.h>  // WindowsCreateString / WindowsDeleteString
#include <hstring.h>
#include <roapi.h>      // RoGetActivationFactory
#include <winrt/base.h> // winrt::com_ptr, winrt::guid_of, etc. (already in smtc.h via base)

#include <algorithm>

using namespace winrt;
using namespace winrt::Windows::Media;
using namespace winrt::Windows::Storage::Streams;
using namespace winrt::Windows::Foundation;

// ---------------------------------------------------------------------------
// Base64 decoding
// ---------------------------------------------------------------------------
static const int B64_TABLE[256] = {
    -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
    -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
    -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,62,-1,-1,-1,63,
    52,53,54,55,56,57,58,59,60,61,-1,-1,-1,-1,-1,-1,
    -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9,10,11,12,13,14,
    15,16,17,18,19,20,21,22,23,24,25,-1,-1,-1,-1,-1,
    -1,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,
    41,42,43,44,45,46,47,48,49,50,51,-1,-1,-1,-1,-1,
    -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
    -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
    -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
    -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
    -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
    -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
    -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
    -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
};

/*static*/ std::string SMTCProvider::StripDataUri(const std::string& uri) {
    auto pos = uri.find(',');
    if (pos != std::string::npos) return uri.substr(pos + 1);
    return uri;
}

/*static*/ std::vector<uint8_t> SMTCProvider::DecodeBase64(const std::string& b64) {
    std::vector<uint8_t> out;
    out.reserve(b64.size() * 3 / 4);
    int buf = 0, bits = 0;
    for (unsigned char c : b64) {
        int v = B64_TABLE[c];
        if (v < 0) continue;
        buf = (buf << 6) | v;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out.push_back(static_cast<uint8_t>((buf >> bits) & 0xFF));
        }
    }
    return out;
}

IRandomAccessStream SMTCProvider::Base64ToStream(const std::string& pictureBase64) {
    std::string pure = StripDataUri(pictureBase64);
    auto bytes = DecodeBase64(pure);
    if (bytes.empty()) return nullptr;

    InMemoryRandomAccessStream stream;
    DataWriter writer(stream);
    writer.WriteBytes(winrt::array_view<const uint8_t>(bytes.data(), (uint32_t)bytes.size()));
    writer.StoreAsync().get();
    writer.FlushAsync().get();
    stream.Seek(0);
    return stream;
}

// ---------------------------------------------------------------------------
// Init  -  Attach SMTC to a Win32 HWND via ISystemMediaTransportControlsInterop
// ---------------------------------------------------------------------------
bool SMTCProvider::Init(HWND hwnd) {
    if (m_initialized) return true;
    try {
        // Step 1: RoGetActivationFactory for SystemMediaTransportControls
        // Use raw HSTRING API (from hstring.h + roapi.h).
        winrt::com_ptr<ISystemMediaTransportControlsInterop> interop;
        {
            static const wchar_t kClsName[] =
                L"Windows.Media.SystemMediaTransportControls";
            HSTRING hClsName = nullptr;
            HRESULT hr = WindowsCreateString(
                kClsName, (UINT32)(sizeof(kClsName)/sizeof(wchar_t) - 1), &hClsName);
            if (FAILED(hr)) return false;

            // Get activation factory as IActivationFactory, then QI
            winrt::com_ptr<::IActivationFactory> factory;
            hr = RoGetActivationFactory(hClsName, winrt::guid_of<::IActivationFactory>(), factory.put_void());
            WindowsDeleteString(hClsName);
            if (FAILED(hr)) return false;

            hr = factory->QueryInterface(
                winrt::guid_of<ISystemMediaTransportControlsInterop>(),
                interop.put_void());
            if (FAILED(hr)) return false;
        }

        // Step 2: GetForWindow
        HWND targetHwnd = hwnd ? hwnd : ::GetForegroundWindow();
        if (!targetHwnd) targetHwnd = ::GetDesktopWindow();

        winrt::com_ptr<::IInspectable> raw;
        {
            HRESULT hr = interop->GetForWindow(
                targetHwnd,
                winrt::guid_of<SystemMediaTransportControls>(),
                raw.put_void());
            if (FAILED(hr)) return false;
        }

        m_controls = raw.as<SystemMediaTransportControls>();

        m_controls.IsEnabled(true);
        m_controls.IsPlayEnabled(true);
        m_controls.IsPauseEnabled(true);
        m_controls.IsNextEnabled(true);
        m_controls.IsPreviousEnabled(true);
        m_controls.IsStopEnabled(false);

        // Step 3: Button event handler
        m_buttonToken = m_controls.ButtonPressed(
            [this](SystemMediaTransportControls const&,
                   SystemMediaTransportControlsButtonPressedEventArgs const& args) {
                std::string action;
                switch (args.Button()) {
                    case SystemMediaTransportControlsButton::Play:     action = "play-pause"; break;
                    case SystemMediaTransportControlsButton::Pause:    action = "play-pause"; break;
                    case SystemMediaTransportControlsButton::Next:     action = "next";       break;
                    case SystemMediaTransportControlsButton::Previous: action = "prev";       break;
                    default: break;
                }
                if (!action.empty() && m_callback) {
                    m_callback(action);
                }
            });

        m_initialized = true;
        return true;
    }
    catch (...) {
        return false;
    }
}

void SMTCProvider::Shutdown() {
    if (!m_initialized) return;
    try {
        if (m_controls) {
            m_controls.ButtonPressed(m_buttonToken);
            m_controls.IsEnabled(false);
            m_controls = nullptr;
        }
    }
    catch (...) {}
    m_initialized = false;
}

// ---------------------------------------------------------------------------
// UpdateTrack
// ---------------------------------------------------------------------------
void SMTCProvider::UpdateTrack(const std::wstring& title,
                               const std::wstring& artist,
                               const std::wstring& album,
                               const std::wstring& albumArtist,
                               uint32_t            trackNumber,
                               uint32_t            albumTrackCount,
                               const std::wstring& genres,
                               const std::string&  pictureBase64,
                               double              durationSec) {
    if (!m_initialized || !m_controls) return;
    try {
        auto updater = m_controls.DisplayUpdater();
        updater.Type(MediaPlaybackType::Music);

        auto music = updater.MusicProperties();
        music.Title(title);
        music.Artist(artist);
        music.AlbumTitle(album);

        if (!albumArtist.empty()) {
            music.AlbumArtist(albumArtist);
        } else if (!artist.empty()) {
            music.AlbumArtist(artist);
        }

        if (trackNumber > 0) {
            music.TrackNumber(trackNumber);
        }
        if (albumTrackCount > 0) {
            music.AlbumTrackCount(albumTrackCount);
        }

        if (!genres.empty()) {
            try {
                auto glist = music.Genres();
                glist.Clear();
                std::wstring token;
                for (wchar_t c : genres) {
                    if (c == L',' || c == L';' || c == L'/') {
                        if (!token.empty()) {
                            size_t first = token.find_first_not_of(L" \t");
                            size_t last = token.find_last_not_of(L" \t");
                            if (first != std::wstring::npos && last != std::wstring::npos) {
                                glist.Append(token.substr(first, last - first + 1));
                            }
                            token.clear();
                        }
                    } else {
                        token += c;
                    }
                }
                if (!token.empty()) {
                    size_t first = token.find_first_not_of(L" \t");
                    size_t last = token.find_last_not_of(L" \t");
                    if (first != std::wstring::npos && last != std::wstring::npos) {
                        glist.Append(token.substr(first, last - first + 1));
                    }
                }
            } catch (...) {}
        }

        // Thumbnail
        if (!pictureBase64.empty()) {
            try {
                auto stream = Base64ToStream(pictureBase64);
                if (stream) {
                    updater.Thumbnail(RandomAccessStreamReference::CreateFromStream(stream));
                }
            }
            catch (...) { /* thumbnail failure is non-fatal */ }
        } else {
            updater.Thumbnail(nullptr);
        }

        updater.Update();

        // Timeline (duration / position)
        if (durationSec > 0.0) {
            UpdatePosition(0.0, durationSec);
        }
    }
    catch (...) {}
}

// ---------------------------------------------------------------------------
// UpdatePosition
// ---------------------------------------------------------------------------
void SMTCProvider::UpdatePosition(double positionSec, double durationSec) {
    if (!m_initialized || !m_controls || durationSec <= 0.0) return;
    try {
        SystemMediaTransportControlsTimelineProperties tl;
        auto toTicks = [](double sec) -> TimeSpan {
            return TimeSpan{ static_cast<int64_t>(sec * 10'000'000LL) };
        };
        tl.StartTime(toTicks(0.0));
        tl.MinSeekTime(toTicks(0.0));
        tl.Position(toTicks(positionSec));
        tl.MaxSeekTime(toTicks(durationSec));
        tl.EndTime(toTicks(durationSec));
        m_controls.UpdateTimelineProperties(tl);
    }
    catch (...) {}
}

// ---------------------------------------------------------------------------
// UpdatePlayback
// ---------------------------------------------------------------------------
void SMTCProvider::UpdatePlayback(bool isPlaying) {
    if (!m_initialized || !m_controls) return;
    try {
        m_controls.PlaybackStatus(isPlaying
            ? MediaPlaybackStatus::Playing
            : MediaPlaybackStatus::Paused);
    }
    catch (...) {}
}
