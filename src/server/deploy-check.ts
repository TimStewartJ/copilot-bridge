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
import { sh, type ShellCommand } from "./shell-command.js";

export const DEPLOY_CHECK_STEPS = [
  // Production-safe only: preview smoke needs a staging worktree and runs in STAGING_DEPLOY_GATE.
  sh`npm run check:pr`,
] as const;

const LOG_TAIL_BYTES = 24_000;
type DeployCheckStep = ShellCommand;
type DeployCheckStepResult = {
  step: DeployCheckStep;
  elapsedMs: number;
  logPath: string;
};

function resolveLogDir(cwd: string): string {
  // Only this entry point reads the override, so an ambient value can't redirect other callers.
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
  // The shell finds npm on every platform; Windows only has the npm.cmd launcher, which needs one.
  const displayCommand: string = step;
  const cwd = process.cwd();
  const rootDir = resolveBridgeControlRoot(cwd);
  const logPath = buildValidationCommandLogPath({
    logDir: ensureLogDir(cwd),
    source: `deploy-check-${stepIndex + 1}`,
    command: displayCommand,
  });
  console.log(`[check:deploy] ${stepIndex + 1}/${totalSteps}: ${displayCommand} (log: ${logPath})`);

  return runStreamingValidationCommand({
    rootDir,
    source: `deploy-check-${stepIndex + 1}`,
    command: step,
    logPath,
    cwd,
    env: process.env,
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
    .map(({ step, elapsedMs }, index) => `${index + 1}. ${step} ${formatCommandDuration(elapsedMs)}`)
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
