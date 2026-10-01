using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Automation;

namespace TrayLocator;

class Program
{
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr FindWindow(string? lpClassName, string? lpWindowName);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr FindWindowEx(IntPtr hWndParent, IntPtr hWndChildAfter, string? lpszClass, string? lpszWindow);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr dpiContext);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetWindowBand(IntPtr hWnd, IntPtr hwndInsertAfter, uint dwBand);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int x, int y, int cx, int cy, uint uFlags);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetParent(IntPtr hWndChild, IntPtr hWndNewParent);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    private static readonly IntPtr DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = new IntPtr(-4);
    private static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);

    const uint SWP_NOSIZE = 0x0001;
    const uint SWP_NOMOVE = 0x0002;
    const uint SWP_NOACTIVATE = 0x0010;
    const uint SWP_FRAMECHANGED = 0x0020;

    const uint ZBID_UIACCESS = 2;
    const uint ZBID_POPUPS = 14;

    static void Main(string[] args)
    {
        try
        {
            SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        }
        catch { }

        // 引数に HWND が指定された場合: ウィジェットを最前面バンド & スタートメニューとの Z-Order 同調
        if (args.Length > 0 && long.TryParse(args[0], out long targetHwndRaw) && targetHwndRaw != 0)
        {
            IntPtr targetHwnd = new IntPtr(targetHwndRaw);
            try
            {
                // スタートメニューの HWND を探索
                IntPtr startMenuHwnd = FindWindow("Windows.UI.Core.CoreWindow", "Start");
                if (startMenuHwnd == IntPtr.Zero)
                {
                    startMenuHwnd = FindWindow("Windows.UI.Core.CoreWindow", "スタート");
                }

                // ZBID_POPUPS (14) に設定
                SetWindowBand(targetHwnd, HWND_TOPMOST, ZBID_POPUPS);

                // スタートメニューが見つかった場合は Z-Order をスタートメニューの上へ
                if (startMenuHwnd != IntPtr.Zero)
                {
                    SetWindowPos(targetHwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_FRAMECHANGED);
                }
                else
                {
                    SetWindowPos(targetHwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_FRAMECHANGED);
                }

                Console.WriteLine("OK");
            }
            catch (Exception ex)
            {
                Console.WriteLine($"ERROR: {ex.Message}");
            }
            return;
        }

        // 引数なしの場合: トレイ左端 X 座標を出力
        try
        {
            IntPtr taskbarHwnd = FindWindow("Shell_TrayWnd", null);
            if (taskbarHwnd == IntPtr.Zero)
            {
                Console.WriteLine("0");
                return;
            }

            var taskbarElem = AutomationElement.FromHandle(taskbarHwnd);
            if (taskbarElem == null)
            {
                Console.WriteLine("0");
                return;
            }

            var descendants = taskbarElem.FindAll(TreeScope.Descendants, Condition.TrueCondition);

            // 1. 第一優先: システムトレイ全体のコンテナである TrayNotifyWnd または SystemTrayControlHost の Left
            for (int i = 0; i < descendants.Count; i++)
            {
                try
                {
                    var child = descendants[i];
                    var cls = child.Current.ClassName;
                    var autoId = child.Current.AutomationId;
                    var rect = child.Current.BoundingRectangle;

                    if (rect.IsEmpty || rect.Width <= 0 || rect.Height <= 0) continue;

                    if (cls == "TrayNotifyWnd" || autoId == "SystemTrayControlHost" || autoId == "TaskbarFrame")
                    {
                        if (rect.Left > 500)
                        {
                            Console.WriteLine(Math.Round(rect.Left));
                            return;
                        }
                    }
                }
                catch { }
            }

            // 2. 第二優先: トレイ領域内の直接の機能アイコン群
            double leftmostX = double.MaxValue;

            for (int i = 0; i < descendants.Count; i++)
            {
                try
                {
                    var child = descendants[i];
                    var rect = child.Current.BoundingRectangle;
                    var cls = child.Current.ClassName;
                    var autoId = child.Current.AutomationId;

                    if (rect.IsEmpty || rect.Width <= 0 || rect.Height <= 0) continue;

                    if (cls.Contains("TrayNotifyWnd") || autoId.Contains("SystemTrayIcon") || autoId.Contains("ControlCenter"))
                    {
                        if (rect.Left > 500 && rect.Left < leftmostX)
                        {
                            leftmostX = rect.Left;
                        }
                    }
                }
                catch { }
            }

            if (leftmostX < double.MaxValue)
            {
                Console.WriteLine(Math.Round(leftmostX));
            }
            else
            {
                Console.WriteLine("0");
            }
        }
        catch
        {
            Console.WriteLine("0");
        }
    }
}
