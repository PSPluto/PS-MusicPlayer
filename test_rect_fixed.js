const koffi = require('koffi');

const user32 = koffi.load('user32.dll');

const _RECT = koffi.struct('RECT_test', {
  left: 'int32',
  top: 'int32',
  right: 'int32',
  bottom: 'int32'
});

const FindWindowW = user32.func('int64 __stdcall FindWindowW(char16* lpClassName, char16* lpWindowName)');
const GetWindowRect = user32.func('bool __stdcall GetWindowRect(int64 hWnd, RECT_test *lpRect)');

const hwnd = Number(FindWindowW('Shell_TrayWnd', 0));
console.log('Taskbar HWND:', hwnd);

if (hwnd) {
  // Allocate buffer for RECT struct
  const buffer = koffi.alloc(_RECT, 1);
  
  const result = Boolean(GetWindowRect(hwnd, buffer));
  console.log('GetWindowRect result:', result);
  
  // Read the struct from buffer
  const rect = buffer[0];
  console.log('Rect values:', rect);
  
  const height = rect.bottom - rect.top;
  const width = rect.right - rect.left;
  console.log('Taskbar height:', height);
  console.log('Taskbar width:', width);
  console.log('Taskbar visible:', height >= 10 && width >= 10);
}
