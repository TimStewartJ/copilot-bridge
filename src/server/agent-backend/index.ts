// Entry point for AgentBackend; import from here, not @github/copilot-sdk.

import { CopilotClient } from "@github/copilot-sdk";

import { buildCopilotClientOptions } from "../copilot-client-options.js";
import { CopilotBackend } from "./copilot-backend.js";
import type { AgentBackend } from "./types.js";

export type {
  AgentBackend,
  AgentBackendFactory,
  AgentBackgroundTask,
  AgentCapabilities,
  AgentElicitationAction,
  AgentElicitationRequest,
  AgentElicitationResponse,
  AgentModelCompactionDecision,
  AgentModelInfo,
  AgentModelSwitchConfirmation,
  AgentModelSwitchResult,
  AgentCompactionResult,
  AgentPendingInteractionEvent,
  AgentPermissionDecision,
  AgentPermissionPolicy,
  AgentPermissionRequest,
  AgentSectionOverride,
  AgentSendArgs,
  AgentSlashCommandInvocation,
  AgentSlashCommandInfo,
  AgentSlashCommandInput,
  AgentSlashCommandList,
  AgentSlashCommandResult,
  AgentSession,
  AgentSessionActivity,
  AgentSessionRelease,
  AgentSessionConfig,
  AgentSessionEvent,
  AgentSessionEventHandler,
  AgentSessionSummary,
  AgentSetModelOptions,
  AgentTrajectoryClassification,
  AgentTrajectoryClassifyRequest,
  AgentTrajectoryClassifyResult,
  AgentUsageMetrics,
  AgentUserInputRequest,
  AgentUserInputResponse,
} from "./types.js";

export { CopilotBackend };

export interface CreateAgentBackendOptions {
  /** Which backend implementation to construct. */
  kind: "copilot";
  /** Env override for `buildCopilotClientOptions`, e.g. an isolated `COPILOT_HOME`. */
  clientEnv?: Record<string, string | undefined>;
  /** Directory for the scratch Copilot home that agent shells use; see agent-shell-env.ts. */
  agentShellDir?: string;
}

export function createAgentBackend(opts: CreateAgentBackendOptions): AgentBackend {
  switch (opts.kind) {
    case "copilot": {
      const options = buildCopilotClientOptions(opts.clientEnv);
      // npm-loader.js forwards to a native child, so fencing must verify both processes.
      return new CopilotBackend(new CopilotClient(options), { localStdioOwnership: true, agentShellDir: opts.agentShellDir });
    }
    default: {
      const _exhaustive: never = opts.kind;
      throw new Error(`Unknown agent backend kind: ${String(_exhaustive)}`);
    }
  }
}
