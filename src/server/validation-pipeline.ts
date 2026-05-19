import { formatCommandDuration } from "./validation-command-log.js";

export type ValidationStep = {
  command: string;
  timeoutMs: number;
};

export type ValidationGate = {
  id: string;
  label: string;
  steps: ValidationStep[];
};

type ValidationCommandResult = {
  ok: boolean;
};

export type ValidationCommandOptions = {
  timeoutMs?: number;
  isolateRuntimeEnv?: boolean;
  env?: NodeJS.ProcessEnv;
};

type RunValidationGateOptions<Result extends ValidationCommandResult> = {
  cwd: string;
  run: (command: string, options?: ValidationCommandOptions) => Result;
  log?: (message: string) => void;
};

type RunValidationGateAsyncOptions<Result extends ValidationCommandResult> = {
  cwd: string;
  run: (command: string, options?: ValidationCommandOptions) => Promise<Result>;
  log?: (message: string) => void;
};

export type ValidationGateSuccess<Result extends ValidationCommandResult> = {
  ok: true;
  gate: ValidationGate;
  results: Array<{ step: ValidationStep; result: Result; elapsedMs: number }>;
};

export type ValidationGateFailure<Result extends ValidationCommandResult> = {
  ok: false;
  gate: ValidationGate;
  step: ValidationStep;
  stepIndex: number;
  result: Result;
  results: Array<{ step: ValidationStep; result: Result; elapsedMs: number }>;
};

export type ValidationGateRunResult<Result extends ValidationCommandResult> =
  | ValidationGateSuccess<Result>
  | ValidationGateFailure<Result>;

const VALIDATION_TIMEOUT_MS = 10 * 60 * 1000;
const ROLLBACK_VALIDATION_TIMEOUT_MS = 8 * 60 * 1000;
// Bump when the deploy gate contract changes in a way that should invalidate existing stamps.
export const DEPLOY_GATE_VERSION = 2;
// Bump when preview validation no longer proves the PR gate used by deploy fast-path reuse.
export const PREVIEW_GATE_VERSION = 1;

const FAST_CHECK_STEP: ValidationStep = {
  command: "npm run check:fast",
  timeoutMs: VALIDATION_TIMEOUT_MS,
};

const PR_CHECK_STEP: ValidationStep = {
  command: "npm run check:pr",
  timeoutMs: VALIDATION_TIMEOUT_MS,
};

const DEPLOY_CHECK_STEP: ValidationStep = {
  command: "npm run check:deploy",
  timeoutMs: VALIDATION_TIMEOUT_MS,
};

export const DEPLOY_CHECK_COMMAND = DEPLOY_CHECK_STEP.command;

const PREVIEW_SMOKE_STEP: ValidationStep = {
  command: "npm run preview:smoke",
  timeoutMs: VALIDATION_TIMEOUT_MS,
};

const PRODUCTION_BUILD_STEP: ValidationStep = {
  command: "npm run build",
  timeoutMs: VALIDATION_TIMEOUT_MS,
};

const VITE_BUILD_STEP: ValidationStep = {
  command: "npx vite build",
  timeoutMs: ROLLBACK_VALIDATION_TIMEOUT_MS,
};

export const PREVIEW_GATE: ValidationGate = {
  id: "preview",
  label: "Preview validation",
  steps: [FAST_CHECK_STEP, PR_CHECK_STEP],
};

export const PREVIEW_GATE_COMMAND = PREVIEW_GATE.steps.map((step) => step.command).join(" && ");

export const DEPLOY_GATE: ValidationGate = {
  id: "deploy",
  label: "Deploy validation",
  steps: [DEPLOY_CHECK_STEP],
};

export const STAGING_DEPLOY_GATE: ValidationGate = {
  id: "staging-deploy",
  label: "Staging deploy validation",
  steps: [PR_CHECK_STEP, PREVIEW_SMOKE_STEP],
};

export const DEPLOY_SMOKE_GATE: ValidationGate = {
  id: "deploy-smoke",
  label: "Smoke-only deploy validation",
  steps: [PREVIEW_SMOKE_STEP],
};

export const STAMPED_DEPLOY_GATE: ValidationGate = {
  id: "stamped-deploy",
  label: "Stamped deploy build",
  steps: [PRODUCTION_BUILD_STEP],
};

export const ROLLBACK_GATE: ValidationGate = {
  id: "rollback",
  label: "Rollback validation",
  steps: [
    VITE_BUILD_STEP,
  ],
};

function formatStepSummary<Result extends ValidationCommandResult>(
  results: Array<{ step: ValidationStep; result: Result; elapsedMs: number }>,
): string {
  return results
    .map(({ step, elapsedMs }, index) => `${index + 1}. ${step.command} ${formatCommandDuration(elapsedMs)}`)
    .join("; ");
}

export function runValidationGate<Result extends ValidationCommandResult>(
  gate: ValidationGate,
  options: RunValidationGateOptions<Result>,
): ValidationGateRunResult<Result> {
  const results: Array<{ step: ValidationStep; result: Result; elapsedMs: number }> = [];
  const gateStartedAt = Date.now();

  options.log?.(`Starting ${gate.label.toLowerCase()} in ${options.cwd} (${gate.steps.length} step(s))`);

  for (const [stepIndex, step] of gate.steps.entries()) {
    options.log?.(`Running ${gate.label.toLowerCase()} step ${stepIndex + 1}/${gate.steps.length}: ${step.command}`);
    const stepStartedAt = Date.now();
    const result = options.run(step.command, { timeoutMs: step.timeoutMs, isolateRuntimeEnv: true });
    const elapsedMs = Date.now() - stepStartedAt;
    results.push({ step, result, elapsedMs });
    if (!result.ok) {
      options.log?.(
        `${gate.label} step ${stepIndex + 1}/${gate.steps.length} failed after ${formatCommandDuration(elapsedMs)}: ${step.command}`,
      );
      return { ok: false, gate, step, stepIndex, result, results };
    }
    options.log?.(
      `${gate.label} step ${stepIndex + 1}/${gate.steps.length} passed in ${formatCommandDuration(elapsedMs)}: ${step.command}`,
    );
  }

  const gateElapsedMs = Date.now() - gateStartedAt;
  const stepSummary = formatStepSummary(results);
  options.log?.(
    `Completed ${gate.label.toLowerCase()} in ${formatCommandDuration(gateElapsedMs)}`
      + (stepSummary ? ` (${stepSummary})` : ""),
  );
  return { ok: true, gate, results };
}

export async function runValidationGateAsync<Result extends ValidationCommandResult>(
  gate: ValidationGate,
  options: RunValidationGateAsyncOptions<Result>,
): Promise<ValidationGateRunResult<Result>> {
  const results: Array<{ step: ValidationStep; result: Result; elapsedMs: number }> = [];
  const gateStartedAt = Date.now();

  options.log?.(`Starting ${gate.label.toLowerCase()} in ${options.cwd} (${gate.steps.length} step(s))`);

  for (const [stepIndex, step] of gate.steps.entries()) {
    options.log?.(`Running ${gate.label.toLowerCase()} step ${stepIndex + 1}/${gate.steps.length}: ${step.command}`);
    const stepStartedAt = Date.now();
    const result = await options.run(step.command, { timeoutMs: step.timeoutMs, isolateRuntimeEnv: true });
    const elapsedMs = Date.now() - stepStartedAt;
    results.push({ step, result, elapsedMs });
    if (!result.ok) {
      options.log?.(
        `${gate.label} step ${stepIndex + 1}/${gate.steps.length} failed after ${formatCommandDuration(elapsedMs)}: ${step.command}`,
      );
      return { ok: false, gate, step, stepIndex, result, results };
    }
    options.log?.(
      `${gate.label} step ${stepIndex + 1}/${gate.steps.length} passed in ${formatCommandDuration(elapsedMs)}: ${step.command}`,
    );
  }

  const gateElapsedMs = Date.now() - gateStartedAt;
  const stepSummary = formatStepSummary(results);
  options.log?.(
    `Completed ${gate.label.toLowerCase()} in ${formatCommandDuration(gateElapsedMs)}`
      + (stepSummary ? ` (${stepSummary})` : ""),
  );
  return { ok: true, gate, results };
}
