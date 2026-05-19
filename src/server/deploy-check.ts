import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBridgeControlRoot } from "./control-root.js";
import { formatCommandDuration } from "./validation-command-log.js";

export const DEPLOY_CHECK_STEPS = [
  ["npm", "run", "check:pr"],
  ["npm", "run", "preview:smoke"],
] as const;

const LOG_TAIL_BYTES = 24_000;
const VALIDATION_LOG_DIR_ENV = "BRIDGE_VALIDATION_LOG_DIR";
type DeployCheckStep = typeof DEPLOY_CHECK_STEPS[number];
type DeployCheckStepResult = {
  step: DeployCheckStep;
  elapsedMs: number;
  logPath: string;
};
type OutputTail = {
  content: string;
  truncated: boolean;
};
type LogTailResult =
  | { ok: true; content: string }
  | { ok: false; error: string };

function npmCommand(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function sanitizeLogLabel(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "step";
}

function resolveLogDir(): string {
  const configured = process.env[VALIDATION_LOG_DIR_ENV]?.trim();
  if (configured) return resolve(configured);
  return join(resolveBridgeControlRoot(process.cwd()), "data", "validation-logs");
}

function ensureLogDir(): string {
  const dir = resolveLogDir();
  try {
    mkdirSync(dir, { recursive: true });
    return dir;
  } catch (error) {
    const fallback = join(tmpdir(), "copilot-bridge-validation-logs");
    mkdirSync(fallback, { recursive: true });
    console.error(`[check:deploy] unable to create validation log dir ${dir}: ${formatError(error)}`);
    console.error(`[check:deploy] falling back to ${fallback}`);
    return fallback;
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function appendOutputTail(tail: OutputTail, chunk: unknown): void {
  const text = Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : String(chunk);
  const combined = tail.content + text;
  if (combined.length > LOG_TAIL_BYTES) {
    tail.content = combined.slice(-LOG_TAIL_BYTES);
    tail.truncated = true;
    return;
  }
  tail.content = combined;
}

function renderOutputTail(tail: OutputTail): string {
  const content = tail.content.trimEnd();
  if (!content) return "(no captured command output)";
  return tail.truncated
    ? `[showing last ${LOG_TAIL_BYTES} captured characters]\n${content}`
    : content;
}

function readLogTail(path: string): LogTailResult {
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - LOG_TAIL_BYTES);
    const content = readFileSync(path).subarray(start).toString("utf-8");
    return {
      ok: true,
      content: start > 0 ? `[showing last ${LOG_TAIL_BYTES} bytes]\n${content}` : content,
    };
  } catch (error) {
    return { ok: false, error: formatError(error) };
  }
}

function printStepFailure(
  step: DeployCheckStep,
  elapsed: string,
  reason: string,
  logPath: string,
  captured: OutputTail,
  logWriteError?: Error,
): void {
  console.error(`[check:deploy] ${step.join(" ")} failed after ${elapsed} (${reason})`);
  console.error(`[check:deploy] full log: ${logPath}`);
  if (logWriteError) {
    console.error(`[check:deploy] log write warning: ${logWriteError.message}`);
  }
  const logTail = readLogTail(logPath);
  if (logTail.ok) {
    console.error(logTail.content);
    return;
  }
  console.error(`[check:deploy] unable to read log tail: ${logTail.error}`);
  console.error(renderOutputTail(captured));
}

function runStep(step: DeployCheckStep, stepIndex: number, totalSteps: number): Promise<DeployCheckStepResult> {
  return new Promise((resolve, reject) => {
    const dir = ensureLogDir();
    const label = sanitizeLogLabel(step.join("-"));
    const logPath = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-deploy-check-${stepIndex + 1}-${label}.log`);
    const out = createWriteStream(logPath);
    const startedAt = Date.now();
    const command = step[0] === "npm" ? npmCommand() : step[0];
    const shell = process.platform === "win32";
    let settled = false;
    let logWriteError: Error | undefined;
    const captured: OutputTail = { content: "", truncated: false };
    console.log(`[check:deploy] ${stepIndex + 1}/${totalSteps}: ${step.join(" ")} (log: ${logPath})`);
    const child = spawn(command, step.slice(1), {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell,
      windowsHide: true,
    });

    const settle = (complete: () => void): void => {
      if (settled) return;
      settled = true;
      if (out.destroyed || logWriteError) {
        complete();
        return;
      }
      out.end(complete);
    };

    const handleOutput = (chunk: unknown): void => {
      appendOutputTail(captured, chunk);
      if (logWriteError || out.destroyed) return;
      out.write(chunk);
    };

    child.stdout?.on("data", handleOutput);
    child.stderr?.on("data", handleOutput);
    out.on("error", (error) => {
      logWriteError = error;
    });
    child.on("error", (error) => {
      const elapsedMs = Date.now() - startedAt;
      const elapsed = formatCommandDuration(elapsedMs);
      settle(() => {
        printStepFailure(step, elapsed, `spawn error: ${formatError(error)}`, logPath, captured, logWriteError);
        reject(error);
      });
    });
    child.on("close", (code, signal) => {
      const elapsedMs = Date.now() - startedAt;
      const elapsed = formatCommandDuration(elapsedMs);
      settle(() => {
        if (code === 0) {
          console.log(`[check:deploy] ${step.join(" ")} passed in ${elapsed}`);
          resolve({ step, elapsedMs, logPath });
          return;
        }
        const reason = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
        printStepFailure(step, elapsed, reason, logPath, captured, logWriteError);
        reject(new Error(`${step.join(" ")} failed (${reason})`));
      });
    });
  });
}

function formatStepSummary(results: DeployCheckStepResult[]): string {
  return results
    .map(({ step, elapsedMs }, index) => `${index + 1}. ${step.join(" ")} ${formatCommandDuration(elapsedMs)}`)
    .join("; ");
}

export async function runDeployChecks(
  steps: readonly DeployCheckStep[] = DEPLOY_CHECK_STEPS,
): Promise<DeployCheckStepResult[]> {
  const startedAt = Date.now();
  console.log(`[check:deploy] starting ${steps.length} deploy check step(s)`);
  const results: DeployCheckStepResult[] = [];
  for (const [index, step] of steps.entries()) {
    results.push(await runStep(step, index, steps.length));
  }

  const totalElapsedMs = Date.now() - startedAt;
  const stepSummary = formatStepSummary(results);
  console.log(
    `[check:deploy] all deploy checks passed in ${formatCommandDuration(totalElapsedMs)}`
      + (stepSummary ? ` (${stepSummary})` : ""),
  );
  return results;
}

function isDirectRun(): boolean {
  const entrypoint = process.argv[1];
  return Boolean(entrypoint) && fileURLToPath(import.meta.url) === resolve(entrypoint);
}

if (isDirectRun()) {
  await runDeployChecks();
}
