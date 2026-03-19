// Launcher — immortal parent process that manages the bridge server
// This file should NEVER be modified by the agent.

import { spawn, execSync, type ChildProcess } from "node:child_process";
import { existsSync, unlinkSync, readFileSync } from "node:fs";
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

let serverProcess: ChildProcess | null = null;
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

async function restart() {
  log("═══ Restart requested ═══");

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

// ── Main ──────────────────────────────────────────────────────────

async function main() {
  console.log("╔════════════════════════════════════════╗");
  console.log("║      Copilot Bridge Launcher           ║");
  console.log("╚════════════════════════════════════════╝");
  console.log();

  clearSignal();
  serverProcess = startServer();

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
  process.exit(0);
});

process.on("SIGTERM", () => {
  killServer();
  process.exit(0);
});

main().catch((err) => {
  console.error("[launcher] Fatal:", err);
  process.exit(1);
});
