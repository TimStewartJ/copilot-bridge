import { execSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { DEPENDENCY_SYNC_GIT_PATHSPEC } from "../dependency-sync.js";
import { isBridgeReleaseMode } from "../distribution-mode.js";
import { preserveOrCreateRollbackCheckpoint, removeRollbackCheckpointIfCreated } from "../pre-deploy-checkpoint.js";
import { prepareReleaseSlot } from "../release-slots.js";
import { clearRestartPending, isRestartPending, triggerRestartPending } from "../restart-controller.js";
import { writeRestartSignalFile, type RestartReleaseCandidate, type RestartValidationMode } from "../restart-signal.js";
import { toolFailure } from "../tool-results.js";
import type { AppContext } from "../app-context.js";
import {
  defineBridgeTool,
  registerBridgeToolDefinitions,
} from "../agent-tools-mcp/adapter.js";
import type { BridgeToolDefinition, BridgeToolsMcpServer } from "../agent-tools-mcp/server.js";
import { BRIDGE_TOOLS_REPO_ROOT } from "./helpers.js";

const SELF_UPDATE_INSTALL_COMMAND = "npm install --no-audit --no-fund --include=dev";
const SELF_UPDATE_INSTALL_TIMEOUT_MS = 5 * 60_000;
const SELF_UPDATE_DEPLOY_CHECK_TIMEOUT_MS = 10 * 60_000;

function run(
  cmd: string,
  options: { cwd?: string; timeoutMs?: number } = {},
): { ok: boolean; output: string } {
  try {
    const output = execSync(cmd, {
      cwd: options.cwd ?? BRIDGE_TOOLS_REPO_ROOT,
      encoding: "utf-8",
      timeout: options.timeoutMs ?? 120_000,
    });
    return { ok: true, output };
  } catch (err: any) {
    return { ok: false, output: err.stderr || err.stdout || String(err) };
  }
}

function getDataDir(ctx: AppContext): string {
  return ctx.runtimePaths?.dataDir ?? join(BRIDGE_TOOLS_REPO_ROOT, "data");
}

function getSignalFile(ctx: AppContext): string {
  return join(getDataDir(ctx), "restart.signal");
}

function getPreDeployShaFile(ctx: AppContext): string {
  return join(getDataDir(ctx), "pre-deploy-sha");
}

function isReleaseMode(ctx: AppContext): boolean {
  return ctx.runtimePaths?.distributionMode === "release" || isBridgeReleaseMode(process.env, BRIDGE_TOOLS_REPO_ROOT);
}

function cleanupFailedRestartSignal(signalFile: string): void {
  clearRestartPending();
  try { unlinkSync(signalFile); } catch {}
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

export interface RegisterSelfAdminToolsOptions {
  hiddenTools?: ReadonlySet<string>;
}

export function createSelfAdminToolDefinitions(ctx: AppContext): BridgeToolDefinition[] {
  return [
  defineBridgeTool("self_restart", {
    description: "Restart the Copilot Bridge server WITHOUT code changes (config reload, env changes, emergency restart). For deploying code changes, use staging_init → make changes → staging_deploy instead. The launcher will run operational restart checks, sync dependencies if needed, and swap processes without the full deploy validation gate unless source files changed. IMPORTANT: This session counts as active — after a successful restart signal, do not make further tool calls or you will block the restart. Status/progress-only tool calls may be batched with self_restart in the same tool-calling message; do not create no-op companion tool calls solely to satisfy tool-batching guidance. RESTRICTED: Only the primary session agent may call this tool. Sub-agents spawned via the task tool must NEVER call this.",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      const signalFile = getSignalFile(ctx);
      if (isRestartPending()) {
        return toolFailure("A restart is already pending. Wait for it to complete before restarting.");
      }
      const dataDir = getDataDir(ctx);
      if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

      let otherBusy = 0;
      try {
        otherBusy = writeRestartSignalOrRollback(signalFile, "operational", "self_restart");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return toolFailure("Restart signal could not be written.", {
          detail: `The bridge did not queue a restart because ${signalFile} could not be written.\n\n${message}`,
          sessionLog: `Failed to write restart signal ${signalFile}: ${message}`,
          toolTelemetry: { signalFile },
        });
      }

      const waitNote = otherBusy > 0
        ? ` ${otherBusy} other session(s) are active — the launcher will wait for them to finish (up to 60 min per busy-session check; sessions with no activity for 5 min are treated as stuck).`
        : "";
      return {
        success: true,
        message: `Restart signal sent.${waitNote} Do NOT make any more tool calls — this session is considered active and will block the restart until it is idle.`,
      };
    },
  }),
  defineBridgeTool("self_update", {
    description:
      "Pull the latest code from the remote repository and restart the server. " +
      "Use this to update the Copilot Bridge to the latest version without the full staging workflow. " +
      "Saves a rollback checkpoint before pulling so the launcher can sync dependencies, rebuild, health-check, and roll back if needed. " +
      "IMPORTANT: After a successful update signal, do not make further tool calls because the server will restart. " +
      "Status/progress-only tool calls may be batched with self_update in the same tool-calling message; do not create no-op companion tool calls solely to satisfy tool-batching guidance. " +
      "RESTRICTED: Only the primary session agent may call this tool. Sub-agents spawned via the task tool must NEVER call this.",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      if (isReleaseMode(ctx)) {
        return toolFailure("Git self-update is unavailable in packaged release mode. Use the release update.ps1 script with a published package instead.");
      }

      const signalFile = getSignalFile(ctx);
      if (isRestartPending() || existsSync(signalFile)) {
        return toolFailure("A restart is already pending. Wait for it to complete before updating.");
      }

      const dataDir = getDataDir(ctx);
      if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
      const preDeployShaFile = getPreDeployShaFile(ctx);

      // Determine current branch
      const branchResult = run("git rev-parse --abbrev-ref HEAD");
      const branch = branchResult.ok ? branchResult.output.trim() : "main";

      // Save pre-update checkpoint so the launcher can roll back
      const headResult = run("git rev-parse HEAD");
      const preUpdateSha = headResult.ok ? headResult.output.trim() : "";
      const rollbackCheckpoint = preserveOrCreateRollbackCheckpoint(preDeployShaFile, preUpdateSha);

      // Pull latest
      const pullResult = run(`git pull --rebase origin ${branch}`);
      if (!pullResult.ok) {
        // Abort rebase if it left us in a conflicted state
        run("git rebase --abort");
        removeRollbackCheckpointIfCreated(preDeployShaFile, rollbackCheckpoint);
        const message =
          `Git pull failed — likely due to merge conflicts or network issues. ` +
          `The working tree has been restored to its previous state.\n\n` +
          pullResult.output.slice(-500);
        return toolFailure(message, { sessionLog: pullResult.output.slice(-500) });
      }

      const newFullHead = run("git rev-parse HEAD");
      const newFullSha = newFullHead.ok ? newFullHead.output.trim() : "";
      const newHead = run("git rev-parse --short HEAD");
      const newSha = newHead.ok ? newHead.output.trim() : "unknown";
      const changed = preUpdateSha !== newFullSha;

      if (!changed) {
        // Clean up checkpoint — nothing changed
        removeRollbackCheckpointIfCreated(preDeployShaFile, rollbackCheckpoint);
        return { success: true, message: "Already up to date — no restart needed." };
      }

      const releaseSlotResult = await prepareReleaseSlot({
        sourceDir: BRIDGE_TOOLS_REPO_ROOT,
        dataDir,
        commitSha: newFullSha || newSha,
        source: "self_update",
        validationMode: "deploy",
        run: async (command, cwd, options) => run(command, { cwd, timeoutMs: options?.timeoutMs }),
        log: (message) => console.log(`[self-update] ${message}`),
        installCommand: SELF_UPDATE_INSTALL_COMMAND,
        installTimeoutMs: SELF_UPDATE_INSTALL_TIMEOUT_MS,
        buildCommand: "npm run check:deploy",
        buildTimeoutMs: SELF_UPDATE_DEPLOY_CHECK_TIMEOUT_MS,
      });
      if (!releaseSlotResult.ok) {
        const resetResult = preUpdateSha ? run(`git reset --hard ${preUpdateSha}`) : { ok: true, output: "" };
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
      const releaseCandidate = releaseSlotResult.manifest;

      // Signal restart — the launcher will swap to the prepared release slot and health-check it.
      const dependencyInputsChanged = !!preUpdateSha
        && (() => {
          const diffResult = run(`git diff "${preUpdateSha}" HEAD --name-only -- ${DEPENDENCY_SYNC_GIT_PATHSPEC}`);
          return diffResult.ok && !!diffResult.output.trim();
        })();
      let otherBusy = 0;
      try {
        otherBusy = writeRestartSignalOrRollback(signalFile, "deploy", "self_update", releaseCandidate);
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
        message:
          `Updated ${preUpdateSha.slice(0, 8)} → ${newSha}. Restart queued; the launcher will swap to the prepared release slot and roll back automatically if needed.` +
          (dependencyInputsChanged ? " Dependency inputs changed — the inactive release slot has its own dependency install." : "") +
          `${waitNote} ` +
          `Do NOT make any more tool calls — this session will block the restart until idle.`,
      };
    },
  }),
  ];
}

export function registerSelfAdminTools(
  server: BridgeToolsMcpServer,
  ctx: AppContext,
  options: RegisterSelfAdminToolsOptions = {},
): void {
  const definitions = createSelfAdminToolDefinitions(ctx)
    .filter((tool) => !options.hiddenTools?.has(tool.name));
  registerBridgeToolDefinitions(server, definitions);
}
