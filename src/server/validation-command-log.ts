import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface CommandFailureOutputOptions {
  output: string;
  elapsedMs: number;
  timedOut: boolean;
  timeoutMs: number;
  logPath?: string;
  logWriteError?: string;
}

interface ValidationCommandLogOptions {
  rootDir: string;
  source: string;
  command: string;
  cwd: string;
  output: string;
  elapsedMs: number;
  timedOut: boolean;
  timeoutMs: number;
}

export interface ValidationCommandLogResult {
  path?: string;
  error?: string;
}

export function isCommandTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; signal?: unknown };
  return candidate.code === "ETIMEDOUT" || candidate.signal === "SIGTERM";
}

export function formatCommandDuration(elapsedMs: number): string {
  if (elapsedMs < 1_000) return `${elapsedMs}ms`;
  return `${(elapsedMs / 1_000).toFixed(1)}s`;
}

function normalizeSection(section: string | undefined): string | undefined {
  const trimmed = section?.trim();
  return trimmed ? trimmed : undefined;
}

function joinSections(...sections: Array<string | undefined>): string {
  return sections
    .map(normalizeSection)
    .filter((section): section is string => Boolean(section))
    .join("\n\n");
}

function sanitizeFilePart(value: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return sanitized || "command";
}

function formatLogError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function buildCommandFailureOutput({
  output,
  elapsedMs,
  timedOut,
  timeoutMs,
  logPath,
  logWriteError,
}: CommandFailureOutputOptions): string {
  return joinSections(
    output,
    `Command failed after ${formatCommandDuration(elapsedMs)}.`,
    timedOut ? `Command timed out after ${Math.ceil(timeoutMs / 1_000)} seconds.` : undefined,
    logPath ? `Full command output: ${logPath}` : undefined,
    logWriteError ? `Unable to write full command output: ${logWriteError}` : undefined,
  );
}

export function writeValidationCommandLog({
  rootDir,
  source,
  command,
  cwd,
  output,
  elapsedMs,
  timedOut,
  timeoutMs,
}: ValidationCommandLogOptions): ValidationCommandLogResult {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${timestamp}-${sanitizeFilePart(source)}-${sanitizeFilePart(command)}.log`;
  const logDir = join(rootDir, "data", "validation-logs");
  const logPath = join(logDir, filename);
  const content = [
    "Validation command failure",
    `Source: ${source}`,
    `Command: ${command}`,
    `Working directory: ${cwd}`,
    `Elapsed: ${formatCommandDuration(elapsedMs)}`,
    `Timeout: ${Math.ceil(timeoutMs / 1_000)}s`,
    `Timed out: ${timedOut ? "yes" : "no"}`,
    "",
    "Output:",
    output,
    "",
  ].join("\n");

  try {
    mkdirSync(logDir, { recursive: true });
    writeFileSync(logPath, content);
    return { path: logPath };
  } catch (error) {
    return { error: formatLogError(error) };
  }
}
