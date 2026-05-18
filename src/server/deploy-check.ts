import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatCommandDuration } from "./validation-command-log.js";

export const DEPLOY_CHECK_STEPS = [
  ["npm", "run", "check:pr"],
  ["npm", "run", "preview:smoke"],
] as const;

const LOG_TAIL_BYTES = 24_000;
type DeployCheckStep = typeof DEPLOY_CHECK_STEPS[number];
type DeployCheckStepResult = {
  step: DeployCheckStep;
  elapsedMs: number;
  logPath: string;
};

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

function logDir(): string {
  return join(process.cwd(), "data", "validation-logs");
}

function readLogTail(path: string): string {
  const size = statSync(path).size;
  const start = Math.max(0, size - LOG_TAIL_BYTES);
  const content = readFileSync(path).subarray(start).toString("utf-8");
  return start > 0 ? `[showing last ${LOG_TAIL_BYTES} bytes]\n${content}` : content;
}

function runStep(step: DeployCheckStep, stepIndex: number, totalSteps: number): Promise<DeployCheckStepResult> {
  return new Promise((resolve, reject) => {
    const dir = logDir();
    mkdirSync(dir, { recursive: true });
    const label = sanitizeLogLabel(step.join("-"));
    const logPath = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-deploy-check-${stepIndex + 1}-${label}.log`);
    const out = createWriteStream(logPath);
    const startedAt = Date.now();
    const command = step[0] === "npm" ? npmCommand() : step[0];
    const shell = process.platform === "win32";
    let settled = false;
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
      child.stdout?.unpipe(out);
      child.stderr?.unpipe(out);
      out.end(complete);
    };

    child.stdout?.pipe(out, { end: false });
    child.stderr?.pipe(out, { end: false });
    out.on("error", (error) => {
      if (settled) return;
      settled = true;
      child.stdout?.unpipe(out);
      child.stderr?.unpipe(out);
      reject(error);
    });
    child.on("error", (error) => {
      settle(() => reject(error));
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
        console.error(`[check:deploy] ${step.join(" ")} failed after ${elapsed}s (${reason})`);
        console.error(`[check:deploy] full log: ${logPath}`);
        console.error(readLogTail(logPath));
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
