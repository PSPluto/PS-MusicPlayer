// Test: TrayNotifyWnd の rect を取得して、システムトレイ領域の位置を確認する
const koffi = require('koffi');

const user32 = koffi.load('user32.dll');

const RECT = koffi.struct('RECT', {
  left: 'int32', top: 'int32', right: 'int32', bottom: 'int32'
});

const FindWindowW    = user32.func('int64 __stdcall FindWindowW(char16* lpClassName, char16* lpWindowName)');
const FindWindowExW  = user32.func('int64 __stdcall FindWindowExW(int64 hWndParent, int64 hWndChildAfter, char16* lpszClass, char16* lpszWindow)');
const GetWindowRect  = user32.func('bool __stdcall GetWindowRect(int64 hWnd, _Out_ RECT *lpRect)');
const GetSystemMetrics = user32.func('int __stdcall GetSystemMetrics(int nIndex)');

const screenW = GetSystemMetrics(0);
const screenH = GetSystemMetrics(1);
console.log(`Screen: ${screenW} x ${screenH}`);

// Shell_TrayWnd → TrayNotifyWnd
const trayWnd = Number(FindWindowW('Shell_TrayWnd', 0));
console.log(`Shell_TrayWnd HWND: ${trayWnd}`);

if (trayWnd) {
  const trayRect = { left: 0, top: 0, right: 0, bottom: 0 };
  GetWindowRect(trayWnd, trayRect);
  console.log('Shell_TrayWnd rect:', JSON.stringify(trayRect));

  const notifyWnd = Number(FindWindowExW(trayWnd, 0, 'TrayNotifyWnd', 0));
  console.log(`TrayNotifyWnd HWND: ${notifyWnd}`);

  if (notifyWnd) {
    const notifyRect = { left: 0, top: 0, right: 0, bottom: 0 };
    GetWindowRect(notifyWnd, notifyRect);
    console.log('TrayNotifyWnd rect:', JSON.stringify(notifyRect));
    console.log(`TrayNotifyWnd width: ${notifyRect.right - notifyRect.left}`);
    console.log(`TrayNotifyWnd height: ${notifyRect.bottom - notifyRect.top}`);
    console.log(`  -> left edge (= widget should be placed left of this): ${notifyRect.left}`);

    // SysPager
    const sysPager = Number(FindWindowExW(notifyWnd, 0, 'SysPager', 0));
    console.log(`SysPager HWND: ${sysPager}`);
    if (sysPager) {
      const spRect = { left: 0, top: 0, right: 0, bottom: 0 };
      GetWindowRect(sysPager, spRect);
      console.log('SysPager rect:', JSON.stringify(spRect));

      const toolbar = Number(FindWindowExW(sysPager, 0, 'ToolbarWindow32', 0));
      console.log(`ToolbarWindow32 HWND: ${toolbar}`);
      if (toolbar) {
        const tbRect = { left: 0, top: 0, right: 0, bottom: 0 };
        GetWindowRect(toolbar, tbRect);
        console.log('ToolbarWindow32 rect:', JSON.stringify(tbRect));
        
        // TB_BUTTONCOUNT
        const SendMessageW = user32.func('int64 __stdcall SendMessageW(int64 hWnd, uint32 Msg, int64 wParam, int64 lParam)');
        const TB_BUTTONCOUNT = 0x0418;
        const count = Number(SendMessageW(toolbar, TB_BUTTONCOUNT, 0, 0));
        console.log(`TB_BUTTONCOUNT: ${count}`);
      }
    }
  }
}
