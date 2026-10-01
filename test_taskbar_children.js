// Windows 11 タスクバーの子ウィンドウ構造を調べるテスト
// npm start の代わりに: npx electron test_taskbar_children.js で実行

const { app, BrowserWindow } = require('electron');
const koffi = require('koffi');

app.whenReady().then(() => {
  // DPI context を正しく設定するためにウィンドウを1つ作る
  const win = new BrowserWindow({ width: 100, height: 100, show: false });
  win.loadURL('about:blank');

  setTimeout(() => {
    const user32 = koffi.load('user32.dll');

    const RECT = koffi.struct('RECT_ch', {
      left: 'int32', top: 'int32', right: 'int32', bottom: 'int32'
    });

    const FindWindowW    = user32.func('int64 __stdcall FindWindowW(char16* lpClassName, char16* lpWindowName)');
    const FindWindowExW  = user32.func('int64 __stdcall FindWindowExW(int64 hWndParent, int64 hWndChildAfter, char16* lpszClass, char16* lpszWindow)');
    const GetWindowRect  = user32.func('bool __stdcall GetWindowRect(int64 hWnd, _Out_ RECT_ch *lpRect)');
    const GetClassNameW  = user32.func('int __stdcall GetClassNameW(int64 hWnd, char16* lpClassName, int nMaxCount)');
    const GetSystemMetrics = user32.func('int __stdcall GetSystemMetrics(int nIndex)');
    const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(int64 hWnd)');

    console.log(`GetSystemMetrics screen: ${GetSystemMetrics(0)} x ${GetSystemMetrics(1)}`);

    function getRect(hwnd) {
      const r = { left: 0, top: 0, right: 0, bottom: 0 };
      GetWindowRect(hwnd, r);
      return r;
    }

    function getClass(hwnd) {
      const buf = Buffer.alloc(512);
      const len = GetClassNameW(hwnd, buf, 256);
      return buf.toString('utf16le', 0, len * 2).replace(/\0/g, '');
    }

    function enumChildren(parentHwnd, depth = 0) {
      const indent = '  '.repeat(depth);
      let child = Number(FindWindowExW(parentHwnd, 0, null, null));
      while (child !== 0) {
        try {
          const cls = getClass(child);
          const r = getRect(child);
          const vis = Boolean(IsWindowVisible(child));
          console.log(`${indent}[${child}] ${cls}  rect=[${r.left},${r.top},${r.right},${r.bottom}]  visible=${vis}`);
          
          // 主要な子は再帰
          if (depth < 3 && ['TrayNotifyWnd', 'ReBarWindow32', 'MSTaskSwWClass', 'SysPager', 'ToolbarWindow32'].includes(cls)) {
            enumChildren(child, depth + 1);
          }
        } catch(e) {}
        
        child = Number(FindWindowExW(parentHwnd, child, null, null));
      }
    }

    const trayWnd = Number(FindWindowW('Shell_TrayWnd', null));
    console.log(`\n=== Shell_TrayWnd: ${trayWnd} ===`);
    if (trayWnd) {
      const r = getRect(trayWnd);
      console.log(`rect=[${r.left},${r.top},${r.right},${r.bottom}]`);
      console.log('\nChildren:');
      enumChildren(trayWnd, 1);
    }

    setTimeout(() => { app.quit(); }, 200);
  }, 1000);
});
