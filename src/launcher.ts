// Launcher — immortal parent process that manages the bridge server
// This file should NEVER be modified by the agent.

import { spawn, execSync, type ChildProcess } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SIGNAL_FILE = join(ROOT, "data", "restart.signal");
const SERVER_ENTRY = join(ROOT, "src", "server", "index.ts");
const PORT = 3333;
const HEALTH_URL = `http://localhost:${PORT}/api/sessions`;
const MAX_FAILURES = 3;
const POLL_INTERVAL = 2_000;
const HEALTH_TIMEOUT = 30_000;

// Teams notification config
const TUNNEL_NAME = "copilot-bridge";
const TEAMS_TEAM_ID = "EXAMPLE-TEAM-GUID";
const TEAMS_CHANNEL_ID = "EXAMPLE-CHANNEL-ID";
const TEAMS_MCP_PORT = 5556; // separate port from any other MCP usage

const BUSY_CHECK_INTERVAL = 3_000;
const BUSY_WAIT_TIMEOUT = 300_000; // 5 minutes max wait

let serverProcess: ChildProcess | null = null;
let tunnelProcess: ChildProcess | null = null;
let mcpProcess: ChildProcess | null = null;
let currentTunnelUrl: string | null = null;
let consecutiveFailures = 0;
let restarting = false;

function log(msg: string) {
  console.log(`[launcher] ${msg}`);
}

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

function gitCheckpoint(): boolean {
  run("git add -A");
  const status = run("git --no-pager status --porcelain");
  if (status.output.trim()) {
    const result = run('git commit -m "auto-checkpoint before restart"');
    log(result.ok ? "Git checkpoint created" : "Git checkpoint failed (continuing anyway)");
  } else {
    log("No changes to checkpoint");
  }
  return true;
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

function rollback() {
  log("Rolling back to last checkpoint...");
  run("git reset --hard HEAD");
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
  const child = spawn("npx", ["tsx", SERVER_ENTRY], {
    cwd: ROOT,
    stdio: ["ignore", "inherit", "inherit"],
    shell: true,
  });

  child.on("exit", (code) => {
    log(`Server exited with code ${code}`);
    if (serverProcess === child) {
      serverProcess = null;
    }
  });

  return child;
}

function killServer() {
  if (serverProcess) {
    log("Stopping server...");
    serverProcess.kill();
    serverProcess = null;
  }
}

async function waitForIdleSessions(): Promise<boolean> {
  const busyUrl = `http://localhost:${PORT}/api/sessions/busy`;
  const start = Date.now();

  try {
    const initial = await fetch(busyUrl);
    if (initial.ok) {
      const data = await initial.json() as any;
      if (!data.busy) return true;
      log(`Waiting for ${data.count} active session(s) to finish: ${data.sessionIds.map((id: string) => id.slice(0, 8)).join(", ")}`);
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
        const elapsed = Math.floor((Date.now() - start) / 1000);
        log(`Still waiting for ${data.count} active session(s)... (${elapsed}s)`);
      }
    } catch {
      log("Server became unreachable during busy wait — proceeding with restart");
      return true;
    }
  }

  log(`⚠️ Timed out after ${BUSY_WAIT_TIMEOUT / 1000}s waiting for sessions — proceeding with restart`);
  return true;
}

async function restart() {
  log("═══ Restart requested ═══");

  await waitForIdleSessions();

  gitCheckpoint();

  if (!build()) {
    log("Build failed — rolling back");
    rollback();
    consecutiveFailures++;
    if (consecutiveFailures >= MAX_FAILURES) {
      log(`❌ ${MAX_FAILURES} consecutive failures — stopping`);
      process.exit(1);
    }
    return;
  }

  killServer();
  serverProcess = startServer();

  const healthy = await healthCheck();
  if (healthy) {
    log("✅ Server restarted successfully");
    consecutiveFailures = 0;

    // Notify Teams about restart
    if (currentTunnelUrl) {
      try {
        await startTeamsMcp();
        await notifyTeams("🔄 Copilot Bridge restarted successfully", currentTunnelUrl);
        killTeamsMcp();
      } catch { /* best-effort */ }
    }
  } else {
    log("❌ Health check failed — rolling back");
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
  return new Promise((resolve, reject) => {
    log("Starting dev tunnel...");
    tunnelProcess = spawn("devtunnel", ["host", TUNNEL_NAME], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
    });

    let stdout = "";
    const timeout = setTimeout(() => {
      reject(new Error("Tunnel failed to start within 30s"));
    }, 30_000);

    tunnelProcess.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
      // Look for the URL: "Connect via browser: https://xxx-3333.usw2.devtunnels.ms"
      const match = stdout.match(/Connect via browser:\s+(https:\/\/\S+)/);
      if (match) {
        clearTimeout(timeout);
        currentTunnelUrl = match[1];
        log(`Tunnel URL: ${currentTunnelUrl}`);
        resolve(currentTunnelUrl);
      }
    });

    tunnelProcess.on("exit", (code) => {
      log(`Tunnel exited with code ${code}`);
      tunnelProcess = null;
    });
  });
}

function killTunnel() {
  if (tunnelProcess) {
    log("Stopping tunnel...");
    tunnelProcess.kill();
    tunnelProcess = null;
  }
}

// ── Teams MCP Notification ────────────────────────────────────────

async function startTeamsMcp(): Promise<void> {
  return new Promise((resolve) => {
    mcpProcess = spawn("mcp-remote", ["mcp", "teams", "--transport", "http", "--port", String(TEAMS_MCP_PORT)], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
    });

    // Poll until ready
    const check = setInterval(async () => {
      try {
        const res = await fetch(`http://localhost:${TEAMS_MCP_PORT}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
        });
        if (res.ok) {
          clearInterval(check);
          resolve();
        }
      } catch {}
    }, 1_000);

    // Give up after 30s
    setTimeout(() => {
      clearInterval(check);
      resolve(); // resolve anyway — notification is best-effort
    }, 30_000);
  });
}

function killTeamsMcp() {
  if (mcpProcess) {
    mcpProcess.kill();
    mcpProcess = null;
  }
}

async function notifyTeams(message: string, url?: string): Promise<void> {
  try {
    let content = message;
    let contentType = "text";

    if (url) {
      content = `${message}<br><a href="${url}">${url}</a>`;
      contentType = "html";
    }

    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "PostChannelMessage",
        arguments: {
          teamId: TEAMS_TEAM_ID,
          channelId: TEAMS_CHANNEL_ID,
          content,
          contentType,
        },
      },
    });

    const res = await fetch(`http://localhost:${TEAMS_MCP_PORT}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    if (res.ok) {
      log("Teams notification sent");
    } else {
      log(`Teams notification failed: ${res.status}`);
    }
  } catch (err) {
    log(`Teams notification error: ${err}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────

async function main() {
  console.log("╔════════════════════════════════════════╗");
  console.log("║      Copilot Bridge Launcher           ║");
  console.log("╚════════════════════════════════════════╝");
  console.log();

  clearSignal();

  // Start server
  serverProcess = startServer();

  // Start dev tunnel
  try {
    const url = await startTunnel();

    // Start Teams MCP and notify channel
    log("Starting Teams MCP for notifications...");
    await startTeamsMcp();
    await notifyTeams("🤖 Copilot Bridge is online!", url);
    killTeamsMcp(); // only needed for notifications, don't keep running
  } catch (err) {
    log(`Tunnel/notification setup failed (non-fatal): ${err}`);
  }

  // Poll for restart signal
  setInterval(async () => {
    if (!restarting && existsSync(SIGNAL_FILE)) {
      clearSignal();
      restarting = true;
      try {
        await restart();
      } finally {
        restarting = false;
      }
    }
  }, POLL_INTERVAL);

  log("Watching for restart signals...");
}

process.on("SIGINT", () => {
  log("Shutting down...");
  killServer();
  killTunnel();
  killTeamsMcp();
  process.exit(0);
});

process.on("SIGTERM", () => {
  killServer();
  killTunnel();
  killTeamsMcp();
  process.exit(0);
});

main().catch((err) => {
  console.error("[launcher] Fatal:", err);
  process.exit(1);
});
