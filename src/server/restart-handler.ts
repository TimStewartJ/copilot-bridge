// Restart handler — polls for restart signal, handles git checkpoint + build + rollback
// Runs inside the server process. On successful build, exits with code 0 so PM2 restarts.

import { execSync, spawn } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const SIGNAL_FILE = join(ROOT, "data", "restart.signal");
const POLL_INTERVAL = 2_000;
const BUSY_CHECK_INTERVAL = 3_000;
const BUSY_WAIT_TIMEOUT = 600_000; // 10 minutes
const PORT = 3333;

const WEBHOOK_URL = process.env.BRIDGE_WEBHOOK_URL || "";
const TUNNEL_NAME = "copilot-bridge";

function log(msg: string) {
  console.log(`[restart] ${msg}`);
}

function discoverTunnelUrl(): string | undefined {
  try {
    const output = execSync(`devtunnel show ${TUNNEL_NAME}`, { encoding: "utf-8", timeout: 10_000 });
    const match = output.match(/(https:\/\/\S+)/);
    return match?.[1]?.replace(/\/$/, "");
  } catch { return undefined; }
}

let tunnelUrl: string | undefined;

function run(cmd: string): { ok: boolean; output: string } {
  try {
    const output = execSync(cmd, { cwd: ROOT, encoding: "utf-8", timeout: 120_000 });
    return { ok: true, output };
  } catch (err: any) {
    return { ok: false, output: err.stderr || err.stdout || String(err) };
  }
}

function gitHash(): string {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: ROOT, encoding: "utf-8", timeout: 5_000 }).trim();
  } catch { return "unknown"; }
}

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

function clearSignal() {
  try { if (existsSync(SIGNAL_FILE)) unlinkSync(SIGNAL_FILE); } catch {}
}

function gitCheckpoint(): void {
  run("git add -A");
  const status = run("git --no-pager status --porcelain");
  if (status.output.trim()) {
    const result = run('git commit -m "auto-checkpoint before restart"');
    log(result.ok ? "Git checkpoint created" : "Git checkpoint failed (continuing anyway)");
  } else {
    log("No changes to checkpoint");
  }
}

function build(): boolean {
  log("Building...");
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

function rollback(): void {
  log("Rolling back to last checkpoint...");
  run("git reset --hard HEAD");
  run("npx vite build");
  log("Rollback complete");
}

async function waitForIdleSessions(): Promise<void> {
  const busyUrl = `http://localhost:${PORT}/api/busy`;
  const start = Date.now();

  try {
    const initial = await fetch(busyUrl);
    if (initial.ok) {
      const data = await initial.json() as any;
      if (!data.busy) return;
      log(`Waiting for ${data.count} active session(s) to finish...`);
    }
  } catch {
    return; // server not reachable, proceed
  }

  while (Date.now() - start < BUSY_WAIT_TIMEOUT) {
    await new Promise((r) => setTimeout(r, BUSY_CHECK_INTERVAL));
    try {
      const res = await fetch(busyUrl);
      if (res.ok) {
        const data = await res.json() as any;
        if (!data.busy) {
          log("All sessions idle — proceeding with restart");
          return;
        }
        const elapsed = Math.floor((Date.now() - start) / 1000);
        log(`Still waiting for ${data.count} active session(s)... (${elapsed}s)`);
      }
    } catch {
      return;
    }
  }

  log(`⚠️ Timed out after ${BUSY_WAIT_TIMEOUT / 1000}s — proceeding with restart`);
}

async function handleRestart(): Promise<void> {
  log("═══ Restart requested ═══");

  await waitForIdleSessions();
  gitCheckpoint();

  if (!build()) {
    log("Build failed — rolling back");
    await notifyWebhook(`⚠️ Build failed — rolling back (${gitHash()}, PID ${process.pid})`, tunnelUrl);    rollback();
    return; // don't exit — keep running on rolled-back code
  }

  // Build succeeded — spawn new server and exit
  await notifyWebhook(`🔄 Copilot Bridge restarting (${gitHash()}, PID ${process.pid})`, tunnelUrl);
  log("Build succeeded — spawning new server and exiting");

  // Spawn replacement server (detached, survives our exit)
  const child = spawn(process.execPath, [join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), join(ROOT, "src", "server", "index.ts")], {
    cwd: ROOT,
    stdio: "ignore",
    detached: true,
    env: process.env,
  });
  child.unref();

  process.exit(0);
}

let restarting = false;

export function startRestartWatcher(): void {
  clearSignal();

  // Discover tunnel URL once at startup
  tunnelUrl = process.env.BRIDGE_TUNNEL_URL || discoverTunnelUrl();
  if (tunnelUrl) {
    log(`Tunnel URL: ${tunnelUrl}`);
  }

  // Poll for restart signal
  setInterval(async () => {
    if (!restarting && existsSync(SIGNAL_FILE)) {
      clearSignal();
      restarting = true;
      try {
        await handleRestart();
      } finally {
        restarting = false;
      }
    }
  }, POLL_INTERVAL);

  // Tunnel health check — auto-restart if dead
  let tunnelFailures = 0;
  const TUNNEL_CHECK_INTERVAL = 60_000;
  const TUNNEL_MAX_FAILURES = 3;

  if (tunnelUrl) {
    setInterval(async () => {
      try {
        const res = await fetch(tunnelUrl + "/api/busy", { signal: AbortSignal.timeout(10_000) });
        if (res.ok) {
          if (tunnelFailures > 0) log(`Tunnel recovered after ${tunnelFailures} failure(s)`);
          tunnelFailures = 0;
        } else {
          tunnelFailures++;
        }
      } catch {
        tunnelFailures++;
      }

      if (tunnelFailures >= TUNNEL_MAX_FAILURES) {
        log(`⚠️ Tunnel dead (${tunnelFailures} consecutive failures) — restarting`);
        tunnelFailures = 0;

        // Kill existing devtunnel
        try {
          execSync('wmic process where "name=\'devtunnel.exe\' and commandline like \'%copilot-bridge%\'" call terminate', { timeout: 10_000, stdio: "ignore" });
        } catch { /* may not exist */ }

        // Spawn new devtunnel (detached)
        const dt = spawn("devtunnel", ["host", TUNNEL_NAME], {
          stdio: "ignore",
          detached: true,
          shell: true,
        });
        dt.unref();
        log("Tunnel respawned");

        // Re-discover URL after a brief delay
        setTimeout(async () => {
          const newUrl = discoverTunnelUrl();
          if (newUrl) {
            tunnelUrl = newUrl;
            log(`Tunnel URL: ${tunnelUrl}`);
            await notifyWebhook(`🔗 Tunnel auto-restarted`, tunnelUrl);
          }
        }, 10_000);
      }
    }, TUNNEL_CHECK_INTERVAL);
    log("Tunnel health check enabled (60s interval)");
  }

  log("Watching for restart signals...");
}

export function getTunnelUrl(): string | undefined {
  return tunnelUrl;
}

export { notifyWebhook, gitHash, discoverTunnelUrl };
