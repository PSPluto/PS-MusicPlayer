// Test if we can get the taskbar HWND and check its visibility
const koffi = require('koffi');

const user32 = koffi.load('user32.dll');

const FindWindowW = user32.func('int64 __stdcall FindWindowW(char16* lpClassName, char16* lpWindowName)');
const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(int64 hWnd)');

console.log('=== Taskbar HWND Test ===');

// Try finding taskbar multiple ways
const methods = [
  ['Shell_TrayWnd', null],
  ['Shell_TrayWnd', 0],
];

for (const [className, windowName] of methods) {
  try {
    const hwnd = Number(FindWindowW(className, windowName));
    console.log(`FindWindowW("${className}", ${windowName}) = ${hwnd}`);

    if (hwnd !== 0) {
      const visible = Boolean(IsWindowVisible(hwnd));
      console.log(`  -> IsWindowVisible(${hwnd}) = ${visible}`);
    }
  } catch (e) {
    console.log(`FindWindowW("${className}", ${windowName}) error: ${e.message}`);
  }
}
