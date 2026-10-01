# Build script for TaskbarWidget.exe using MSVC 2022
$ErrorActionPreference = "Stop"

$vsPath = "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Set-Location $scriptDir

Write-Host "Building TaskbarWidget.exe using MSVC 2022..." -ForegroundColor Green

$cmdBlock = @"
call "$vsPath"
cl.exe /std:c++17 /utf-8 /EHsc /O2 /W3 /nologo /Fe:TaskbarWidget.exe main.cpp render.cpp user32.lib gdi32.lib gdiplus.lib ole32.lib oleaut32.lib crypt32.lib uiautomationcore.lib
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
