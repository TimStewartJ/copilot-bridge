import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDemoWorkspace, resetDemoWorkspace, type DemoPaths } from "./demo-workspace.js";

type DemoCommand = "start" | "seed" | "reset";

const MODULE_PATH = fileURLToPath(import.meta.url);
const __dirname = dirname(MODULE_PATH);
const ROOT = join(__dirname, "..", "..");
const TSX_CLI = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const VITE_CLI = join(ROOT, "node_modules", "vite", "bin", "vite.js");
const SERVER_ENTRY = join(ROOT, "src", "server", "index.ts");

function usage(exitCode = 1): never {
  console.error("Usage: npx tsx src/server/demo-cli.ts <start|seed|reset>");
  process.exit(exitCode);
}

function resolveCommand(raw?: string): DemoCommand {
  if (!raw) return "start";
  if (raw === "start" || raw === "seed" || raw === "reset") return raw;
  return usage();
}

function ensureLocalTooling(): void {
  if (!existsSync(TSX_CLI) || !existsSync(VITE_CLI)) {
    throw new Error("Local toolchain not found. Run npm install first.");
  }
}

function buildClientBundle(): void {
  console.log("[demo] Building client bundle...");
  const result = spawnSync(process.execPath, [VITE_CLI, "build"], {
    cwd: ROOT,
    env: process.env,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

export function createDemoServerEnv(
  baseEnv: NodeJS.ProcessEnv,
  paths: Pick<DemoPaths, "dataDir" | "docsDir" | "copilotHome">,
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    BRIDGE_DATA_DIR: paths.dataDir,
    BRIDGE_DOCS_DIR: paths.docsDir,
    COPILOT_HOME: paths.copilotHome,
    BRIDGE_DEMO_MODE: "true",
    BRIDGE_WEBHOOK_URL: "",
  };
}

function startServer(paths: Pick<DemoPaths, "dataDir" | "docsDir" | "copilotHome">): void {
  console.log(`[demo] Launching bridge with demo workspace at ${paths.dataDir}`);
  console.log("[demo] Open http://localhost:3333 and start with the pinned \"Start Here - Acme Launch Workspace\" task.");
  mkdirSync(paths.copilotHome, { recursive: true });

  const child = spawn(process.execPath, [TSX_CLI, SERVER_ENTRY], {
    cwd: ROOT,
    stdio: "inherit",
    env: createDemoServerEnv(process.env, paths),
  });

  const forwardSignal = (signal: NodeJS.Signals) => {
    if (!child.killed) child.kill(signal);
  };

  process.on("SIGINT", () => forwardSignal("SIGINT"));
  process.on("SIGTERM", () => forwardSignal("SIGTERM"));

  child.on("exit", (code) => {
    process.exit(code ?? 0);
  });
}

function printWorkspaceStatus(result: ReturnType<typeof ensureDemoWorkspace>, command: DemoCommand): void {
  const verb = result.reused ? "Reusing" : command === "reset" ? "Reset" : "Seeded";
  console.log(`[demo] ${verb} demo workspace at ${result.dataDir}`);
  if (command !== "start") {
    console.log("[demo] Run `npm run demo:start` to launch the sample workspace.");
  }
}

async function main(): Promise<void> {
  ensureLocalTooling();

  const command = resolveCommand(process.argv[2]);
  const workspace = command === "reset"
    ? resetDemoWorkspace(ROOT)
    : ensureDemoWorkspace(ROOT);

  printWorkspaceStatus(workspace, command);

  if (command === "start") {
    buildClientBundle();
    startServer(workspace);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === MODULE_PATH) {
  main().catch((error) => {
    console.error("[demo] Fatal:", error);
    process.exit(1);
  });
}
