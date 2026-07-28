import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBridgeControlRoot } from "./control-root.js";
import {
  buildValidationCommandLogPath,
  formatCommandDuration,
  formatValidationCommandLogError,
  getValidationCommandLogDir,
  tryReadValidationCommandLogTail,
  VALIDATION_LOG_DIR_ENV,
} from "./validation-command-log.js";
import { runStreamingValidationCommand } from "./validation-command-runner.js";

export const DEPLOY_CHECK_STEPS = [
  // Production-safe deploy validation only. Staging-only preview smoke asserts a
  // bridge-staging worktree and is enforced by STAGING_DEPLOY_GATE instead.
  ["npm", "run", "check:pr"],
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

function resolveLogDir(cwd: string): string {
  // Explicit operator override; deploy validation points its child processes at
  // the production data dir. Only this entry point honors it, so an ambient value
  // can never redirect a caller that passed its own root directory.
  const configured = process.env[VALIDATION_LOG_DIR_ENV]?.trim();
  if (configured) return resolve(configured);
  return getValidationCommandLogDir(resolveBridgeControlRoot(cwd));
}

function ensureLogDir(cwd: string): string {
  const dir = resolveLogDir(cwd);
  try {
    mkdirSync(dir, { recursive: true });
    return dir;
  } catch (error) {
    const fallback = join(tmpdir(), "copilot-bridge-validation-logs");
    mkdirSync(fallback, { recursive: true });
    console.error(`[check:deploy] unable to create validation log dir ${dir}: ${formatValidationCommandLogError(error)}`);
    console.error(`[check:deploy] falling back to ${fallback}`);
    return fallback;
  }
}

function runStep(step: DeployCheckStep, stepIndex: number, totalSteps: number): Promise<DeployCheckStepResult> {
  const displayCommand = step.join(" ");
  const cwd = process.cwd();
  const rootDir = resolveBridgeControlRoot(cwd);
  const logPath = buildValidationCommandLogPath({
    logDir: ensureLogDir(cwd),
    source: `deploy-check-${stepIndex + 1}`,
    command: displayCommand,
  });
  const command = step[0] === "npm" ? npmCommand() : step[0];
  const shell = process.platform === "win32";
  console.log(`[check:deploy] ${stepIndex + 1}/${totalSteps}: ${displayCommand} (log: ${logPath})`);

  return runStreamingValidationCommand({
    rootDir,
    source: `deploy-check-${stepIndex + 1}`,
    command,
    args: step.slice(1),
    displayCommand,
    logPath,
    cwd,
    env: process.env,
    shell,
  }).then((result) => {
    const elapsed = formatCommandDuration(result.elapsedMs);
    if (result.ok) {
      console.log(`[check:deploy] ${displayCommand} passed in ${elapsed}`);
      return { step, elapsedMs: result.elapsedMs, logPath };
    }

    console.error(`[check:deploy] ${displayCommand} failed after ${elapsed} (${result.reason})`);
    if (result.validationLogPath) {
      console.error(`[check:deploy] full log: ${result.validationLogPath}`);
      const logTail = tryReadValidationCommandLogTail(result.validationLogPath, LOG_TAIL_BYTES);
      if (logTail.ok) {
        console.error(logTail.content);
      } else {
        console.error(`[check:deploy] unable to read log tail: ${logTail.error}`);
        console.error(result.output);
      }
    } else {
      console.error(result.output);
    }
    throw new Error(`${displayCommand} failed (${result.reason})`);
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
