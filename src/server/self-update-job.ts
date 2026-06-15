import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEPENDENCY_SYNC_GIT_PATHSPEC } from "./dependency-sync.js";
import { isBridgeReleaseMode } from "./distribution-mode.js";
import { preserveOrCreateRollbackCheckpoint, removeRollbackCheckpointIfCreated } from "./pre-deploy-checkpoint.js";
import {
  findReleaseSlotByCommit,
  prepareReleaseSlot,
  readActiveRelease,
  type ReleaseSlotManifest,
} from "./release-slots.js";
import { clearRestartPending, triggerRestartPending } from "./restart-controller.js";
import { isRestartAlreadyInFlight } from "./restart-state.js";
import { writeRestartSignalFile, type RestartReleaseCandidate, type RestartValidationMode } from "./restart-signal.js";
import { toolFailure } from "./tool-results.js";
import { resolveBridgeControlRoot } from "./control-root.js";
import { resolveRuntimePaths, type RuntimePaths } from "./runtime-paths.js";
import { runValidationCommand } from "./validation-command-runner.js";
import { createValidationCommandEnv, prependNodePath } from "./validation-command-env.js";
import { withNonInteractiveCommandEnv } from "./noninteractive-env.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONTROL_ROOT = resolveBridgeControlRoot(join(__dirname, "..", ".."));
const SELF_UPDATE_INSTALL_COMMAND = "npm install --no-audit --no-fund --include=dev";
const SELF_UPDATE_INSTALL_TIMEOUT_MS = 5 * 60_000;
const SELF_UPDATE_DEPLOY_CHECK_TIMEOUT_MS = 10 * 60_000;

export interface SelfUpdateJobOptions {
  controlRoot?: string;
  runtimePaths?: RuntimePaths;
  log?: (message: string) => void;
}

interface CommandResult {
  ok: boolean;
  output: string;
}

function cleanupFailedRestartSignal(signalFile: string): void {
  clearRestartPending();
  try {
    unlinkSync(signalFile);
  } catch {
    // Best-effort cleanup.
  }
}

function writeRestartSignalOrRollback(
  signalFile: string,
  validationMode: RestartValidationMode,
  source: string,
  releaseCandidate?: RestartReleaseCandidate,
): number {
  const otherBusy = triggerRestartPending();
  try {
    writeRestartSignalFile(signalFile, { validationMode, source, releaseCandidate });
  } catch (error) {
    cleanupFailedRestartSignal(signalFile);
    throw error;
  }
  return otherBusy;
}

function createSelfUpdateRunner(
  controlRoot: string,
  log: (message: string) => void,
): (cmd: string, options?: { cwd?: string; timeoutMs?: number; isolateRuntimeEnv?: boolean }) => Promise<CommandResult> {
  return async (cmd, options = {}) => {
    const cwd = options.cwd ?? controlRoot;
    const nodeDir = dirname(process.execPath);
    const validationEnv = options.isolateRuntimeEnv
      ? createValidationCommandEnv(process.env, { nodeDir, prefix: "bridge-self-update-" })
      : undefined;
    const baseEnv = validationEnv?.env ?? prependNodePath(process.env, nodeDir);
    const env = withNonInteractiveCommandEnv(baseEnv);
    log(`$ ${cmd}\n[cwd] ${cwd}`);
    try {
      const result = await runValidationCommand({
        rootDir: controlRoot,
        source: "self-update",
        command: cmd,
        cwd,
        env,
        timeoutMs: options.timeoutMs ?? 120_000,
        failureOutputFormat: "plain",
      });
      if (result.output.trim()) log(result.output.trimEnd());
      return result;
    } finally {
      validationEnv?.cleanup();
    }
  };
}

async function isAncestor(
  run: ReturnType<typeof createSelfUpdateRunner>,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  const result = await run(`git merge-base --is-ancestor "${ancestor}" "${descendant}"`, {
    timeoutMs: 30_000,
  });
  return result.ok;
}

async function prepareOrReuseReleaseCandidate(options: {
  controlRoot: string;
  dataDir: string;
  commitSha: string;
  run: ReturnType<typeof createSelfUpdateRunner>;
  log: (message: string) => void;
}): Promise<
  | { ok: true; manifest: ReleaseSlotManifest; reused: boolean }
  | { ok: false; command: string; cwd: string; output: string }
> {
  const reusable = findReleaseSlotByCommit(options.dataDir, options.commitSha, { validationMode: "deploy" });
  if (reusable) {
    options.log(`Reusing existing release slot ${reusable.id} for ${options.commitSha.slice(0, 8)}`);
    return { ok: true, manifest: reusable, reused: true };
  }

  const prepared = await prepareReleaseSlot({
    sourceDir: options.controlRoot,
    dataDir: options.dataDir,
    commitSha: options.commitSha,
    source: "self_update",
    validationMode: "deploy",
    run: async (command, cwd, runOptions) =>
      options.run(command, { cwd, timeoutMs: runOptions?.timeoutMs }),
    log: options.log,
    installCommand: SELF_UPDATE_INSTALL_COMMAND,
    installTimeoutMs: SELF_UPDATE_INSTALL_TIMEOUT_MS,
    buildCommand: "npm run check:deploy",
    buildTimeoutMs: SELF_UPDATE_DEPLOY_CHECK_TIMEOUT_MS,
  });
  return prepared.ok
    ? { ok: true, manifest: prepared.manifest, reused: false }
    : prepared;
}

async function handleUnchangedHeadDrift(options: {
  activeRelease: ReleaseSlotManifest | null;
  controlRoot: string;
  dataDir: string;
  fullHeadSha: string;
  shortHeadSha: string;
  preDeployShaFile: string;
  rollbackCheckpoint: { sha: string; createdByCurrentOperation: boolean };
  signalFile: string;
  run: ReturnType<typeof createSelfUpdateRunner>;
  log: (message: string) => void;
}): Promise<Record<string, unknown>> {
  if (!options.activeRelease || options.activeRelease.commitSha === options.fullHeadSha) {
    removeRollbackCheckpointIfCreated(options.preDeployShaFile, options.rollbackCheckpoint);
    return { success: true, message: "Already up to date — no restart needed." };
  }

  if (!(await isAncestor(options.run, options.activeRelease.commitSha, options.fullHeadSha))) {
    removeRollbackCheckpointIfCreated(options.preDeployShaFile, options.rollbackCheckpoint);
    return toolFailure("Active release points at a different or newer commit than the control checkout.", {
      detail:
        `The repository is already at ${options.shortHeadSha}, but active-release.json points to ` +
        `${options.activeRelease.commitSha.slice(0, 8)}. That active release is not an ancestor of HEAD, ` +
        "so activating the checkout HEAD could downgrade or switch away from the running release. Manual recovery is required.",
      sessionLog:
        `Self-update drift refused: active release ${options.activeRelease.commitSha} is not an ancestor of HEAD ${options.fullHeadSha}.`,
      toolTelemetry: {
        activeReleaseSha: options.activeRelease.commitSha.slice(0, 8),
        headSha: options.shortHeadSha,
      },
    });
  }

  const releaseSlotResult = await prepareOrReuseReleaseCandidate({
    controlRoot: options.controlRoot,
    dataDir: options.dataDir,
    commitSha: options.fullHeadSha,
    run: options.run,
    log: options.log,
  });
  if (!releaseSlotResult.ok) {
    removeRollbackCheckpointIfCreated(options.preDeployShaFile, options.rollbackCheckpoint);
    return toolFailure("Repository is up to date but release slot activation failed.", {
      detail:
        `The checkout is at ${options.shortHeadSha}, but the active release still points to ` +
        `${options.activeRelease.commitSha.slice(0, 8)} and preparing a release slot for HEAD failed.\n\n` +
        `Command: ${releaseSlotResult.command}\nWorking directory: ${releaseSlotResult.cwd}\n\n${releaseSlotResult.output.slice(-500)}`,
      sessionLog:
        `Self-update drift release slot preparation failed for ${options.shortHeadSha}.\n` +
        `Command: ${releaseSlotResult.command}\nWorking directory: ${releaseSlotResult.cwd}\n\n${releaseSlotResult.output.slice(-4_000)}`,
      toolTelemetry: {
        command: releaseSlotResult.command,
        cwd: releaseSlotResult.cwd,
        activeReleaseSha: options.activeRelease.commitSha.slice(0, 8),
        headSha: options.shortHeadSha,
      },
    });
  }

  try {
    writeRestartSignalOrRollback(options.signalFile, "deploy", "self_update", releaseSlotResult.manifest);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return toolFailure("Release slot prepared but restart signal could not be written.", {
      detail:
        `The checkout is at ${options.shortHeadSha}, but ${options.signalFile} could not be written. ` +
        `Manual restart is required to activate the prepared release slot.\n\n${message}`,
      sessionLog:
        `Self-update drift prepared ${options.shortHeadSha}, but failed to write restart signal ${options.signalFile}: ${message}`,
      toolTelemetry: {
        signalFile: options.signalFile,
        activeReleaseSha: options.activeRelease.commitSha.slice(0, 8),
        headSha: options.shortHeadSha,
      },
    });
  }

  return {
    success: true,
    previousSha: options.activeRelease.commitSha.slice(0, 8),
    newSha: options.shortHeadSha,
    activeReleaseDrift: true,
    reusedReleaseSlot: releaseSlotResult.reused,
    message:
      `Repository HEAD is already ${options.shortHeadSha}, but the active release was still ` +
      `${options.activeRelease.commitSha.slice(0, 8)}. Restart queued to activate HEAD from ` +
      (releaseSlotResult.reused ? "the existing release slot." : "a freshly prepared release slot.") +
      " Do NOT make any more tool calls once the launcher begins restart cutover.",
  };
}

async function failIfActiveReleaseWouldDowngrade(options: {
  activeRelease: ReleaseSlotManifest | null;
  fullHeadSha: string;
  shortHeadSha: string;
  run: ReturnType<typeof createSelfUpdateRunner>;
}): Promise<Record<string, unknown> | null> {
  if (!options.activeRelease || options.activeRelease.commitSha === options.fullHeadSha) return null;
  if (await isAncestor(options.run, options.activeRelease.commitSha, options.fullHeadSha)) return null;

  return toolFailure("Active release points at a different or newer commit than the control checkout.", {
    detail:
      `The checkout HEAD is ${options.shortHeadSha}, but active-release.json points to ` +
      `${options.activeRelease.commitSha.slice(0, 8)}. That active release is not an ancestor of HEAD, ` +
      "so activating the checkout HEAD could downgrade or switch away from the running release. Manual recovery is required.",
    sessionLog:
      `Self-update refused: active release ${options.activeRelease.commitSha} is not an ancestor of HEAD ${options.fullHeadSha}.`,
    toolTelemetry: {
      activeReleaseSha: options.activeRelease.commitSha.slice(0, 8),
      headSha: options.shortHeadSha,
    },
  });
}

export async function runSelfUpdateJob(_input: unknown = {}, options: SelfUpdateJobOptions = {}): Promise<Record<string, unknown>> {
  const controlRoot = options.controlRoot ?? DEFAULT_CONTROL_ROOT;
  const runtimePaths = options.runtimePaths ?? resolveRuntimePaths(process.env);
  const dataDir = runtimePaths.dataDir;
  const signalFile = join(dataDir, "restart.signal");
  const preDeployShaFile = join(dataDir, "pre-deploy-sha");
  const log = options.log ?? ((message: string) => console.log(`[self-update] ${message}`));

  if (runtimePaths.distributionMode === "release" || isBridgeReleaseMode(process.env, controlRoot)) {
    return toolFailure("Git self-update is unavailable in packaged release mode. Use the release update.ps1 script with a published package instead.");
  }
  if (isRestartAlreadyInFlight(dataDir)) {
    return toolFailure("A restart is already pending. Wait for it to complete before updating.");
  }

  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  const run = createSelfUpdateRunner(controlRoot, log);

  const branchResult = await run("git rev-parse --abbrev-ref HEAD");
  const branch = branchResult.ok ? branchResult.output.trim() : "main";
  const headResult = await run("git rev-parse HEAD");
  const preUpdateSha = headResult.ok ? headResult.output.trim() : "";
  const rollbackCheckpoint = preserveOrCreateRollbackCheckpoint(preDeployShaFile, preUpdateSha);

  const pullResult = await run(`git pull --rebase origin ${branch}`);
  if (!pullResult.ok) {
    await run("git rebase --abort");
    removeRollbackCheckpointIfCreated(preDeployShaFile, rollbackCheckpoint);
    const message =
      "Git pull failed — likely due to merge conflicts or network issues. " +
      "The working tree has been restored to its previous state.\n\n" +
      pullResult.output.slice(-500);
    return toolFailure(message, { sessionLog: pullResult.output.slice(-500) });
  }

  const newFullHead = await run("git rev-parse HEAD");
  const newFullSha = newFullHead.ok ? newFullHead.output.trim() : "";
  const newHead = await run("git rev-parse --short HEAD");
  const newSha = newHead.ok ? newHead.output.trim() : "unknown";
  const changed = preUpdateSha !== newFullSha;

  if (!changed) {
    return await handleUnchangedHeadDrift({
      activeRelease: readActiveRelease(dataDir),
      controlRoot,
      dataDir,
      fullHeadSha: newFullSha,
      shortHeadSha: newSha,
      preDeployShaFile,
      rollbackCheckpoint,
      signalFile,
      run,
      log,
    });
  }

  const downgradeFailure = await failIfActiveReleaseWouldDowngrade({
    activeRelease: readActiveRelease(dataDir),
    fullHeadSha: newFullSha,
    shortHeadSha: newSha,
    run,
  });
  if (downgradeFailure) {
    removeRollbackCheckpointIfCreated(preDeployShaFile, rollbackCheckpoint);
    return downgradeFailure;
  }

  const releaseSlotResult = await prepareOrReuseReleaseCandidate({
    controlRoot,
    dataDir,
    commitSha: newFullSha || newSha,
    run,
    log,
  });
  if (!releaseSlotResult.ok) {
    const resetResult = preUpdateSha
      ? await run(`git reset --hard ${preUpdateSha}`)
      : { ok: true, output: "" };
    if (resetResult.ok) {
      removeRollbackCheckpointIfCreated(preDeployShaFile, rollbackCheckpoint);
    }
    return toolFailure("Updated code but release slot preparation failed.", {
      detail:
        `The repository was updated to ${newSha}, but the inactive release slot failed to prepare. ` +
        (resetResult.ok
          ? `The checkout was reset back to ${preUpdateSha.slice(0, 8)} and no restart was queued.`
          : `Resetting the checkout back to ${preUpdateSha.slice(0, 8)} also failed; manual recovery is required.`) +
        `\n\nCommand: ${releaseSlotResult.command}\nWorking directory: ${releaseSlotResult.cwd}\n\n${releaseSlotResult.output.slice(-500)}`,
      sessionLog:
        `Self-update release slot preparation failed after ${preUpdateSha.slice(0, 8)} -> ${newSha}.\n` +
        `Command: ${releaseSlotResult.command}\nWorking directory: ${releaseSlotResult.cwd}\n\n${releaseSlotResult.output.slice(-4_000)}`,
      toolTelemetry: {
        command: releaseSlotResult.command,
        cwd: releaseSlotResult.cwd,
        previousSha: preUpdateSha.slice(0, 8),
        newSha,
        resetOk: resetResult.ok,
      },
    });
  }

  const dependencyInputsChanged = !!preUpdateSha
    && (() => {
      const diffPromise = run(`git diff "${preUpdateSha}" HEAD --name-only -- ${DEPENDENCY_SYNC_GIT_PATHSPEC}`);
      return diffPromise.then((diffResult) => diffResult.ok && !!diffResult.output.trim());
    })();
  const dependencyChanged = await dependencyInputsChanged;

  let otherBusy = 0;
  try {
    otherBusy = writeRestartSignalOrRollback(signalFile, "deploy", "self_update", releaseSlotResult.manifest);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return toolFailure("Updated code but restart signal could not be written.", {
      detail:
        `The repository was updated to ${newSha}, but ${signalFile} could not be written. ` +
        `Manual restart is required to run the updated code.\n\n${message}`,
      sessionLog: `Updated ${preUpdateSha.slice(0, 8)} -> ${newSha}, but failed to write restart signal ${signalFile}: ${message}`,
      toolTelemetry: { signalFile, previousSha: preUpdateSha.slice(0, 8), newSha },
    });
  }

  const waitNote = otherBusy > 0
    ? ` ${otherBusy} other session(s) are active — the launcher will wait for them to finish (up to 60 min per busy-session check; sessions with no activity for 5 min are treated as stuck).`
    : "";

  return {
    success: true,
    previousSha: preUpdateSha.slice(0, 8),
    newSha,
    reusedReleaseSlot: releaseSlotResult.reused,
    message:
      `Updated ${preUpdateSha.slice(0, 8)} → ${newSha}. Restart queued; the launcher will swap to the prepared release slot and roll back automatically if needed.` +
      (dependencyChanged ? " Dependency inputs changed — the inactive release slot has its own dependency install." : "") +
      `${waitNote} ` +
      "Do NOT make any more tool calls once the launcher begins restart cutover.",
  };
}
