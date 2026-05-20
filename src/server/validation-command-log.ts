import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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

type ValidationCommandLogPathOptions = {
  source: string;
  command: string;
  now?: Date;
} & (
  | { rootDir: string; logDir?: undefined }
  | { rootDir?: string; logDir: string }
);

export interface ValidationCommandLogResult {
  path?: string;
  error?: string;
}

export type ValidationCommandLogTailResult =
  | { ok: true; content: string }
  | { ok: false; error: string };

const FULL_COMMAND_OUTPUT_PREFIX = "Full command output:";
const FULL_COMMAND_OUTPUT_WRITE_ERROR_PREFIX = "Unable to write full command output:";

export function isCommandTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown };
  return candidate.code === "ETIMEDOUT";
}

export function isCommandTimeoutResult(options: {
  error?: unknown;
  signal?: unknown;
  elapsedMs: number;
  timeoutMs: number;
}): boolean {
  if (isCommandTimeoutError(options.error)) return true;
  return options.signal === "SIGTERM" && options.elapsedMs >= options.timeoutMs;
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

export function formatValidationCommandLogError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function getValidationCommandLogDir(rootDir: string): string {
  return join(rootDir, "data", "validation-logs");
}

export function buildValidationCommandLogPath({
  rootDir,
  logDir,
  source,
  command,
  now = new Date(),
}: ValidationCommandLogPathOptions): string {
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  const filename = `${timestamp}-${sanitizeFilePart(source)}-${sanitizeFilePart(command)}.log`;
  return join(logDir ?? getValidationCommandLogDir(rootDir), filename);
}

export function readValidationCommandLogTail(path: string, maxBytes: number): string {
  const size = statSync(path).size;
  const start = Math.max(0, size - maxBytes);
  const content = readFileSync(path).subarray(start).toString("utf-8");
  return start > 0 ? `[showing last ${maxBytes} bytes]\n${content}` : content;
}

export function tryReadValidationCommandLogTail(path: string, maxBytes: number): ValidationCommandLogTailResult {
  try {
    return { ok: true, content: readValidationCommandLogTail(path, maxBytes) };
  } catch (error) {
    return { ok: false, error: formatValidationCommandLogError(error) };
  }
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

function formatLabeledSection(label: string, value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed ? `${label}:\n${trimmed}` : undefined;
}

export function formatCommandFailureStreams({
  stdout,
  stderr,
  errorMessage,
  fallback,
}: {
  stdout?: string;
  stderr?: string;
  errorMessage?: string;
  fallback: string;
}): string {
  const stdoutText = stdout?.trim() ?? "";
  const stderrText = stderr?.trim() ?? "";
  const errorText = errorMessage?.trim() ?? "";
  if (!stdoutText && !stderrText && !errorText) return fallback;
  if (stdoutText && !stderrText && !errorText) return joinSections(stdoutText, fallback);
  if (stderrText && !stdoutText && !errorText) return joinSections(stderrText, fallback);

  return joinSections(
    formatLabeledSection("failure", fallback),
    formatLabeledSection("stderr", stderrText),
    formatLabeledSection("stdout", stdoutText),
    formatLabeledSection("error", errorText),
  ) || fallback;
}

function extractPrefixedLineValue(output: string, prefix: string): string | undefined {
  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith(prefix)) continue;
    const value = line.slice(prefix.length).trim();
    return value || undefined;
  }
  return undefined;
}

export function extractCommandFailureLogPath(output: string): string | undefined {
  return extractPrefixedLineValue(output, FULL_COMMAND_OUTPUT_PREFIX);
}

export function extractCommandFailureLogWriteError(output: string): string | undefined {
  return extractPrefixedLineValue(output, FULL_COMMAND_OUTPUT_WRITE_ERROR_PREFIX);
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
  const logDir = getValidationCommandLogDir(rootDir);
  const logPath = buildValidationCommandLogPath({ rootDir, source, command });
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
    return { error: formatValidationCommandLogError(error) };
  }
}
