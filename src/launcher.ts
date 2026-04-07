// Launcher — immortal parent process that manages the bridge server

import "./log-timestamps.js";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, unlinkSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { killProcessTree as platformKillTree } from "./server/platform.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const NODE_PATH = process.execPath; // use the same node binary that's running the launcher
const TSX_CLI = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const SIGNAL_FILE = join(ROOT, "data", "restart.signal");
const SERVER_ENTRY = join(ROOT, "src", "server", "index.ts");
const PORT = 3333;
const HEALTH_URL = `http://localhost:${PORT}/api/sessions`;
const MAX_FAILURES = 3;
const POLL_INTERVAL = 2_000;
const HEALTH_TIMEOUT = 30_000;

// Notification config
const TUNNEL_NAME = process.env.BRIDGE_TUNNEL_NAME || "copilot-bridge";
const WEBHOOK_URL = process.env.BRIDGE_WEBHOOK_URL || "";

const BUSY_CHECK_INTERVAL = 3_000;
const BUSY_WAIT_TIMEOUT = 3_600_000; // 60 minutes max wait
const STALE_THRESHOLD = 300_000; // 5 minutes — session with no events is "stuck"
const GRACEFUL_EXIT_WAIT = 15_000; // wait for clean exit after POST /api/shutdown
const CRASH_RESTART_DELAY = 5_000;
const MAX_CRASH_RESTARTS = 5;
const CRASH_WINDOW = 60_000; // reset crash counter after 60s of stability

// Tunnel resilience config
const MAX_TUNNEL_RESTARTS = 5;
const TUNNEL_CRASH_WINDOW = 300_000; // reset crash counter after 5 min of stability
const TUNNEL_BACKOFF_BASE = 5_000; // 5s initial backoff
const TUNNEL_BACKOFF_CAP = 60_000; // 60s max backoff

let serverProcess: ChildProcess | null = null;
let tunnelProcess: ChildProcess | null = null;
let currentTunnelUrl: string | null = null;
let consecutiveFailures = 0;
let restarting = false;
let shuttingDown = false;
let crashRestarts = 0;
let lastCrashTime = 0;
let tunnelCrashRestarts = 0;
let tunnelStartedAt = 0;

function log(msg: string) {
  console.log(`[launcher] ${msg}`);
}

function gitHash(): string {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: ROOT, encoding: "utf-8", timeout: 5_000 }).trim();
  } catch { return "unknown"; }
}

const tag = () => `${gitHash()}, PID ${process.pid}`;

function clearSignal() {
  try { if (existsSync(SIGNAL_FILE)) unlinkSync(SIGNAL_FILE); } catch {}
}

function run(cmd: string): { ok: boolean; output: string } {
  try {
    const output = execSync(cmd, { cwd: ROOT, encoding: "utf-8", timeout: 120_000 });
    return { ok: true, output };
  } catch (err: any) {
    return { ok: false, output: err.stderr || err.stdout || String(err) };
  }
}

const DEPS_HASH_FILE = join(ROOT, "data", "deps-hash");

/** Hash package.json + package-lock.json to detect dependency changes. */
function depsHash(): string {
  const parts: string[] = [];
  for (const f of ["package.json", "package-lock.json"]) {
    const p = join(ROOT, f);
    parts.push(existsSync(p) ? readFileSync(p, "utf-8") : "");
  }
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}

/** Run npm install if package.json or package-lock.json have changed since last install. */
function ensureDeps(): boolean {
  const current = depsHash();
  try {
    if (existsSync(DEPS_HASH_FILE) && readFileSync(DEPS_HASH_FILE, "utf-8").trim() === current) {
      return true; // deps are in sync
    }
  } catch {}

  log("Dependencies changed — running npm install...");
  const result = run("npm install --no-audit --no-fund");
  if (!result.ok) {
    log(`npm install failed: ${result.output.slice(-500)}`);
    return false;
  }
  // Update stored hash
  const dataDir = join(ROOT, "data");
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  writeFileSync(DEPS_HASH_FILE, current);
  log("npm install succeeded — deps hash updated");
  return true;
}

function build(): boolean {
  log("Building...");
  ensureDeps();
  const client = run("npx vite build");
  if (!client.ok) {
    log(`Client build failed:\n${client.output.slice(-500)}`);
    return false;
  }
  const server = run("npx tsc --noEmit");
  if (!server.ok) {
    log(`Server type check failed:\n${server.output.slice(-500)}`);
    return false;
  }
  log("Build succeeded");
  return true;
}

function rollback() {
  log("Rolling back to last checkpoint...");
  const preDeployFile = join(ROOT, "data", "pre-deploy-sha");
  let rollbackTarget = "HEAD";
  try {
    if (existsSync(preDeployFile)) {
      const sha = readFileSync(preDeployFile, "utf-8").trim();
      if (sha) {
        rollbackTarget = sha;
        log(`Rolling back to pre-deploy state: ${sha}`);
      }
      unlinkSync(preDeployFile);
    }
  } catch {}
  run(`git reset --hard ${rollbackTarget}`);
  ensureDeps();
  run("npx vite build");
  log("Rollback complete");
}

async function healthCheck(): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < HEALTH_TIMEOUT) {
    try {
      const res = await fetch(HEALTH_URL);
      if (res.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 1_000));
  }
  return false;
}

function startServer(): ChildProcess {
  log("Starting server...");
  const env = { ...process.env };
  if (currentTunnelUrl) env.BRIDGE_TUNNEL_URL = currentTunnelUrl;
  const child = spawn(NODE_PATH, [TSX_CLI, SERVER_ENTRY], {
    cwd: ROOT,
    stdio: ["ignore", "inherit", "inherit"],
    env,
  });

  child.on("exit", (code) => {
    log(`Server exited with code ${code}`);
    if (serverProcess === child) {
      serverProcess = null;
    }

    // Auto-restart on unexpected crash (non-zero exit, not during intentional restart/shutdown)
    if (code !== 0 && code !== null && !restarting && !shuttingDown) {
      const now = Date.now();
      if (now - lastCrashTime > CRASH_WINDOW) {
        crashRestarts = 0; // stable long enough, reset counter
      }
      lastCrashTime = now;
      crashRestarts++;

      if (crashRestarts > MAX_CRASH_RESTARTS) {
        log(`❌ ${crashRestarts} crashes in quick succession — not restarting. Manual intervention needed.`);
        return;
      }

      log(`⚡ Crash detected (exit code ${code}). Auto-restarting in ${CRASH_RESTART_DELAY / 1000}s... (attempt ${crashRestarts}/${MAX_CRASH_RESTARTS})`);
      setTimeout(async () => {
        if (serverProcess || restarting) return; // something else already started it
        serverProcess = startServer();
        const healthy = await healthCheck();
        if (healthy) {
          log(`✅ Auto-restart succeeded after crash`);
          await notifyWebhook(`⚡ Copilot Bridge auto-restarted after crash (exit code ${code}, attempt ${crashRestarts}/${MAX_CRASH_RESTARTS}, ${tag()})`, currentTunnelUrl ?? undefined);
        } else {
          log(`❌ Auto-restart failed health check`);
          killServer();
        }
      }, CRASH_RESTART_DELAY);
    }
  });

  return child;
}

function killProcessTree(proc: ChildProcess | null): boolean {
  if (!proc || !proc.pid) return false;
  platformKillTree(proc.pid);
  return true;
}

function killServer() {
  if (serverProcess) {
    log("Stopping server...");
    killProcessTree(serverProcess);
    serverProcess = null;
  }
}

async function waitForIdleSessions(): Promise<boolean> {
  const busyUrl = `http://localhost:${PORT}/api/busy`;
  const start = Date.now();

  try {
    const initial = await fetch(busyUrl);
    if (initial.ok) {
      const data = await initial.json() as any;
      if (!data.busy) return true;
      log(`Waiting for ${data.count} active session(s) to finish: ${(data.sessions ?? []).map((s: any) => s.id?.slice(0, 8)).join(", ")}`);
    }
  } catch {
    log("Server not reachable for busy check — proceeding with restart");
    return true;
  }

  while (Date.now() - start < BUSY_WAIT_TIMEOUT) {
    await new Promise((r) => setTimeout(r, BUSY_CHECK_INTERVAL));
    try {
      const res = await fetch(busyUrl);
      if (res.ok) {
        const data = await res.json() as any;
        if (!data.busy) {
          log("All sessions idle — proceeding with restart");
          return true;
        }

        const sessions: Array<{ id: string; staleMs: number; elapsedMs: number }> = data.sessions ?? [];
        const allStuck = sessions.length > 0 && sessions.every((s) => s.staleMs >= STALE_THRESHOLD);

        if (allStuck) {
          log(`All ${sessions.length} session(s) are stuck (no events for ${STALE_THRESHOLD / 1000}s+) — proceeding with restart`);
          return true;
        }

        const elapsed = Math.floor((Date.now() - start) / 1000);
        const stuckCount = sessions.filter((s) => s.staleMs >= STALE_THRESHOLD).length;
        const detail = stuckCount > 0
          ? ` (${stuckCount} stuck, ${sessions.length - stuckCount} active)`
          : "";
        log(`Still waiting for ${data.count} session(s)${detail}... (${elapsed}s)`);
      }
    } catch {
      log("Server became unreachable during busy wait — proceeding with restart");
      return true;
    }
  }

  log(`⚠️ Timed out after ${BUSY_WAIT_TIMEOUT / 1000}s waiting for sessions — proceeding with restart`);
  return true;
}

async function gracefulStopServer(): Promise<boolean> {
  const shutdownUrl = `http://localhost:${PORT}/api/shutdown`;
  try {
    log("Requesting graceful shutdown...");
    await fetch(shutdownUrl, { method: "POST" });
  } catch {
    log("Server not reachable for graceful shutdown — falling back to force kill");
    killServer();
    return true;
  }

  // Wait for process to exit on its own
  const start = Date.now();
  while (serverProcess && Date.now() - start < GRACEFUL_EXIT_WAIT) {
    await new Promise((r) => setTimeout(r, 500));
  }

  if (serverProcess) {
    log("Server did not exit in time — force killing");
    killServer();
  } else {
    log("Server exited cleanly");
  }
  return true;
}

async function restart() {
  log("═══ Restart requested ═══");

  await waitForIdleSessions();

  if (!build()) {
    log("Build failed — rolling back");
    await notifyWebhook(`⚠️ Build failed — rolling back to last checkpoint (${tag()})`, currentTunnelUrl ?? undefined);
    rollback();
    // Old server is still running with restart banner — dismiss it immediately
    try { await fetch(`http://localhost:${PORT}/api/restart-clear`, { method: "POST" }); }
    catch { /* server may be unreachable */ }
    consecutiveFailures++;
    if (consecutiveFailures >= MAX_FAILURES) {
      log(`❌ ${MAX_FAILURES} consecutive failures — stopping`);
      process.exit(1);
    }
    return;
  }

  await gracefulStopServer();
  serverProcess = startServer();

  const healthy = await healthCheck();
  if (healthy) {
    log("✅ Server restarted successfully");
    consecutiveFailures = 0;

    // Cycle the tunnel so it gets a fresh connection
    try {
      tunnelCrashRestarts = 0; // reset since this is intentional
      const url = await startTunnel();
      await notifyWebhook(`🔄 Copilot Bridge restarted successfully (${tag()})`, url);
    } catch (err) {
      log(`Tunnel restart failed (non-fatal): ${err}`);
      await notifyWebhook(`🔄 Copilot Bridge restarted successfully (${tag()})`, currentTunnelUrl ?? undefined);
    }
  } else {
    log("❌ Health check failed — rolling back");
    await notifyWebhook(`⚠️ Health check failed — rolling back to last checkpoint (${tag()})`, currentTunnelUrl ?? undefined);
    killServer();
    rollback();
    serverProcess = startServer();
    consecutiveFailures++;
    if (consecutiveFailures >= MAX_FAILURES) {
      log(`❌ ${MAX_FAILURES} consecutive failures — stopping`);
      process.exit(1);
    }
  }
}

// ── Dev Tunnel ────────────────────────────────────────────────────

function startTunnel(): Promise<string> {
  // Kill any existing tunnel first (idempotent)
  killTunnel();

  return new Promise((resolve, reject) => {
    log("Starting dev tunnel...");
    tunnelProcess = spawn("devtunnel", ["host", TUNNEL_NAME], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
    });

    let stdout = "";
    let resolved = false;
    const timeout = setTimeout(() => {
      reject(new Error("Tunnel failed to start within 30s"));
    }, 30_000);

    tunnelProcess.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
      // Look for the URL: "Connect via browser: https://xxx-3333.usw2.devtunnels.ms"
      const match = stdout.match(/Connect via browser:\s+(https:\/\/\S+)/);
      if (match && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        currentTunnelUrl = match[1];
        tunnelStartedAt = Date.now();
        log(`Tunnel URL: ${currentTunnelUrl}`);
        resolve(currentTunnelUrl);
      }
    });

    tunnelProcess.on("exit", (code) => {
      log(`Tunnel exited with code ${code}`);
      tunnelProcess = null;

      if (!resolved) {
        clearTimeout(timeout);
        reject(new Error(`Tunnel process exited with code ${code} before producing URL`));
        return;
      }

      // Auto-respawn on unexpected exit
      if (shuttingDown || restarting) return;

      const now = Date.now();
      const uptime = now - tunnelStartedAt;
      if (uptime > TUNNEL_CRASH_WINDOW) {
        tunnelCrashRestarts = 0; // stable long enough, reset counter
      }
      tunnelCrashRestarts++;

      if (tunnelCrashRestarts > MAX_TUNNEL_RESTARTS) {
        log(`❌ Tunnel crashed ${tunnelCrashRestarts} times in quick succession — not restarting. Manual intervention needed.`);
        return;
      }

      const backoff = Math.min(TUNNEL_BACKOFF_BASE * Math.pow(2, tunnelCrashRestarts - 1), TUNNEL_BACKOFF_CAP);
      log(`⚡ Tunnel crashed (exit code ${code}). Auto-restarting in ${backoff / 1000}s... (attempt ${tunnelCrashRestarts}/${MAX_TUNNEL_RESTARTS})`);

      setTimeout(async () => {
        if (tunnelProcess || shuttingDown) return; // something else already started it
        try {
          const url = await startTunnel();
          log(`✅ Tunnel auto-restarted successfully`);
          await notifyWebhook(`⚡ Tunnel auto-restarted (attempt ${tunnelCrashRestarts}/${MAX_TUNNEL_RESTARTS}, ${tag()})`, url);
        } catch (err) {
          log(`❌ Tunnel auto-restart failed: ${err}`);
        }
      }, backoff);
    });
  });
}

function killTunnel() {
  if (tunnelProcess) {
    log("Stopping tunnel...");
    killProcessTree(tunnelProcess);
    tunnelProcess = null;
  }
}

// ── Webhook Notification ──────────────────────────────────────────

async function notifyWebhook(message: string, url?: string): Promise<void> {
  if (!WEBHOOK_URL) return;
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: message, url }),
    });
    if (res.ok) {
      log("Webhook notification sent");
    } else {
      log(`Webhook notification failed: ${res.status}`);
    }
  } catch (err) {
    log(`Webhook notification error: ${err}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────

async function main() {
  console.log("╔════════════════════════════════════════╗");
  console.log("║      Copilot Bridge Launcher           ║");
  console.log("╚════════════════════════════════════════╝");
  console.log();

  clearSignal();

  // Pull latest from origin on startup
  const currentBranch = run("git rev-parse --abbrev-ref HEAD");
  const branchName = currentBranch.ok ? currentBranch.output.trim() : "main";
  const pullResult = run(`git pull --rebase origin ${branchName}`);
  if (pullResult.ok) {
    log("Pulled latest from origin");
  } else {
    log(`Git pull failed (non-fatal, using local state): ${pullResult.output.slice(-200)}`);
  }

  // Ensure dependencies are in sync after pull
  ensureDeps();

  // Start server
  serverProcess = startServer();

  // Start dev tunnel
  try {
    const url = await startTunnel();
    await notifyWebhook(`🤖 Copilot Bridge is online! (${tag()})`, url);
  } catch (err) {
    log(`Tunnel/notification setup failed (non-fatal): ${err}`);
  }

  // Poll for restart signal
  setInterval(async () => {
    if (!restarting && existsSync(SIGNAL_FILE)) {
      restarting = true;
      try {
        await restart();
      } finally {
        clearSignal();
        restarting = false;
      }
    }
  }, POLL_INTERVAL);

  log("Watching for restart signals...");
}

process.on("SIGINT", () => {
  log("Shutting down...");
  shuttingDown = true;
  killServer();
  killTunnel();
  process.exit(0);
});

process.on("SIGTERM", () => {
  shuttingDown = true;
  killServer();
  killTunnel();
  process.exit(0);
});

main().catch((err) => {
  console.error("[launcher] Fatal:", err);
  process.exit(1);
});
