import { DEPLOY_GATE, ROLLBACK_GATE, runValidationGate, type ValidationCommandOptions } from "./server/validation-pipeline.js";
import type { RestartValidationMode } from "./server/restart-signal.js";

export type LauncherCommandResult = { ok: boolean; output: string };
export type LauncherCommandOptions = ValidationCommandOptions;

interface LauncherBuildOptions {
  ensureDeps: () => boolean;
  run: (cmd: string, options?: LauncherCommandOptions) => LauncherCommandResult;
  log: (msg: string) => void;
  validationMode?: RestartValidationMode;
  hasSourceChanges?: () => boolean;
}

interface LauncherStartupOptions {
  ensureDeps: () => boolean;
  log: (msg: string) => void;
}

interface LauncherRollbackOptions extends LauncherBuildOptions {
  rollbackTarget: string;
}

interface LauncherRollbackCheckpointOptions extends LauncherRollbackOptions {
  clearCheckpoint: () => void;
  restoreCheckpoint: () => void;
}

function logFailure(prefix: string, output: string, log: (msg: string) => void) {
  log(`${prefix}:\n${output.slice(-500)}`);
}

export function runLauncherBuild({
  ensureDeps,
  run,
  log,
  validationMode = "deploy",
  hasSourceChanges = () => true,
}: LauncherBuildOptions): boolean {
  log("Building...");
  const operationalSourceChanged = validationMode === "operational" ? hasSourceChanges() : true;
  if (!ensureDeps()) {
    log("Dependency sync failed — aborting build");
    return false;
  }

  if (validationMode === "operational") {
    if (!operationalSourceChanged) {
      log("Operational restart validation skipped — no source changes detected");
      return true;
    }
    log("Operational restart found source changes — running deploy validation");
  }

  const validation = runValidationGate(DEPLOY_GATE, {
    cwd: ".",
    run,
  });
  if (!validation.ok) {
    logFailure(`${validation.gate.label} failed`, validation.result.output, log);
    return false;
  }

  log("Build succeeded");
  return true;
}

export function verifyLauncherStartup({ ensureDeps, log }: LauncherStartupOptions): boolean {
  if (!ensureDeps()) {
    log("Dependency sync failed during startup");
    return false;
  }
  return true;
}

export function rebuildAfterRollback({ ensureDeps, run, log }: LauncherBuildOptions): boolean {
  if (!ensureDeps()) {
    log("Dependency sync failed during rollback");
    return false;
  }

  const validation = runValidationGate(ROLLBACK_GATE, {
    cwd: ".",
    run,
  });
  if (!validation.ok) {
    logFailure(`${validation.gate.label} failed`, validation.result.output, log);
    return false;
  }

  log("Rollback complete");
  return true;
}

export function runLauncherRollback({ rollbackTarget, ensureDeps, run, log }: LauncherRollbackOptions): boolean {
  const reset = run(`git reset --hard ${rollbackTarget}`);
  if (!reset.ok) {
    logFailure("Rollback git reset failed", reset.output, log);
    return false;
  }
  return rebuildAfterRollback({ ensureDeps, run, log });
}

export function runLauncherRollbackWithCheckpointHandling({
  clearCheckpoint,
  restoreCheckpoint,
  ...options
}: LauncherRollbackCheckpointOptions): boolean {
  const ok = runLauncherRollback(options);
  if (ok) {
    clearCheckpoint();
  } else {
    restoreCheckpoint();
  }
  return ok;
}
