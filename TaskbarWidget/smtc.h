#pragma once
#ifndef SMTC_H
#define SMTC_H

// <windows.h> MUST come first so HWND is defined before C++/WinRT headers
#include <windows.h>

// C++/WinRT headers
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.Media.h>
#include <winrt/Windows.Storage.Streams.h>

// Standard library
#include <functional>
#include <string>
#include <vector>

// -----------------------------------------------------------------------
//  SMTCProvider  -  Windows System Media Transport Controls provider
//
//  Usage:
//    SMTCProvider smtc;
//    smtc.Init(hwnd);   // pass any HWND belonging to this process
//    smtc.UpdateTrack(title, artist, album, pictureBase64, durationSec);
//    smtc.UpdatePlayback(isPlaying);
//    smtc.SetButtonCallback([](const std::string& action){ ... });
// -----------------------------------------------------------------------

class SMTCProvider {
public:
    using ButtonCallback = std::function<void(const std::string& action)>;

    SMTCProvider()  = default;
    ~SMTCProvider() { Shutdown(); }

    // Must be called once on the COM-initialized thread.
    // hwnd: any HWND belonging to this process (used to attach SMTC session).
    bool Init(HWND hwnd = nullptr);
    void Shutdown();

    // Call whenever the track changes with all available metadata.
    void UpdateTrack(const std::wstring& title,
                     const std::wstring& artist,
                     const std::wstring& album,
                     const std::wstring& albumArtist,
                     uint32_t            trackNumber,
                     uint32_t            albumTrackCount,
                     const std::wstring& genres,
                     const std::string&  pictureBase64,
                     double              durationSec);

    // Call when playback position (timeline) changes.
    void UpdatePosition(double positionSec, double durationSec);

    // Call when play/pause state changes.
    void UpdatePlayback(bool isPlaying);

    // Register a callback to receive button presses from the system overlay.
    // action: "play-pause", "next", "prev"
    void SetButtonCallback(ButtonCallback cb) { m_callback = std::move(cb); }

private:
    bool m_initialized = false;
    ButtonCallback m_callback;

    winrt::Windows::Media::SystemMediaTransportControls m_controls{ nullptr };
    winrt::event_token m_buttonToken{};

    static std::string   StripDataUri(const std::string& dataUri);
    static std::vector<uint8_t> DecodeBase64(const std::string& b64);
    winrt::Windows::Storage::Streams::IRandomAccessStream
        Base64ToStream(const std::string& pictureBase64);
};

#endif // SMTC_H
