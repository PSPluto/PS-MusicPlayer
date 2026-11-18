# Build script for TaskbarWidget.exe using MSVC 2022
# Includes SMTC (System Media Transport Controls) via C++/WinRT
$ErrorActionPreference = "Stop"

$vsPath   = "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"
$sdkVer   = "10.0.26100.0"
$sdkBase  = "C:\Program Files (x86)\Windows Kits\10"
$cppwinrt = "$sdkBase\Include\$sdkVer\cppwinrt"   # C++/WinRT headers (winrt/*.h)
$sdkUm    = "$sdkBase\Include\$sdkVer\um"          # SystemMediaTransportControlsInterop.h etc.

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

Write-Host "Building TaskbarWidget.exe (with SMTC) using MSVC 2022..." -ForegroundColor Green

$cmdBlock = @"
call "$vsPath"
cl.exe /std:c++17 /utf-8 /EHsc /O2 /W3 /nologo ^
  /I"$cppwinrt" /I"$sdkUm" ^
  /Fe:TaskbarWidget.exe ^
  main.cpp render.cpp smtc.cpp ^
  user32.lib gdi32.lib gdiplus.lib ole32.lib oleaut32.lib ^
  crypt32.lib uiautomationcore.lib ^
  WindowsApp.lib runtimeobject.lib
"@

$tempCmd = [System.IO.Path]::Combine($scriptDir, "build_temp.cmd")
Set-Content -Path $tempCmd -Value $cmdBlock -Encoding Ascii

try {
    $process = Start-Process -FilePath "cmd.exe" -ArgumentList "/c `"$tempCmd`"" -NoNewWindow -Wait -PassThru
    if ($process.ExitCode -eq 0) {
        Write-Host "TaskbarWidget.exe built successfully!" -ForegroundColor Green
    }
    else {
        Write-Error "Build failed with exit code $($process.ExitCode)"
    }
}
finally {
    if (Test-Path $tempCmd) { Remove-Item $tempCmd -Force }
}
