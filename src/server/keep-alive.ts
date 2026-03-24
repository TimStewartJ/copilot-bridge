// Keep-alive: resets the system idle timer while sessions are active.
// Listens for session:busy/idle on globalBus. While any session is in-flight,
// jiggles the mouse ±1px every 60s to reset the Windows idle timer.

import { execFile } from "node:child_process";
import * as globalBus from "./global-bus.js";

let jiggleInterval: ReturnType<typeof setInterval> | null = null;
let activeSessions = 0;

// PowerShell snippet: move mouse +1px then -1px (net zero movement)
// Also calls SetThreadExecutionState to prevent the machine from sleeping
const PS_JIGGLE = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Jiggle {
    [DllImport("user32.dll")]
    public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, UIntPtr dwExtraInfo);

    [DllImport("kernel32.dll")]
    public static extern uint SetThreadExecutionState(uint esFlags);

    public static void Ping() {
        // Reset idle timer (ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED | ES_CONTINUOUS)
        SetThreadExecutionState(0x80000001 | 0x00000002);
        // MOUSEEVENTF_MOVE = 0x0001, relative +1 then -1
        mouse_event(0x0001, 1, 0, 0, UIntPtr.Zero);
        mouse_event(0x0001, -1, 0, 0, UIntPtr.Zero);
    }
}
"@
[Jiggle]::Ping()
`;

function jiggle(): void {
  execFile("powershell", ["-NoProfile", "-NonInteractive", "-Command", PS_JIGGLE], (err) => {
    if (err) console.error("[keep-alive] jiggle failed:", err.message);
  });
}

function startJiggle(): void {
  if (jiggleInterval) return;
  console.log("[keep-alive] 🟢 Mouse jiggle started (sessions active)");
  jiggle(); // immediate first jiggle
  jiggleInterval = setInterval(jiggle, 60_000); // then every 60s
}

function stopJiggle(): void {
  if (!jiggleInterval) return;
  clearInterval(jiggleInterval);
  jiggleInterval = null;
  console.log("[keep-alive] ⚪ Mouse jiggle stopped (all sessions idle)");
}

export function initKeepAlive(): void {
  if (process.platform !== "win32") {
    console.log("[keep-alive] Skipped (not Windows)");
    return;
  }

  globalBus.subscribe((event) => {
    if (event.type === "session:busy") {
      activeSessions++;
      if (activeSessions === 1) startJiggle();
    } else if (event.type === "session:idle") {
      activeSessions = Math.max(0, activeSessions - 1);
      if (activeSessions === 0) stopJiggle();
    }
  });

  console.log("[keep-alive] Initialized — will jiggle mouse while sessions are active");
}
