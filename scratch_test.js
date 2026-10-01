// Try SHAppBarMessage ABM_GETSTATE directly without needing taskbar HWND
const koffi = require('koffi');

const shell32 = koffi.load('shell32.dll');
const user32 = koffi.load('user32.dll');

const RECT = koffi.struct('RECT', {
    left: 'int32', top: 'int32', right: 'int32', bottom: 'int32'
});

const APPBARDATA = koffi.struct('APPBARDATA', {
    cbSize: 'uint32',
    hWnd: 'int64',
    uCallbackMessage: 'uint32',
    uEdge: 'uint32',
    rc: RECT,
    lParam: 'int64'
});

const SHAppBarMessage = shell32.func('uint64 __stdcall SHAppBarMessage(uint32 dwMessage, APPBARDATA *pData)');
const FindWindowW = user32.func('int64 __stdcall FindWindowW(char16* lpClassName, char16* lpWindowName)');
const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(int64 hWnd)');

const taskbarHwnd = Number(FindWindowW('Shell_TrayWnd', 0));
console.log('Taskbar HWND:', taskbarHwnd);

if (!taskbarHwnd) {
    console.log('Taskbar not found');
    process.exit(0);
}

console.log('Taskbar visible:', Boolean(IsWindowVisible(taskbarHwnd)));

// ABM_GETSTATE = 4
// ABS_AUTOHIDE = 0x0001
// ABS_ALWAYSONTOP = 0x0002
const data = {
    cbSize: koffi.sizeof(APPBARDATA),
    hWnd: taskbarHwnd,
    uCallbackMessage: 0,
    uEdge: 0,
    rc: { left: 0, top: 0, right: 0, bottom: 0 },
    lParam: 0
};

const state = SHAppBarMessage(4, data);
console.log('ABM_GETSTATE result:', state.toString());
console.log('Auto-hide:', (Number(state) & 0x1) !== 0);
console.log('AlwaysOnTop:', (Number(state) & 0x2) !== 0);
