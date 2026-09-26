[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet('F10', 'Up', 'Down', 'Left', 'Right', 'Enter', 'Escape', 'Space', 'Tab', 'Ctrl')]
    [string]$Key,

    [ValidateRange(1, 10)]
    [int]$Repeat = 1,

    [ValidateRange(20, 1000)]
    [int]$HoldMilliseconds = 60,

    [ValidateRange(50, 3000)]
    [int]$IntervalMilliseconds = 200
)

$ErrorActionPreference = 'Stop'

if (-not ('Dd1AgentBridge.InputNative' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace Dd1AgentBridge {
    public static class InputNative {
        [DllImport("user32.dll")]
        public static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        public static extern bool IsWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern uint MapVirtualKey(uint uCode, uint uMapType);

        [DllImport("user32.dll")]
        public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
    }
}
'@
}

$virtualKeys = @{
    F10    = 0x79
    Up     = 0x26
    Down   = 0x28
    Left   = 0x25
    Right  = 0x27
    Enter  = 0x0D
    Escape = 0x1B
    Space  = 0x20
    Tab    = 0x09
    Ctrl   = 0x11
}

$processes = @(Get-Process -Name Darkest -ErrorAction SilentlyContinue)
if ($processes.Count -eq 0) { throw 'Darkest.exe is not running.' }
if ($processes.Count -gt 1) { throw 'More than one Darkest.exe process is running; refusing to choose a target.' }

$process = $processes[0]
$window = $process.MainWindowHandle
if ($window -eq [IntPtr]::Zero -or -not [Dd1AgentBridge.InputNative]::IsWindow($window)) {
    throw 'Darkest.exe does not currently expose a valid main window.'
}

$shell = New-Object -ComObject WScript.Shell
if (-not $shell.AppActivate($process.Id)) {
    throw 'Could not activate the Darkest Dungeon window.'
}
Start-Sleep -Milliseconds 180

$foreground = [Dd1AgentBridge.InputNative]::GetForegroundWindow()
if ($foreground -ne $window) {
    throw ('Foreground verification failed: expected 0x{0:X}, got 0x{1:X}.' -f $window.ToInt64(), $foreground.ToInt64())
}

$vk = [byte]$virtualKeys[$Key]
$scan = [byte][Dd1AgentBridge.InputNative]::MapVirtualKey($vk, 0)
$keyUp = 0x0002

for ($index = 0; $index -lt $Repeat; $index++) {
    [Dd1AgentBridge.InputNative]::keybd_event($vk, $scan, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds $HoldMilliseconds
    [Dd1AgentBridge.InputNative]::keybd_event($vk, $scan, $keyUp, [UIntPtr]::Zero)
    if ($index + 1 -lt $Repeat) { Start-Sleep -Milliseconds $IntervalMilliseconds }
}

[pscustomobject]@{
    ProcessId = $process.Id
    WindowHandle = ('0x{0:X}' -f $window.ToInt64())
    ForegroundVerified = $true
    Key = $Key
    Repeat = $Repeat
    SentAtUtc = (Get-Date).ToUniversalTime().ToString('o')
}
