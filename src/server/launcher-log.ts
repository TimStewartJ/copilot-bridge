import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBridgeControlRoot } from "./control-root.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolveBridgeControlRoot(join(__dirname, "..", ".."));
const DEFAULT_LAUNCHER_LOG_PATH = join(ROOT, "data", "launcher.log");
const DEFAULT_LAUNCHER_TAIL_LINES = 8;
const MAX_LAUNCHER_TAIL_LINES = 50;
const MAX_LAUNCHER_LOG_BYTES = 128 * 1024;
const TRIMMED_LAUNCHER_LOG_BYTES = 96 * 1024;

export interface LauncherLogTailOk {
  status: "ok";
  lines: string[];
}

export interface LauncherLogTailUnavailable {
  status: "unavailable";
  error: string;
}

export type LauncherLogTail = LauncherLogTailOk | LauncherLogTailUnavailable;

function timestamp(): string {
  return new Date().toISOString().slice(11, 23);
}

function clampLineCount(lines?: number): number {
  if (!Number.isFinite(lines)) return DEFAULT_LAUNCHER_TAIL_LINES;
  return Math.min(MAX_LAUNCHER_TAIL_LINES, Math.max(1, Math.floor(lines!)));
}

function formatLogPersistenceError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function trimLauncherLogFile(logPath: string): void {
  if (!existsSync(logPath)) return;
  const content = readFileSync(logPath);
  if (content.byteLength <= MAX_LAUNCHER_LOG_BYTES) return;

  const tail = content.subarray(
    Math.max(0, content.byteLength - TRIMMED_LAUNCHER_LOG_BYTES),
  );
  let trimmed = tail.toString("utf-8");
  const firstNewline = trimmed.indexOf("\n");
  if (firstNewline >= 0) {
    trimmed = trimmed.slice(firstNewline + 1);
  }
  writeFileSync(logPath, trimmed, "utf-8");
}

export function getLauncherLogPath(): string {
  return process.env.BRIDGE_LAUNCHER_LOG_PATH || DEFAULT_LAUNCHER_LOG_PATH;
}

export function appendLauncherLogLine(line: string): void {
  const logPath = getLauncherLogPath();
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    trimLauncherLogFile(logPath);
    const entry = line
      .split(/\r?\n/)
      .map((part) => `[${timestamp()}] ${part}`)
      .join("\n");
    appendFileSync(logPath, `${entry}\n`, "utf-8");
  } catch (error) {
    process.stderr.write(
      `[${timestamp()}] [launcher] Failed to persist launcher log: ${formatLogPersistenceError(error)}\n`,
    );
  }
}

export function readLauncherLogTail(
  logPath = getLauncherLogPath(),
  options: { lines?: number } = {},
): LauncherLogTail {
  const lineLimit = clampLineCount(options.lines);
  try {
    const content = readFileSync(logPath, "utf-8");
    return {
      status: "ok",
      lines: content.split(/\r?\n/).filter(Boolean).slice(-lineLimit),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        status: "unavailable",
        error: "Launcher log is not available yet. Restart the bridge through the launcher to populate it.",
      };
    }
    return {
      status: "unavailable",
      error: formatLogPersistenceError(error),
    };
  }
}
