import { defineTool } from "@github/copilot-sdk";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { DEPENDENCY_SYNC_GIT_PATHSPEC } from "../dependency-sync.js";
import { isBridgeReleaseMode } from "../distribution-mode.js";
import { preserveOrCreateRollbackCheckpoint, removeRollbackCheckpointIfCreated } from "../pre-deploy-checkpoint.js";
import { clearRestartPending, isRestartPending, triggerRestartPending } from "../restart-controller.js";
import { toolFailure } from "../tool-results.js";
import type { AppContext } from "../app-context.js";
import { BRIDGE_TOOLS_REPO_ROOT } from "./helpers.js";

function run(cmd: string): { ok: boolean; output: string } {
  try {
    const output = execSync(cmd, { cwd: BRIDGE_TOOLS_REPO_ROOT, encoding: "utf-8", timeout: 120_000 });
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

function writeRestartSignalOrRollback(signalFile: string): number {
  const otherBusy = triggerRestartPending();
  try {
    writeFileSync(signalFile, new Date().toISOString());
  } catch (error) {
    cleanupFailedRestartSignal(signalFile);
    throw error;
  }
  return otherBusy;
}

export function createSelfAdminTools(ctx: AppContext) {
  return [
  defineTool("self_restart", {
    description: "Restart the Copilot Bridge server WITHOUT code changes (config reload, env changes, emergency restart). For deploying code changes, use staging_init → make changes → staging_deploy instead. The launcher will auto-checkpoint, rebuild, and swap processes. IMPORTANT: This session counts as active — do not make further tool calls after invoking this, or you will block the restart. RESTRICTED: Only the primary session agent may call this tool. Sub-agents spawned via the task tool must NEVER call this.",
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
        otherBusy = writeRestartSignalOrRollback(signalFile);
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
  defineTool("self_update", {
    description:
      "Pull the latest code from the remote repository and restart the server. " +
      "Use this to update the Copilot Bridge to the latest version without the full staging workflow. " +
      "Saves a rollback checkpoint before pulling so the launcher can sync dependencies, rebuild, health-check, and roll back if needed. " +
      "IMPORTANT: Do not make further tool calls after invoking this — the server will restart. " +
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

      const newHead = run("git rev-parse --short HEAD");
      const newSha = newHead.ok ? newHead.output.trim() : "unknown";
      const changed = preUpdateSha !== (run("git rev-parse HEAD").ok ? run("git rev-parse HEAD").output.trim() : "");

      if (!changed) {
        // Clean up checkpoint — nothing changed
        removeRollbackCheckpointIfCreated(preDeployShaFile, rollbackCheckpoint);
        return { success: true, message: "Already up to date — no restart needed." };
      }

      // Signal restart — launcher will sync dependencies, build, health-check, and roll back if needed
      const dependencyInputsChanged = !!preUpdateSha
        && (() => {
          const diffResult = run(`git diff "${preUpdateSha}" HEAD --name-only -- ${DEPENDENCY_SYNC_GIT_PATHSPEC}`);
          return diffResult.ok && !!diffResult.output.trim();
        })();
      let otherBusy = 0;
      try {
        otherBusy = writeRestartSignalOrRollback(signalFile);
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
          `Updated ${preUpdateSha.slice(0, 8)} → ${newSha}. Restart queued; the launcher will sync dependencies, rebuild, and roll back automatically if needed.` +
          (dependencyInputsChanged ? " Dependency inputs changed — production dependency sync will happen during restart only." : "") +
          `${waitNote} ` +
          `Do NOT make any more tool calls — this session will block the restart until idle.`,
      };
    },
  }),
  ];
}
