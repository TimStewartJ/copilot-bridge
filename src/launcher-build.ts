export type LauncherCommandResult = { ok: boolean; output: string };

interface LauncherBuildOptions {
  ensureDeps: () => boolean;
  run: (cmd: string) => LauncherCommandResult;
  log: (msg: string) => void;
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

export function runLauncherBuild({ ensureDeps, run, log }: LauncherBuildOptions): boolean {
  log("Building...");
  if (!ensureDeps()) {
    log("Dependency sync failed — aborting build");
    return false;
  }

  const client = run("npx vite build");
  if (!client.ok) {
    logFailure("Client build failed", client.output, log);
    return false;
  }

  const server = run("npx tsc --noEmit");
  if (!server.ok) {
    logFailure("Server type check failed", server.output, log);
    return false;
  }

  const tests = run("npx vitest run --coverage");
  if (!tests.ok) {
    logFailure("Tests failed", tests.output, log);
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

  const client = run("npx vite build");
  if (!client.ok) {
    logFailure("Rollback build failed", client.output, log);
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
