// Test GetWindowRect on taskbar
const koffi = require('koffi');

const user32 = koffi.load('user32.dll');

const FindWindowW = user32.func('int64 __stdcall FindWindowW(char16* lpClassName, char16* lpWindowName)');

const RECT = koffi.struct('RECT', {
    left: 'int32', 
    top: 'int32', 
    right: 'int32', 
    bottom: 'int32'
});

const GetWindowRect = user32.func('bool __stdcall GetWindowRect(int64 hWnd, RECT *lpRect)');

console.log('=== GetWindowRect Test ===');

const hwnd = Number(FindWindowW('Shell_TrayWnd', 0));
console.log('Taskbar HWND:', hwnd);

if (!hwnd) {
    console.log('Taskbar not found');
    process.exit(1);
}

const rect = { left: 0, top: 0, right: 0, bottom: 0 };
const ok = Boolean(GetWindowRect(hwnd, rect));
console.log('GetWindowRect result:', ok);
console.log('Rect:', rect);
