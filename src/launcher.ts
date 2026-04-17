// Launcher — immortal parent process that manages the bridge server

import "./log-timestamps.js";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { existsSync, unlinkSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { dependencySyncHash, preparePatchedPackagesForInstall } from "./server/dependency-sync.js";
import { buildBridgeChildEnv, loadBridgeEnv } from "./server/env-loader.js";
import { killProcessTree as platformKillTree } from "./server/platform.js";
import { waitForIdleSessions as waitForIdleSessionsImpl } from "./server/restart-coordinator.js";
import { canUseDevtunnelCli, getDevtunnelCliStatus } from "./server/tunnel.js";
import {
  evaluateHealthPoll,
  evaluatePostRecoveryState,
  evaluateUnexpectedExit,
  shouldIgnoreHealthPollResult,
} from "./launcher-health.js";
import { isChildProcessActive, waitForChildExit } from "./launcher-process.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const NODE_PATH = process.execPath; // use the same node binary that's running the launcher
const TSX_CLI = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const SIGNAL_FILE = join(ROOT, "data", "restart.signal");
const SERVER_ENTRY = join(ROOT, "src", "server", "index.ts");
const PORT = 3333;
const HEALTH_URL = `http://localhost:${PORT}/api/health`;
const MAX_FAILURES = 3;
const POLL_INTERVAL = 2_000;
const HEALTH_TIMEOUT = 30_000;
const HEALTH_POLL_INTERVAL = 30_000;
const HEALTH_POLL_TIMEOUT = 5_000;
const HEALTH_FAILURE_THRESHOLD = 2;
const MANAGED_ENV_KEYS = new Set(loadBridgeEnv());

// Notification config
const TUNNEL_NAME = process.env.BRIDGE_TUNNEL_NAME || "copilot-bridge";
const WEBHOOK_URL = process.env.BRIDGE_WEBHOOK_URL || "";

const BUSY_CHECK_INTERVAL = 3_000;
const BUSY_WAIT_TIMEOUT = 3_600_000; // 60 minutes max wait
const STALE_THRESHOLD = 300_000; // 5 minutes — session with no events is "stuck"
const GRACEFUL_EXIT_WAIT = 15_000; // wait for clean exit after POST /api/shutdown
const GRACEFUL_SHUTDOWN_REQUEST_TIMEOUT = 5_000; // bound shutdown POST so force-kill fallback is reachable
const FORCED_EXIT_WAIT = 5_000; // wait for SIGKILLed child to actually exit before restarting
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
let steadyHealthFailures = 0;
let healthPollInFlight = false;
let recoveringServer = false;
let tunnelStatusLogged = false;

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
  // Prepend the launcher's Node v22 directory to PATH so npx/vitest use it
  const nodeDir = dirname(NODE_PATH);
  const env = { ...process.env, PATH: `${nodeDir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}` };
  try {
    const output = execSync(cmd, { cwd: ROOT, encoding: "utf-8", timeout: 120_000, env });
    return { ok: true, output };
  } catch (err: any) {
    return { ok: false, output: err.stderr || err.stdout || String(err) };
  }
}

const DEPS_HASH_FILE = join(ROOT, "data", "deps-hash");

/** Hash package files and patch-package inputs to detect dependency changes. */
function depsHash(): string {
  return dependencySyncHash(ROOT);
}

/** Run npm install if dependency inputs have changed since last install. */
function ensureDeps(): boolean {
  const current = depsHash();
  try {
    if (existsSync(DEPS_HASH_FILE) && readFileSync(DEPS_HASH_FILE, "utf-8").trim() === current) {
      return true; // deps are in sync
    }
  } catch {}

  const prepared = preparePatchedPackagesForInstall(ROOT);
  if (prepared.packages.length > 0) {
    log(`Prepared patched packages for npm install: ${prepared.packages.join(", ")}`);
  }

  log("Dependencies changed — running npm install...");
  const result = run("npm install --no-audit --no-fund --include=dev");
  if (!result.ok) {
    prepared.restore();
    log(`npm install failed: ${result.output.slice(-500)}`);
    return false;
  }
  prepared.discard();
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
  const tests = run("npx vitest run --coverage");
  if (!tests.ok) {
    log(`Tests failed:\n${tests.output.slice(-500)}`);
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

async function healthCheck(expectedChild: ChildProcess | null = serverProcess): Promise<boolean> {
  const checkHealthOnce = async (timeoutMs: number): Promise<boolean> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(HEALTH_URL, { signal: controller.signal });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  };

  const start = Date.now();
  while (Date.now() - start < HEALTH_TIMEOUT) {
    if (expectedChild && !isChildProcessActive(expectedChild, serverProcess)) {
      return false;
    }
    if (await checkHealthOnce(HEALTH_POLL_TIMEOUT)) {
      return expectedChild ? isChildProcessActive(expectedChild, serverProcess) : true;
    }
    if (expectedChild && !isChildProcessActive(expectedChild, serverProcess)) {
      return false;
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  return false;
}

function reserveRecoveryAttempt(): number | null {
  const now = Date.now();
  if (now - lastCrashTime > CRASH_WINDOW) {
    crashRestarts = 0;
  }
  lastCrashTime = now;
  crashRestarts++;

  if (crashRestarts > MAX_CRASH_RESTARTS) {
    log(`❌ ${crashRestarts} crashes in quick succession — not restarting. Manual intervention needed.`);
    return null;
  }

  return crashRestarts;
}

function recoverServer(reason: string, options: { killExisting?: boolean; delayMs?: number } = {}): void {
  const attempt = reserveRecoveryAttempt();
  if (!attempt) return;

  const delayMs = options.delayMs ?? 0;
  log(
    `⚡ ${reason}. Auto-restarting${delayMs > 0 ? ` in ${delayMs / 1000}s` : ""}... ` +
      `(attempt ${attempt}/${MAX_CRASH_RESTARTS})`,
  );

  const runRecovery = async () => {
    if (restarting || shuttingDown || recoveringServer) return;
    recoveringServer = true;
    try {
      if (options.killExisting) {
        const stopped = await forceKillServerAndWait("Stopping unhealthy server...");
        if (!stopped) {
          return;
        }
      } else if (serverProcess) {
        return;
      }
      const replacementServer = startServer();
      serverProcess = replacementServer;
      const healthy = await healthCheck(replacementServer);
      if (healthy) {
        steadyHealthFailures = 0;
        log(`✅ Auto-restart succeeded after ${reason}`);
        await notifyWebhook(
          `⚡ Copilot Bridge auto-restarted after ${reason} (attempt ${attempt}/${MAX_CRASH_RESTARTS}, ${tag()})`,
          currentTunnelUrl ?? undefined,
        );
      } else {
        log(`❌ Auto-restart failed health check after ${reason}`);
        await forceKillServerAndWait("Stopping failed auto-restart...");
      }
    } finally {
      recoveringServer = false;
      const followUpRecovery = evaluatePostRecoveryState({
        hasServerProcess: serverProcess !== null,
        restarting,
        recoveringServer,
        shuttingDown,
      });
      if (followUpRecovery) {
        recoverServer(followUpRecovery.reason, followUpRecovery.options);
      }
    }
  };

  if (delayMs > 0) {
    setTimeout(() => {
      void runRecovery();
    }, delayMs);
  } else {
    void runRecovery();
  }
}

async function pollServerHealth(): Promise<void> {
  if (healthPollInFlight || restarting || shuttingDown || recoveringServer) return;

  const polledServer = serverProcess;
  healthPollInFlight = true;
  try {
    let healthy = false;
    if (polledServer) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), HEALTH_POLL_TIMEOUT);
      try {
        const res = await fetch(HEALTH_URL, { signal: controller.signal });
        healthy = res.ok;
      } catch {
        healthy = false;
      } finally {
        clearTimeout(timeout);
      }
    }

    if (
      shouldIgnoreHealthPollResult({
        pollTargetChanged: serverProcess !== polledServer,
        restarting,
        shuttingDown,
        recoveringServer,
      })
    ) {
      return;
    }

    const decision = evaluateHealthPoll({
      healthy,
      hasServerProcess: polledServer !== null,
      consecutiveFailures: steadyHealthFailures,
      failureThreshold: HEALTH_FAILURE_THRESHOLD,
    });
    steadyHealthFailures = decision.nextFailures;

    if (!decision.logMessage) {
      return;
    }

    log(decision.logMessage);
    if (decision.recover) {
      recoverServer(decision.recover.reason, { killExisting: decision.recover.killExisting });
    }
  } finally {
    healthPollInFlight = false;
  }
}

function shouldUseDevtunnel(): boolean {
  const status = getDevtunnelCliStatus();
  if (status.enabled && status.available) return true;
  if (!tunnelStatusLogged) {
    log(`[tunnel] ${status.reason ?? "Dev tunnel unavailable"}`);
    tunnelStatusLogged = true;
  }
  return false;
}

function startServer(): ChildProcess {
  log("Starting server...");
  const env = buildBridgeChildEnv(process.env, MANAGED_ENV_KEYS);
  if (currentTunnelUrl) env.BRIDGE_TUNNEL_URL = currentTunnelUrl;
  const child = spawn(NODE_PATH, [TSX_CLI, SERVER_ENTRY], {
    cwd: ROOT,
    stdio: ["ignore", "inherit", "inherit"],
    env,
  });
  steadyHealthFailures = 0;

  child.on("exit", (code, signal) => {
    log(`Server exited with code ${code}${signal ? ` (signal ${signal})` : ""}`);
    if (serverProcess === child) {
      serverProcess = null;
    }

    const recovery = evaluateUnexpectedExit({
      code,
      signal,
      restarting,
      shuttingDown,
      recoveringServer,
      crashRestartDelay: CRASH_RESTART_DELAY,
    });
    if (recovery) {
      recoverServer(recovery.reason, recovery.options);
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

async function forceKillServerAndWait(reason: string, timeoutMs = FORCED_EXIT_WAIT): Promise<boolean> {
  const existingServer = serverProcess;
  if (!existingServer) {
    return true;
  }

  log(reason);
  killProcessTree(existingServer);
  const exited = await waitForChildExit(existingServer, timeoutMs);
  if (!exited) {
    log(`❌ Server did not exit within ${timeoutMs}ms after force kill`);
  }
  return exited;
}

async function waitForIdleSessions(): Promise<boolean> {
  const busyUrl = `http://localhost:${PORT}/api/busy`;
  return waitForIdleSessionsImpl({
    fetchBusy: async () => {
      const res = await fetch(busyUrl);
      if (!res.ok) throw new Error(`Busy check failed: ${res.status}`);
      return await res.json() as any;
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log,
    isServerAlive: () => serverProcess !== null,
    busyCheckInterval: BUSY_CHECK_INTERVAL,
    busyWaitTimeout: BUSY_WAIT_TIMEOUT,
    staleThreshold: STALE_THRESHOLD,
  });
}

async function gracefulStopServer(): Promise<boolean> {
  const shutdownUrl = `http://localhost:${PORT}/api/shutdown`;
  try {
    log("Requesting graceful shutdown...");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), GRACEFUL_SHUTDOWN_REQUEST_TIMEOUT);
    try {
      await fetch(shutdownUrl, { method: "POST", signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    log("Server not reachable or did not respond for graceful shutdown — falling back to force kill");
    return await forceKillServerAndWait("Stopping unreachable server...");
  }

  // Wait for process to exit on its own
  const start = Date.now();
  while (serverProcess && Date.now() - start < GRACEFUL_EXIT_WAIT) {
    await new Promise((r) => setTimeout(r, 500));
  }

  if (serverProcess) {
    return await forceKillServerAndWait("Server did not exit in time — force killing");
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

  await waitForIdleSessions();
  const stopped = await gracefulStopServer();
  if (!stopped) {
    log("❌ Existing server did not exit after force kill — aborting restart");
    consecutiveFailures++;
    if (consecutiveFailures >= MAX_FAILURES) {
      log(`❌ ${MAX_FAILURES} consecutive failures — stopping`);
      process.exit(1);
    }
    return;
  }
  const replacementServer = startServer();
  serverProcess = replacementServer;

  const healthy = await healthCheck(replacementServer);
  if (healthy) {
    log("✅ Server restarted successfully");
    consecutiveFailures = 0;

    // Cycle the tunnel so it gets a fresh connection
    if (shouldUseDevtunnel()) {
      try {
        tunnelCrashRestarts = 0; // reset since this is intentional
        const url = await startTunnel();
        await notifyWebhook(`🔄 Copilot Bridge restarted successfully (${tag()})`, url);
      } catch (err) {
        log(`Tunnel restart failed (non-fatal): ${err}`);
        await notifyWebhook(`🔄 Copilot Bridge restarted successfully (${tag()})`, currentTunnelUrl ?? undefined);
      }
    } else {
      await notifyWebhook(`🔄 Copilot Bridge restarted successfully (${tag()})`, currentTunnelUrl ?? undefined);
    }
  } else {
    log("❌ Health check failed — rolling back");
    await notifyWebhook(`⚠️ Health check failed — rolling back to last checkpoint (${tag()})`, currentTunnelUrl ?? undefined);
    const stoppedAfterFailure = await forceKillServerAndWait("Stopping failed restart before rollback...");
    if (!stoppedAfterFailure) {
      consecutiveFailures++;
      if (consecutiveFailures >= MAX_FAILURES) {
        log(`❌ ${MAX_FAILURES} consecutive failures — stopping`);
        process.exit(1);
      }
      return;
    }
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
  if (!canUseDevtunnelCli()) {
    const status = getDevtunnelCliStatus();
    return Promise.reject(new Error(status.reason ?? "Dev tunnel unavailable"));
  }

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

    tunnelProcess.stderr?.on("data", (data: Buffer) => {
      const line = data.toString().trim();
      if (line) log(`[tunnel] ${line}`);
    });

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
  if (shouldUseDevtunnel()) {
    try {
      const url = await startTunnel();
      await notifyWebhook(`🤖 Copilot Bridge is online! (${tag()})`, url);
    } catch (err) {
      log(`Tunnel/notification setup failed (non-fatal): ${err}`);
    }
  }

  // Poll for restart signal
  setInterval(async () => {
    if (!restarting && !recoveringServer && existsSync(SIGNAL_FILE)) {
      restarting = true;
      try {
        await restart();
      } finally {
        clearSignal();
        restarting = false;
        const followUpRecovery = evaluatePostRecoveryState({
          hasServerProcess: serverProcess !== null,
          restarting,
          recoveringServer,
          shuttingDown,
        });
        if (followUpRecovery) {
          recoverServer(followUpRecovery.reason, followUpRecovery.options);
        }
      }
    }
  }, POLL_INTERVAL);

  setInterval(() => {
    void pollServerHealth();
  }, HEALTH_POLL_INTERVAL);

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
