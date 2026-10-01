const { app, BrowserWindow, ipcMain, screen, dialog, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execFile, execFileSync } = require('child_process');
const mm = require('music-metadata');

// Win32 API via koffi for reading taskbar auto-hide and visibility state
let koffi = null;
let _koffiReady = false;
let _SHAppBarMessage = null;
let _APPBARDATA = null;
let _GetDesktopWindow = null;
let _FindWindow = null;
let _FindWindowEx = null;
let _IsWindowVisible = null;
let _GetWindowRect = null;
let _RECT = null;
let _rectBuffer = null;
let _GetSystemMetrics = null;
let isWidgetVisible = false;
let WinEventProc = null;
let _SetWinEventHook = null;
const EVENT_OBJECT_LOCATIONCHANGE = 0x800B;
const WINEVENT_OUTOFCONTEXT = 0x0000;

let user32 = null;
const SetWindowPos = null;


let _SetWindowPos = null;
let _GetWindowLongPtr = null;
let _SetWindowLongPtr = null;
let _SetWindowBand = null;

const HWND_TOPMOST = -1;
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOACTIVATE = 0x0010;
const SWP_FRAMECHANGED = 0x0020;

const GWL_EXSTYLE = -20;
const WS_EX_TOOLWINDOW = 0x00000080;
const WS_EX_TOPMOST = 0x00000008;
const WS_EX_NOACTIVATE = 0x08000000; // フォーカスを奪わずに最前面化

const ZBID_UIACCESS = 2;
const ZBID_SYSTEM_TOOLS = 11;
const ZBID_POPUPS = 14;

try {
  koffi = require('koffi');
  const shell32 = koffi.load('shell32.dll');
  user32 = koffi.load('user32.dll');

  WinEventProc = koffi.proto('void __stdcall WinEventProc(int64 hWinEventHook, uint32 event, int64 hwnd, int32 idObject, int32 idChild, uint32 dwEventThread, uint32 dwmsEventTime)');
  _SetWinEventHook = user32.func('int64 __stdcall SetWinEventHook(uint32 eventMin, uint32 eventMax, int64 hmodWinEventProc, WinEventProc *pfnWinEventProc, uint32 idProcess, uint32 idThread, uint32 dwFlags)');
  _SetWindowPos = user32.func('bool __stdcall SetWindowPos(int64 hWnd, int64 hWndInsertAfter, int x, int y, int cx, int cy, uint32 uFlags)');

  try {
    _SetWindowBand = user32.func('bool __stdcall SetWindowBand(int64 hWnd, int64 hwndInsertAfter, uint32 dwBand)');
  } catch (e) { }

  try {
    _GetWindowLongPtr = user32.func('int64 __stdcall GetWindowLongPtrW(int64 hWnd, int nIndex)');
    _SetWindowLongPtr = user32.func('int64 __stdcall SetWindowLongPtrW(int64 hWnd, int nIndex, int64 dwNewLong)');
  } catch (e) {
    try {
      _GetWindowLongPtr = user32.func('int32 __stdcall GetWindowLongW(int64 hWnd, int nIndex)');
      _SetWindowLongPtr = user32.func('int32 __stdcall SetWindowLongW(int64 hWnd, int nIndex, int32 dwNewLong)');
    } catch (e2) { }
  }

  _RECT = koffi.struct('RECT_tb', {
    left: 'int32', top: 'int32', right: 'int32', bottom: 'int32'
  });
  // new _RECT() はやめて、毎回プレーンオブジェクトを作る
  _APPBARDATA = koffi.struct('APPBARDATA_tb', {
    cbSize: 'uint32',
    hWnd: 'int64',
    uCallbackMessage: 'uint32',
    uEdge: 'uint32',
    rc: _RECT,
    lParam: 'int64'
  });

  _SHAppBarMessage = shell32.func('uint64 __stdcall SHAppBarMessage(uint32 dwMessage, APPBARDATA_tb *pData)');
  _GetDesktopWindow = user32.func('int64 __stdcall GetDesktopWindow()');
  _FindWindow = user32.func('int64 __stdcall FindWindowW(char16* lpClassName, char16* lpWindowName)');
  _FindWindowEx = user32.func('int64 __stdcall FindWindowExW(int64 hWndParent, int64 hWndChildAfter, char16* lpszClass, char16* lpszWindow)');
  _IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(int64 hWnd)');
  _GetSystemMetrics = user32.func('int __stdcall GetSystemMetrics(int nIndex)');

  // _Out_ を付けて出力パラメータとして宣言する
  _GetWindowRect = user32.func('bool __stdcall GetWindowRect(int64 hWnd, _Out_ RECT_tb *lpRect)');

  _koffiReady = true;
  console.log('[koffi] Win32 APIs loaded successfully');
} catch (e) {
  console.warn('[koffi] Failed to load Win32 APIs, falling back to workArea heuristic:', e.message);
}

function forceTopmost(window) {
  if (!_koffiReady || !_SetWindowPos || !window || window.isDestroyed()) return;
  try {
    const hwnd = window.getNativeWindowHandle().readBigInt64LE(0);

    // uiAccess="true" 特権を持つ TrayLocator.exe 経由で HWND の Z-Order Band を ZBID_UIACCESS (スタートメニューの上) へ昇格
    try {
      if (fs.existsSync(trayLocatorExePath)) {
        execFile(trayLocatorExePath, [hwnd.toString()]);
      }
    } catch (e) { }

    // Windows 8/10/11 の非公開 API SetWindowBand で ZBID_POPUPS (14) または ZBID_UIACCESS (2) に限定設定
    if (_SetWindowBand) {
      try {
        _SetWindowBand(hwnd, HWND_TOPMOST, ZBID_POPUPS);
      } catch (e1) {
        try { _SetWindowBand(hwnd, HWND_TOPMOST, ZBID_UIACCESS); } catch (e2) { }
      }
    }

    // WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_EX_NOACTIVATE を拡張スタイルに強制追加
    if (_GetWindowLongPtr && _SetWindowLongPtr) {
      const exStyle = Number(_GetWindowLongPtr(hwnd, GWL_EXSTYLE));
      const newExStyle = exStyle | WS_EX_TOOLWINDOW | WS_EX_TOPMOST | WS_EX_NOACTIVATE;
      _SetWindowLongPtr(hwnd, GWL_EXSTYLE, newExStyle);
    }

    // Electron API の表示レベルも 'screen-saver' を指定
    if (typeof window.setAlwaysOnTop === 'function') {
      window.setAlwaysOnTop(true, 'screen-saver');
    }

    // SWP_FRAMECHANGED と共に SetWindowPos で反映
    _SetWindowPos(
      hwnd,
      HWND_TOPMOST,
      0, 0, 0, 0,
      SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_FRAMECHANGED
    );
  } catch (e) {
    console.error('[forceTopmost] error:', e.message);
  }
}

function getTaskbarHwnd() {
  if (!_koffiReady || !_FindWindow) {
    return 0;
  }

  try {
    // char16* 型の null は null で渡す (0 は不可)
    return Number(_FindWindow('Shell_TrayWnd', null));
  } catch (e) {
    return 0;
  }
}

function isTaskbarAutoHide() {
  if (!_koffiReady || !_SHAppBarMessage || !_APPBARDATA) {
    const { bounds, workArea } = screen.getPrimaryDisplay();
    return (bounds.height - workArea.height) <= 10;
  }

  try {
    const hwnd = getTaskbarHwnd();
    if (!hwnd) {
      return false;
    }

    const data = {
      cbSize: koffi.sizeof(_APPBARDATA),
      hWnd: hwnd,
      uCallbackMessage: 0,
      uEdge: 0,
      rc: { left: 0, top: 0, right: 0, bottom: 0 },
      lParam: 0
    };
    const state = Number(_SHAppBarMessage(4, data)); // ABM_GETSTATE = 4
    return (state & 0x1) !== 0; // ABS_AUTOHIDE = 0x0001
  } catch (e) {
    const { bounds, workArea } = screen.getPrimaryDisplay();
    return (bounds.height - workArea.height) <= 10;
  }
}

function getTaskbarRect() {
  if (!_koffiReady || !_FindWindow || !_GetWindowRect) {
    return null;
  }

  try {
    const hwnd = getTaskbarHwnd();
    if (!hwnd) {
      return null;
    }

    // プレーンオブジェクトを毎回新規作成して渡す
    const rect = { left: 0, top: 0, right: 0, bottom: 0 };
    const ok = Boolean(_GetWindowRect(hwnd, rect));
    if (!ok) {
      return null;
    }

    return rect; // _Out_ 指定により、koffiが自動で値を書き戻してくれる
  } catch (e) {
    console.error('[taskbar] getTaskbarRect error:', e.message);
    return null;
  }
}

const trayLocatorExePath = path.join(__dirname, 'TrayLocator', 'bin', 'Release', 'net10.0-windows', 'TrayLocator.exe');

let lastTaskbarX = null;
let lastTaskbarY = null;
let lastUiaFetchTime = 0;
let cachedUiaLeftX = null;

// UI Automation (TrayLocator.exe) 経由でトレイの最左端 X 座標 (物理ピクセル) を取得
function getTrayLeftXFromUIA() {
  const now = Date.now();
  // 150ms の高速応答でトレイ連打・伸縮時にも即座に追従
  if (now - lastUiaFetchTime < 150 && cachedUiaLeftX !== null) {
    return cachedUiaLeftX;
  }
  try {
    if (fs.existsSync(trayLocatorExePath)) {
      const output = execFileSync(trayLocatorExePath, { timeout: 300, encoding: 'utf8' }).trim();
      const val = parseInt(output, 10);
      if (!isNaN(val) && val > 300) {
        cachedUiaLeftX = val;
        lastUiaFetchTime = now;
        return val;
      }
    }
  } catch (e) {
    // ignore
  }
  return cachedUiaLeftX;
}

// システムトレイ(TrayNotifyWnd)のrectを返す。
// 取得できた場合: { left, top, right, bottom } (物理ピクセル)
// 取得できない場合: null
function getTrayNotifyRect() {
  if (!_koffiReady || !_FindWindow || !_FindWindowEx || !_GetWindowRect) {
    return null;
  }

  try {
    const trayHwnd = getTaskbarHwnd();
    if (!trayHwnd) return null;

    const notifyHwnd = Number(_FindWindowEx(trayHwnd, 0, 'TrayNotifyWnd', null));
    if (!notifyHwnd) return null;

    const rect = { left: 0, top: 0, right: 0, bottom: 0 };
    const ok = Boolean(_GetWindowRect(notifyHwnd, rect));
    if (!ok) return null;

    return rect;
  } catch (e) {
    console.error('[taskbar] getTrayNotifyRect error:', e.message);
    return null;
  }
}

function isTaskbarVisible() {
  const SM_CXSCREEN = 0;
  const SM_CYSCREEN = 1;

  if (!_koffiReady || !_GetWindowRect || !_GetSystemMetrics) {
    return true; // Assume visible if koffi not ready
  }

  try {
    const rect = getTaskbarRect();
    if (!rect) {
      return true;
    }

    const screenW = _GetSystemMetrics(SM_CXSCREEN);
    const screenH = _GetSystemMetrics(SM_CYSCREEN);

    // モニター表示領域 (0,0,screenW,screenH) とタスクバーrectの重なりを計算
    const overlapW = Math.min(rect.right, screenW) - Math.max(rect.left, 0);
    const overlapH = Math.min(rect.bottom, screenH) - Math.max(rect.top, 0);

    const rectW = rect.right - rect.left;
    const rectH = rect.bottom - rect.top;

    // タスクバーの向き（横長=下/上固定、縦長=左/右固定）を判定し、
    // 画面内にどれだけ「厚み」が残っているかを見る
    const isHorizontal = rectW >= rectH;
    const visibleThickness = isHorizontal ? overlapH : overlapW;

    const HIDDEN_THRESHOLD = 10; // 画面内に残っている厚みが10px未満なら隠れている
    const isHidden = visibleThickness < HIDDEN_THRESHOLD;

    return !isHidden;
  } catch (e) {
    console.error('[taskbar] isTaskbarVisible error:', e.message);
    return true;
  }
}

let mainWindow;
let visualizerWindow;
let taskbarProcess = null;
let tray = null;
let savedWindowHeight = 210;
let contextMenuExpanded = false;
let contextMenuExpandedWidth = 380;
let contextMenuExpandedHeight = 210;
let lastVisualizerColor = 'rgb(20, 20, 20)';
let currentTrackData = null;
let autoHideTimer = null;

const MENU_GAP = 8;
const SHADOW_BLEED = 8; // matches island box-shadow blur radius

function createWindow() {
  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;

  mainWindow = new BrowserWindow({
    width: 380,
    height: 210,
    minWidth: 380,
    maxWidth: 380,
    minHeight: 210,
    maxHeight: 210,
    x: screenWidth - 400,
    y: screenHeight - 250,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: false,
    resizable: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  if (taskbarProcess) {
    try {
      const handleBuf = mainWindow.getNativeWindowHandle();
      const hwndVal = handleBuf.length >= 8 ? handleBuf.readBigInt64LE(0).toString() : handleBuf.readInt32LE(0).toString();
      sendToTaskbarWidget({ cmd: 'set-main-hwnd', hwnd: hwndVal });
    } catch (err) {}
  }

  // Hide to tray instead of closing/minimizing
  mainWindow.on('minimize', (e) => {
    e.preventDefault();
    if (mainWindow) mainWindow.hide();
    if (visualizerWindow) visualizerWindow.hide();
  });

  mainWindow.on('close', (e) => {
    if (!app.isQuiting) {
      e.preventDefault();
      if (mainWindow) mainWindow.hide();
      if (visualizerWindow) visualizerWindow.hide();
    }
  });
  // mainWindow.webContents.openDevTools({ mode: 'detach' });
  mainWindow.on('closed', () => {
    mainWindow = null;
    // If visualizer exists, close it when main window is closed
    if (visualizerWindow && !visualizerWindow.isDestroyed()) {
      try { visualizerWindow.close(); } catch (e) { visualizerWindow = null; }
      visualizerWindow = null;
    }
    // If taskbar widget process exists, close it when main window is closed
    if (taskbarProcess) {
      sendToTaskbarWidget({ cmd: 'quit' });
      taskbarProcess = null;
    }
    if (autoHideTimer) {
      clearInterval(autoHideTimer);
      autoHideTimer = null;
    }
  });
}

function createVisualizerWindow() {
  if (visualizerWindow && !visualizerWindow.isDestroyed()) {
    return visualizerWindow;
  }

  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;

  visualizerWindow = new BrowserWindow({
    width: 220,
    height: 120,
    // 位置
    x: 40,
    y: screenHeight - 200,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    alwaysOnTop: true,
    resizable: true,
    movable: true,
    minWidth: 220,
    minHeight: 120,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
    show: false,
  });

  visualizerWindow.loadFile(path.join(__dirname, 'visualizer.html'));
  visualizerWindow.setMenuBarVisibility(false);
  visualizerWindow.setAlwaysOnTop(true, 'screen-saver');

  visualizerWindow.webContents.on('did-finish-load', () => {
    if (lastVisualizerColor) {
      visualizerWindow.webContents.send('visualizer-color', lastVisualizerColor);
    }
    if (visualizerWindow && !visualizerWindow.isDestroyed() && visualizerWindow.isVisible()) {
      visualizerWindow.show();
      visualizerWindow.focus();
    }
  });

  visualizerWindow.on('closed', () => {
    visualizerWindow = null;
  });
  return visualizerWindow;
}

function spawnTaskbarWidget() {
  const exePath = path.join(__dirname, 'TaskbarWidget', 'TaskbarWidget.exe');
  if (!fs.existsSync(exePath)) {
    console.warn('[TaskbarWidget] Native binary not found at:', exePath);
    return;
  }

  try {
    taskbarProcess = spawn(exePath, [], {
      stdio: ['pipe', 'pipe', 'inherit'],
      windowsHide: false
    });

    let stdoutBuffer = '';
    taskbarProcess.stdout.on('data', (data) => {
      stdoutBuffer += data.toString('utf8');
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line.trim());
          if (msg.event === 'taskbar-control') {
            handleTaskbarControl(msg.action);
          }
        } catch (e) {}
      }
    });

    taskbarProcess.on('exit', (code) => {
      console.log('[TaskbarWidget] Process exited with code:', code);
      taskbarProcess = null;
    });

    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        const handleBuf = mainWindow.getNativeWindowHandle();
        const hwndVal = handleBuf.length >= 8 ? handleBuf.readBigInt64LE(0).toString() : handleBuf.readInt32LE(0).toString();
        sendToTaskbarWidget({
          cmd: 'set-main-hwnd',
          hwnd: hwndVal
        });
      } catch (err) {}
    }

    if (currentTrackData) {
      sendToTaskbarWidget({
        cmd: 'update-track',
        title: currentTrackData.title || '',
        artist: currentTrackData.artist || '',
        picture: currentTrackData.picture || '',
        isPlaying: !!currentTrackData.isPlaying
      });
    }
    if (lastVisualizerColor) {
      sendToTaskbarWidget({
        cmd: 'visualizer-color',
        color: lastVisualizerColor
      });
    }
  } catch (e) {
    console.error('[TaskbarWidget] Spawn error:', e);
  }
}

function sendToTaskbarWidget(obj) {
  if (taskbarProcess && taskbarProcess.stdin && !taskbarProcess.stdin.destroyed) {
    try {
      taskbarProcess.stdin.write(JSON.stringify(obj) + '\n');
    } catch (e) {
      console.error('[TaskbarWidget] Stdin write error:', e);
    }
  }
}

function bringMainWindowToFront() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.setAlwaysOnTop(true);
  mainWindow.focus();
  mainWindow.moveTop();
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setAlwaysOnTop(false);
    }
  }, 120);
}

function handleTaskbarControl(action) {
  if (action === 'toggle-main-window') {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isVisible() && mainWindow.isFocused()) {
        mainWindow.hide();
        if (visualizerWindow && !visualizerWindow.isDestroyed()) {
          visualizerWindow.hide();
        }
      } else {
        bringMainWindowToFront();
        if (visualizerWindow && !visualizerWindow.isDestroyed() && visualizerWindow.isVisible()) {
          visualizerWindow.show();
        }
      }
    } else {
      createWindow();
    }
  } else {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('taskbar-control', action);
    }
  }
}

function toggleVisualizerWindow() {
  if (!visualizerWindow || visualizerWindow.isDestroyed()) {
    createVisualizerWindow();
  }

  if (visualizerWindow.isVisible()) {
    visualizerWindow.hide();
    return false;
  }

  visualizerWindow.show();
  visualizerWindow.focus();
  return true;
}

ipcMain.handle('toggle-visualizer', () => toggleVisualizerWindow());

function createTray() {
  const assetsDir = path.join(__dirname, 'assets');
  const candidates = ['taskicon.png', 'Fav_Icon.svg'];
  let iconPath = null;
  try {
    const files = fs.readdirSync(assetsDir);
    for (const c of candidates) {
      const found = files.find(f => f.toLowerCase() === c.toLowerCase());
      if (found) { iconPath = path.join(assetsDir, found); break; }
    }
  } catch (e) {
    iconPath = null;
  }

  let trayIcon = nativeImage.createEmpty();
  if (iconPath) {
    try {
      const stat = fs.statSync(iconPath);
      if (stat && stat.isFile()) {
        trayIcon = nativeImage.createFromPath(iconPath);
        if (!trayIcon || trayIcon.isEmpty()) {
          const buf = fs.readFileSync(iconPath);
          trayIcon = nativeImage.createFromBuffer(Buffer.from(buf));
        }
        try { trayIcon = trayIcon.resize({ width: 16, height: 16 }); } catch (e) { }
      }
    } catch (e) {
      trayIcon = nativeImage.createEmpty();
    }
  }

  tray = new Tray(trayIcon);
  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show', click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        } else {
          createWindow();
        }
      }
    },
    { label: 'Hide', click: () => { if (mainWindow) mainWindow.hide(); } },
    { label: 'Toggle Visualizer', click: () => { toggleVisualizerWindow(); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuiting = true; app.quit(); } }
  ]);
  tray.setToolTip('MusicPlayer');
  tray.setContextMenu(contextMenu);
  tray.on('click', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isVisible() && mainWindow.isFocused()) {
        mainWindow.hide();
        if (visualizerWindow && !visualizerWindow.isDestroyed()) {
          visualizerWindow.hide();
        }
      } else {
        bringMainWindowToFront();
        if (visualizerWindow && !visualizerWindow.isDestroyed() && visualizerWindow.isVisible()) {
          visualizerWindow.show();
        }
      }
    } else {
      createWindow();
    }
  });
}

app.whenReady().then(() => {
  createWindow();
  createTray();
  spawnTaskbarWidget();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});



ipcMain.handle('get-music-files', async () => {
  // Broaden Scanning: Scan the entire user Music folder, not just a specific subfolder.
  const musicRoot = app.getPath('music');

  function getFiles(dir) {
    let results = [];
    try {
      if (!fs.existsSync(dir)) return [];
      const list = fs.readdirSync(dir);
      list.forEach(file => {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);
        if (stat && stat.isDirectory()) {
          // Skip hidden directories (like AppData or similar if accidentally reached)
          if (!file.startsWith('.')) {
            results = results.concat(getFiles(fullPath));
          }
        } else if (file.toLowerCase().endsWith('.mp3') ||
          file.toLowerCase().endsWith('.m4a') ||
          file.toLowerCase().endsWith('.wav') ||
          file.toLowerCase().endsWith('.flac')) {
          results.push(fullPath);
        }
      });
    } catch (e) {
      console.error('Error scanning dir:', dir, e);
    }
    return results;
  }

  function normalizeFilePath(filePath) {
    try {
      const realPath = fs.realpathSync(filePath);
      return process.platform === 'win32' ? realPath.toLowerCase() : realPath;
    } catch (e) {
      return process.platform === 'win32' ? path.normalize(filePath).toLowerCase() : path.normalize(filePath);
    }
  }

  const files = getFiles(musicRoot).map(normalizeFilePath);
  return [...new Set(files)];
});

ipcMain.handle('get-metadata', async (event, filePath) => {
  try {
    const metadata = await mm.parseFile(filePath);
    let pictureBase64 = null;
    if (metadata.common.picture && metadata.common.picture.length > 0) {
      const pic = metadata.common.picture[0];
      // Fix: Standardize MIME type and use Buffer.from for reliable Base64 encoding of Uint8Array data.
      const mimeType = pic.format.includes('/') ? pic.format : `image/${pic.format === 'jpg' ? 'jpeg' : pic.format}`;
      pictureBase64 = `data:${mimeType};base64,${Buffer.from(pic.data).toString('base64')}`;
    }
    return {
      title: metadata.common.title || path.basename(filePath),
      artist: metadata.common.artist || 'Unknown Artist',
      album: metadata.common.album || 'Unknown Album',
      picture: pictureBase64
    };
  } catch (err) {
    return {
      title: path.basename(filePath),
      artist: 'Unknown Artist',
      album: 'Unknown Album',
      picture: null
    };
  }
});

ipcMain.handle('select-icon-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select playlist icon',
    properties: ['openFile'],
    filters: [
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'svg', 'gif', 'webp'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
    return null;
  }
  return result.filePaths[0];
});

function applyWindowSize(width, height) {
  savedWindowHeight = height;
  mainWindow.setMinimumSize(width, height);
  mainWindow.setMaximumSize(width, height);
  mainWindow.setSize(width, height);
}

ipcMain.on('resize-window', (event, mode) => {
  contextMenuExpanded = false;
  contextMenuExpandedWidth = 380;
  contextMenuExpandedHeight = savedWindowHeight;
  if (mode === 'expanded') {
    applyWindowSize(380, 560);
  } else {
    applyWindowSize(380, 210);
  }
});

ipcMain.handle('expand-for-context-menu', (event, menuWidth, extraHeight = 0) => {
  const newWidth = 380 + menuWidth + MENU_GAP + SHADOW_BLEED;
  const newHeight = savedWindowHeight + extraHeight;
  if (contextMenuExpanded && contextMenuExpandedWidth === newWidth && contextMenuExpandedHeight === newHeight) {
    return;
  }
  applyWindowSize(newWidth, newHeight);
  contextMenuExpanded = true;
  contextMenuExpandedWidth = newWidth;
  contextMenuExpandedHeight = newHeight;
});

ipcMain.handle('collapse-after-context-menu', () => {
  if (!contextMenuExpanded) {
    return;
  }
  applyWindowSize(380, savedWindowHeight);
  contextMenuExpanded = false;
  contextMenuExpandedWidth = 380;
  contextMenuExpandedHeight = savedWindowHeight;
});

ipcMain.on('set-always-on-top', (event, value) => {
  mainWindow.setAlwaysOnTop(value, 'screen-saver');
});

ipcMain.on('visualizer-data', (event, data) => {
  if (visualizerWindow && !visualizerWindow.isDestroyed()) {
    visualizerWindow.webContents.send('visualizer-data', data);
  }
});

ipcMain.on('visualizer-color', (event, color) => {
  if (typeof color === 'string' && color.trim()) {
    lastVisualizerColor = color;
  }
  if (visualizerWindow && !visualizerWindow.isDestroyed()) {
    visualizerWindow.webContents.send('visualizer-color', color);
  }
  sendToTaskbarWidget({
    cmd: 'visualizer-color',
    color: color || ''
  });
});

ipcMain.on('track-change', (event, data) => {
  currentTrackData = data;
  sendToTaskbarWidget({
    cmd: 'update-track',
    title: data ? (data.title || '') : '',
    artist: data ? (data.artist || '') : '',
    picture: data ? (data.picture || '') : '',
    isPlaying: data ? !!data.isPlaying : false
  });
});

ipcMain.on('playback-change', (event, isPlaying) => {
  if (currentTrackData) {
    currentTrackData.isPlaying = isPlaying;
  }
  sendToTaskbarWidget({
    cmd: 'update-playback',
    isPlaying: !!isPlaying
  });
});

ipcMain.on('taskbar-control', (event, action) => {
  handleTaskbarControl(action);
});