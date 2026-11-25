param(
    [Parameter(Mandatory)][int]$HostProcessId,
    [Parameter(Mandatory)][ValidateSet('inspect','minimize','select','cancel','close','confirm','wait','stay','ime-focus','ime-type','ime-confirm','ime-finish','ime-toggle')][string]$Action,
    [string]$Folder,
    [string]$Picture,
    [string]$ExpectedTitle
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class DesktopVerify {
    delegate bool EnumWindow(IntPtr window, IntPtr value);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindow callback, IntPtr value);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr window, uint command);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumWindow callback, IntPtr value);
    [DllImport("user32.dll")] static extern int GetDlgCtrlID(IntPtr window);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect bounds);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder name, int count);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr SendMessageTimeout(IntPtr window, uint message, IntPtr param, string text, uint flags, uint milliseconds, out IntPtr result);
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr window, int command);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint mapType);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr window, IntPtr order, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
    [StructLayout(LayoutKind.Sequential)]
    struct Point { public int X, Y; }
    public static bool SetTopmost(IntPtr window, bool topmost) {
        return SetWindowPos(window, new IntPtr(topmost ? -1 : -2), 0, 0, 0, 0, 0x13);
    }
    public static void Click(IntPtr window, int x, int y) {
        if (GetAncestor(WindowFromPoint(new Point { X = x, Y = y }), 2) != window)
            throw new InvalidOperationException("Native editor field is covered by another window.");
        Point before;
        GetCursorPos(out before);
        SetCursorPos(x, y);
        mouse_event(2, 0, 0, 0, UIntPtr.Zero);
        mouse_event(4, 0, 0, 0, UIntPtr.Zero);
        System.Threading.Thread.Sleep(120);
        SetCursorPos(before.X, before.Y);
    }
    public static void Press(byte key) {
        byte scan = (byte)MapVirtualKey(key, 0);
        keybd_event(key, scan, 0, UIntPtr.Zero);
        System.Threading.Thread.Sleep(40);
        keybd_event(key, scan, 2, UIntPtr.Zero);
        System.Threading.Thread.Sleep(80);
    }
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
    [StructLayout(LayoutKind.Sequential)]
    struct Rect { public int Left, Top, Right, Bottom; }
    public static IntPtr[] OwnedWindows(uint pid) {
        var windows = new List<IntPtr>();
        EnumWindows((window, value) => {
            var owner = GetWindow(window, 4);
            uint process;
            if (owner != IntPtr.Zero && IsWindowVisible(window)) {
                GetWindowThreadProcessId(owner, out process);
                if (process == pid) windows.Add(window);
            }
            return true;
        }, IntPtr.Zero);
        return windows.ToArray();
    }
    public static IntPtr Child(IntPtr parent, int id, string windowClass) {
        var found = IntPtr.Zero;
        EnumChildWindows(parent, (window, value) => {
            var name = new StringBuilder(128);
            GetClassName(window, name, name.Capacity);
            if (!IsWindowVisible(window) || (id != 0 && GetDlgCtrlID(window) != id)
                || (!String.IsNullOrEmpty(windowClass) && !String.Equals(name.ToString(), windowClass, StringComparison.OrdinalIgnoreCase)))
                return true;
            found = window;
            return false;
        }, IntPtr.Zero);
        return found;
    }
    public static bool SetText(IntPtr edit, string text) {
        IntPtr result;
        return SendMessageTimeout(edit, 0x000C, IntPtr.Zero, text, 2, 2500, out result) != IntPtr.Zero;
    }
    public static IntPtr FolderEdit(IntPtr dialog) {
        var found = IntPtr.Zero;
        int lowest = Int32.MinValue;
        EnumChildWindows(dialog, (window, value) => {
            var name = new StringBuilder(128);
            Rect bounds;
            GetClassName(window, name, name.Capacity);
            if (String.Equals(name.ToString(), "Edit", StringComparison.OrdinalIgnoreCase)
                && IsWindowVisible(window) && GetWindowRect(window, out bounds) && bounds.Bottom > lowest) {
                lowest = bounds.Bottom;
                found = window;
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }
}
'@
$root = [Windows.Automation.AutomationElement]::RootElement
$processCondition = New-Object Windows.Automation.PropertyCondition ([Windows.Automation.AutomationElement]::ProcessIdProperty), $HostProcessId
$children = [Windows.Automation.TreeScope]::Children
$descendants = [Windows.Automation.TreeScope]::Descendants

function Find-Window([bool]$modal) {
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    do {
        if ($modal) {
            foreach ($handle in [DesktopVerify]::OwnedWindows([uint32]$HostProcessId)) {
                $element = [Windows.Automation.AutomationElement]::FromHandle($handle)
                if ($element -and $element.Current.ClassName -eq '#32770') { return $element }
            }
        }
        foreach ($element in $root.FindAll($children, $processCondition)) {
            $current = $element.Current
            if ($current.ControlType -ne [Windows.Automation.ControlType]::Window) { continue }
            if (!$modal -and $current.Name -eq 'K-Overlay-Studio') { return $element }
            if ($modal -and $current.ClassName -eq '#32770') { return $element }
        }
        Start-Sleep -Milliseconds 150
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Windows UI Automation could not find the requested application window (PID $HostProcessId, modal=$modal)."
}

function Save-Window($element) {
    if (!$Picture) { return }
    $bounds = $element.Current.BoundingRectangle
    $image = New-Object Drawing.Bitmap ([int]$bounds.Width), ([int]$bounds.Height)
    $graphics = [Drawing.Graphics]::FromImage($image)
    try {
        $graphics.CopyFromScreen([int]$bounds.X, [int]$bounds.Y, 0, 0, $image.Size)
        $image.Save($Picture, [Drawing.Imaging.ImageFormat]::Png)
    } finally { $graphics.Dispose(); $image.Dispose() }
}

function Invoke-Button([IntPtr]$parent, [int]$id) {
    $button = [DesktopVerify]::Child($parent, $id, 'Button')
    if ($button -eq [IntPtr]::Zero) { throw "Native dialog button $id unavailable." }
    if (![DesktopVerify]::PostMessage($button, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)) { throw 'Native dialog click failed.' }
}

if ($Action -in 'ime-focus','ime-type','ime-confirm','ime-finish','ime-toggle') {
    $window = Find-Window $false
    $handle = [IntPtr]$window.Current.NativeWindowHandle
    if ($Action -eq 'ime-focus') {
        $name = New-Object Windows.Automation.PropertyCondition ([Windows.Automation.AutomationElement]::NameProperty), $ExpectedTitle
        $editType = New-Object Windows.Automation.PropertyCondition ([Windows.Automation.AutomationElement]::ControlTypeProperty), ([Windows.Automation.ControlType]::Edit)
        $field = $window.FindFirst($descendants, (New-Object Windows.Automation.AndCondition($name, $editType)))
        if (!$field -or $field.Current.IsOffscreen) { throw 'Native editor field is unavailable.' }
        $raise = [DesktopVerify]::GetForegroundWindow() -ne $handle
        if ($raise -and ![DesktopVerify]::SetTopmost($handle, $true)) { throw 'Could not raise the test window.' }
        try {
            $point = $field.GetClickablePoint()
            [DesktopVerify]::Click($handle, [int]$point.X, [int]$point.Y)
        } finally {
            if ($raise) { $null = [DesktopVerify]::SetTopmost($handle, $false) }
        }
    }
    $keys = switch ($Action) {
        'ime-type' { 0x48, 0x55, 0x4F, 0x43, 0x48, 0x45 }
        'ime-confirm' { 0x31 }
        'ime-finish' { 0x0D }
        'ime-toggle' { 0x10 }
    }
    foreach ($key in $keys) {
        if ([DesktopVerify]::GetForegroundWindow() -ne $handle) { throw 'Native input needs the tested window in the foreground.' }
        [DesktopVerify]::Press([byte]$key)
    }
    [pscustomobject]@{ action = $Action; handle = $handle.ToInt64() } | ConvertTo-Json -Compress
    exit
}

if ($Action -in 'inspect','minimize','close') {
    $window = Find-Window $false
    $handle = [IntPtr]$window.Current.NativeWindowHandle
    if ($Action -eq 'minimize') { $null = [DesktopVerify]::ShowWindowAsync($handle, 6) }
    elseif ($Action -eq 'close') { $null = [DesktopVerify]::PostMessage($handle, 0x10, [IntPtr]::Zero, [IntPtr]::Zero) }
    else {
        Save-Window $window
        $current = $window.Current
        $process = Get-Process -Id $HostProcessId
        $icon = [Drawing.Icon]::ExtractAssociatedIcon($process.Path)
        try {
            [pscustomobject]@{
                processId = $HostProcessId
                title = $current.Name
                handle = $handle.ToInt64()
                foreground = [DesktopVerify]::GetForegroundWindow().ToInt64()
                minimized = [DesktopVerify]::IsIconic($handle)
                iconWidth = $icon.Width
                iconHeight = $icon.Height
                texts = @($window.FindAll($descendants, [Windows.Automation.Condition]::TrueCondition) | ForEach-Object { $_.Current.Name } | Where-Object { $_ } | Select-Object -First 60)
            } | ConvertTo-Json -Compress
        } finally { $icon.Dispose() }
    }
    exit
}

$dialog = Find-Window $true
Save-Window $dialog
$dialogTitle = $dialog.Current.Name
if ($ExpectedTitle -and $dialogTitle -ne $ExpectedTitle) {
    throw "Unexpected native dialog: $dialogTitle"
}
$dialogHandle = [IntPtr]$dialog.Current.NativeWindowHandle
if ($Action -eq 'select') {
    $edit = [DesktopVerify]::FolderEdit($dialogHandle)
    if ($edit -eq [IntPtr]::Zero -or ![DesktopVerify]::SetText($edit, $Folder)) { throw 'Native folder input rejected the path.' }
    Invoke-Button $dialogHandle 1
} else {
    $buttonIds = @{ cancel = 2; confirm = 6; wait = 7; stay = 2 }
    Invoke-Button $dialogHandle $buttonIds[$Action]
}
[pscustomobject]@{ title = $dialogTitle; ownerProcessId = $HostProcessId; action = $Action } | ConvertTo-Json -Compress
