// Public entry point for the AgentBackend abstraction.
//
// Callers import from `./agent-backend` instead of reaching for
// `@github/copilot-sdk` directly. The factory exists so Step 3 can add
// `kind: "claude-code"` without touching call sites.

import { CopilotClient } from "@github/copilot-sdk";

import {
  buildCopilotClientOptions,
  type BridgeCopilotClientOptions,
} from "../copilot-client-options.js";
import { CopilotBackend } from "./copilot-backend.js";
import type { AgentBackend } from "./types.js";

export type {
  AgentBackend,
  AgentBackendFactory,
  AgentCapabilities,
  AgentClientOptions,
  AgentModelInfo,
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
  AgentSessionConfig,
  AgentSessionEventHandler,
  AgentSessionSummary,
  AgentSetModelOptions,
} from "./types.js";

export { CopilotBackend };

export interface CreateAgentBackendOptions {
  /**
   * Which backend implementation to construct. Step 1 ships only
   * `"copilot"`; Step 3 will add `"claude-code"`.
   */
  kind: "copilot";
  /**
   * Environment override forwarded into `buildCopilotClientOptions`. Use
   * to set `COPILOT_HOME` for session isolation (staging previews,
   * disposable sessions).
   */
  clientEnv?: Record<string, string | undefined>;
}

/**
 * Construct an `AgentBackend` per `opts.kind`. Step 1 only supports
 * Copilot; the dispatch lives here so future callers do not change.
 */
export function createAgentBackend(opts: CreateAgentBackendOptions): AgentBackend {
  switch (opts.kind) {
    case "copilot": {
      const options: BridgeCopilotClientOptions = buildCopilotClientOptions(opts.clientEnv);
      return new CopilotBackend(new CopilotClient(options));
    }
    default: {
      const _exhaustive: never = opts.kind;
      throw new Error(`Unknown agent backend kind: ${String(_exhaustive)}`);
    }
  }
}
