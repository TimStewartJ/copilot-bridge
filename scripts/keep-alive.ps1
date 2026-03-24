# Keep-Alive: Prevents the machine from sleeping by simulating system activity
# Runs in a loop, periodically:
#   1. Calls SetThreadExecutionState to reset the Windows idle timer
#   2. Touches a temp file to produce disk I/O
#
# Note: Mouse jiggle to reset the idle timer is handled by the bridge server
# (src/server/keep-alive.ts) — only active while sessions are in-flight.
#
# Interval: every 3 minutes (well under typical 60-min idle thresholds)

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class KeepAlive {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint SetThreadExecutionState(uint esFlags);

    // ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED | ES_CONTINUOUS
    public const uint ES_FLAGS = 0x00000001 | 0x00000002 | 0x80000000;

    public static void Ping() {
        SetThreadExecutionState(ES_FLAGS);
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
