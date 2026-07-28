import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createRetentionSweepScheduler,
  pruneRetainedLogFiles,
  resolveLogRetentionPolicy,
  RETENTION_DAY_MS,
  type LogRetentionPolicy,
} from "./log-retention.js";

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

export const VALIDATION_LOG_DIR_ENV = "BRIDGE_VALIDATION_LOG_DIR";
/**
 * Set by the Vitest harness. Background sweeps fire as a side effect of writing a
 * log, so a test that exercises a real code path with a real root directory would
 * otherwise delete real logs. Explicit `pruneValidationCommandLogs` calls still run.
 */
export const DISABLE_BACKGROUND_SWEEP_ENV = "BRIDGE_DISABLE_BACKGROUND_LOG_RETENTION";
export const VALIDATION_LOG_MAX_AGE_DAYS_ENV = "BRIDGE_VALIDATION_LOG_MAX_AGE_DAYS";
export const VALIDATION_LOG_MAX_COUNT_ENV = "BRIDGE_VALIDATION_LOG_MAX_COUNT";
export const DEFAULT_VALIDATION_LOG_MAX_AGE_DAYS = 14;
export const DEFAULT_VALIDATION_LOG_MAX_COUNT = 5_000;
/** Transient stdout/stderr capture files; only crash leftovers survive to be swept. */
export const VALIDATION_LOG_TEMP_DIR_NAME = ".tmp";
/**
 * Validation logs are streamed to for the whole life of a command, sometimes from
 * another process (deploy validation runs in its own CLI). Nothing written in the
 * last few hours is deleted, so a sweep can never unlink a log that still has an
 * open writer — even one that has been silent for a long time.
 */
export const DEFAULT_VALIDATION_LOG_GRACE_MS = 6 * 60 * 60_000;
const VALIDATION_LOG_TEMP_MAX_AGE_MS = RETENTION_DAY_MS;
const VALIDATION_LOG_SWEEP_MIN_INTERVAL_MS = 10 * 60_000;
const VALIDATION_LOG_NAME_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-/;

export interface ValidationCommandLogRetentionOptions {
  rootDir?: string;
  logDir?: string;
  policy?: Partial<LogRetentionPolicy>;
  env?: NodeJS.ProcessEnv;
  nowMs?: number;
  graceMs?: number;
}

export interface ValidationCommandLogPruneResult {
  logDir: string;
  scanned: number;
  deleted: number;
  skippedRecent: number;
  failed: number;
}

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

export function resolveValidationCommandLogRetentionPolicy(
  env: NodeJS.ProcessEnv = process.env,
  overrides?: Partial<LogRetentionPolicy>,
): LogRetentionPolicy {
  return resolveLogRetentionPolicy({
    env,
    maxAgeDaysEnvKey: VALIDATION_LOG_MAX_AGE_DAYS_ENV,
    maxCountEnvKey: VALIDATION_LOG_MAX_COUNT_ENV,
    defaultMaxAgeDays: DEFAULT_VALIDATION_LOG_MAX_AGE_DAYS,
    defaultMaxCount: DEFAULT_VALIDATION_LOG_MAX_COUNT,
    overrides,
  });
}

/** Reads the write time out of the Bridge-owned filename to avoid a stat per log. */
export function parseValidationCommandLogTimestamp(name: string): number | null {
  const match = VALIDATION_LOG_NAME_TIMESTAMP.exec(name);
  if (!match) return null;
  const timestampMs = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
    Number(match[7]),
  );
  return Number.isFinite(timestampMs) ? timestampMs : null;
}

function isValidationCommandLogName(name: string): boolean {
  return name.endsWith(".log");
}

function resolveRetentionLogDir(options: ValidationCommandLogRetentionOptions): string {
  if (options.logDir) return options.logDir;
  if (options.rootDir) return getValidationCommandLogDir(options.rootDir);
  throw new Error("Validation command log retention requires a rootDir or logDir");
}

/**
 * Applies the age + count caps to a validation log directory. Files still being
 * appended to are protected by the shared grace window, and the transient
 * `.tmp` capture directory is swept by age only so crash leftovers cannot pile up.
 */
export async function pruneValidationCommandLogs(
  options: ValidationCommandLogRetentionOptions,
): Promise<ValidationCommandLogPruneResult> {
  const logDir = resolveRetentionLogDir(options);
  const policy = resolveValidationCommandLogRetentionPolicy(options.env, options.policy);
  const graceMs = options.graceMs ?? DEFAULT_VALIDATION_LOG_GRACE_MS;
  const logs = await pruneRetainedLogFiles({
    dir: logDir,
    policy,
    nowMs: options.nowMs,
    graceMs,
    isEligible: isValidationCommandLogName,
    timestampFromName: parseValidationCommandLogTimestamp,
  });
  const temp = await pruneRetainedLogFiles({
    dir: join(logDir, VALIDATION_LOG_TEMP_DIR_NAME),
    policy: {
      maxAgeMs: Math.min(policy.maxAgeMs, VALIDATION_LOG_TEMP_MAX_AGE_MS),
      maxCount: Number.POSITIVE_INFINITY,
    },
    nowMs: options.nowMs,
    graceMs,
  });

  return {
    logDir,
    scanned: logs.scanned + temp.scanned,
    deleted: logs.deleted.length + temp.deleted.length,
    skippedRecent: logs.skippedRecent + temp.skippedRecent,
    failed: logs.failed + temp.failed,
  };
}

const validationCommandLogSweeps = createRetentionSweepScheduler(
  (logDir: string) => pruneValidationCommandLogs({ logDir }),
  { minIntervalMs: VALIDATION_LOG_SWEEP_MIN_INTERVAL_MS },
);

/**
 * Best-effort background sweep. Rate-limited per directory so a long-running
 * process converges without paying a readdir on every failed command.
 */
export function scheduleValidationCommandLogSweep(
  logDir: string,
  options: { force?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<ValidationCommandLogPruneResult | null> {
  const env = options.env ?? process.env;
  if (env[DISABLE_BACKGROUND_SWEEP_ENV]?.trim()) return Promise.resolve(null);
  return validationCommandLogSweeps.run(logDir, options);
}

export function resetValidationCommandLogSweepThrottle(logDir?: string): void {
  validationCommandLogSweeps.reset(logDir);
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
    void scheduleValidationCommandLogSweep(logDir).catch(() => {
      // Retention is best-effort; the next sweep retries.
    });
    return { path: logPath };
  } catch (error) {
    return { error: formatValidationCommandLogError(error) };
  }
}
