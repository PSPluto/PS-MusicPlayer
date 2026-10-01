$code = @"
using System;
using System.Runtime.InteropServices;

public class WindowHelper
{
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT
    {
        public int left;
        public int top;
        public int right;
        public int bottom;
    }

    [DllImport("user32.dll")]
    public static extern IntPtr FindWindowW(string lpClassName, string lpWindowName);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    public static void Main()
    {
        IntPtr hwnd = FindWindowW("Shell_TrayWnd", null);
        Console.WriteLine("Taskbar HWND: " + hwnd.ToInt64());

        if (hwnd != IntPtr.Zero)
        {
            RECT rect;
            bool result = GetWindowRect(hwnd, out rect);
            Console.WriteLine("GetWindowRect result: " + result);
            Console.WriteLine("left: " + rect.left);
            Console.WriteLine("top: " + rect.top);
            Console.WriteLine("right: " + rect.right);
            Console.WriteLine("bottom: " + rect.bottom);

            int height = rect.bottom - rect.top;
            int width = rect.right - rect.left;
            Console.WriteLine("Taskbar height: " + height);
            Console.WriteLine("Taskbar width: " + width);
            Console.WriteLine("Taskbar visible: " + (height >= 10 && width >= 10));
        }
    }
}
"@

Add-Type -TypeDefinition $code -Language CSharp -ErrorAction Stop
[WindowHelper]::Main()
