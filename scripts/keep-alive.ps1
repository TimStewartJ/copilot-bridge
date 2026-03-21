# Keep-Alive: Prevents the machine from sleeping by simulating system activity
# Runs in a loop, periodically:
#   1. Calls SetThreadExecutionState to reset the Windows idle timer
#   2. Sends a trivial keystroke (F15 — no visible effect) to generate user input
#   3. Touches a temp file to produce disk I/O
#
# Interval: every 3 minutes (well under typical 60-min idle thresholds)

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class KeepAlive {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint SetThreadExecutionState(uint esFlags);

    [DllImport("user32.dll")]
    public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

    // ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED | ES_CONTINUOUS
    public const uint ES_FLAGS = 0x00000001 | 0x00000002 | 0x80000000;

    // VK_F15 (0x7E) — a key that exists in the API but has no effect on anything
    public const byte VK_F15 = 0x7E;
    public const uint KEYEVENTF_KEYUP = 0x0002;

    public static void Ping() {
        SetThreadExecutionState(ES_FLAGS);
        keybd_event(VK_F15, 0, 0, UIntPtr.Zero);
        keybd_event(VK_F15, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
    }
}
"@

$intervalSeconds = 180  # 3 minutes
$touchFile = Join-Path $env:TEMP "bridge-keepalive.tick"

Write-Host "Keep-alive started (PID $PID). Pinging every $intervalSeconds seconds."

while ($true) {
    try {
        [KeepAlive]::Ping()
        [System.IO.File]::WriteAllText($touchFile, (Get-Date -Format o))
    } catch {
        # Silently continue — best effort
    }
    Start-Sleep -Seconds $intervalSeconds
}
