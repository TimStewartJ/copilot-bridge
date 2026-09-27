import type { AgentPermissionPolicy, AgentSectionOverride } from "./agent-backend/index.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBridgeControlRoot } from "./control-root.js";
import type { Task } from "./task-store.js";
import type { ChecklistStore } from "./checklist-store.js";
import type { SettingsStore } from "./settings-store.js";
import { resolveSubagentSettings, type ResolvedSubagentSettings } from "../shared/subagent-settings.js";
import type { TagStore } from "./tag-store.js";
import type { DocsIndex } from "./docs-index.js";
import type { DocsStore } from "./docs-store.js";
import {
  toRuntimeMcpServerConfigs,
  type McpServerConfig,
} from "./mcp-config.js";
import type { McpServerStore } from "./mcp-server-store.js";
import type { RuntimePaths } from "./runtime-paths.js";
import {
  TaskAgentDefinitionValidationError,
  toCopilotCustomAgentConfig,
  type TaskAgentDefinitionStore,
} from "./task-agent-definition-store.js";
import { isBridgeSourceManagementAvailable } from "./distribution-mode.js";
import {
  AGENT_LIFECYCLE_GUIDANCE,
  ASK_OR_PROCEED_GUIDANCE,
  BRIDGE_EXCLUDED_TOOLS,
  BROWSER_GUIDANCE,
  COMPUTER_USE_OFF_GUIDANCE,
  DEFAULT_IDENTITY,
  HOME_GUIDANCE,
  createCodingModeStatementRemover,
  removeCliOutputSurfaceNote,
  removeConciseReplyDirective,
  RESEARCH_GUIDANCE,
  RESPONSE_QUALITY_GUIDANCE,
  STAGING_INSTRUCTIONS,
  TOOL_NAMING_GUIDANCE,
  WORK_REFERENCE_GUIDANCE,
  WRITING_GUIDANCE,
} from "./session-instructions.js";
import { renderResponseStyle } from "../shared/response-style.js";
import {
  buildGitHubCopilotMcpToolConfig,
  buildGitHubCopilotSearchMcpServer,
  GITHUB_COPILOT_MCP_SERVER_NAME,
} from "./github-copilot-mcp.js";
import {
  getModelCapabilitiesOverride,
  normalizeCopilotContextTier,
  resolveContextTierForModel,
  type CopilotContextTier,
  type CopilotModelContextMetadata,
} from "../shared/copilot-context.js";
import { pathsEqual } from "./path-utils.js";
import type { PromptProfileId } from "../shared/prompt-profiles.js";
import type { SessionPromptProfileStore } from "./session-prompt-profile-store.js";
import {
  formatPreviousRunReport,
  LEGACY_PROMPT_PROFILE,
  PROMPT_PROFILE_DEFINITIONS,
  type PreviousRunReport,
} from "./prompt-profiles.js";
import { resolveComputerUsePlugin, type ComputerUsePluginStatus } from "./computer-use-plugin.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolveBridgeControlRoot(join(__dirname, "..", ".."));

export interface ScheduleContext {
  name: string;
  type: "cron" | "once";
  runCount: number;
  lastRunAt?: string;
  model?: string;
  reasoningEffort?: string;
  contextTier?: CopilotContextTier;
  promptProfile?: PromptProfileId;
  /** The session of the schedule's previous run. */
  previousSessionId?: string;
  /** What the previous run left; Monitor compares against it. */
  previousRunReport?: PreviousRunReport;
}

export interface SessionConfigOptions {
  sessionId?: string;
  task?: Task | null;
  isNewTask?: boolean;
  scheduleContext?: ScheduleContext;
  modelOverride?: string;
  reasoningEffortOverride?: string;
  contextTierOverride?: CopilotContextTier;
  agentOverride?: string;
  /**
   * The chat's profile. Session creation resolves and passes it; resume reads the stored choice.
   * Chats created before profiles existed have none and keep the legacy (Engineer) prompt.
   */
  promptProfile?: PromptProfileId;
  /**
   * When true, omit `model` and `reasoningEffort` from the config.
   * The SDK silently overwrites _selectedModel via updateOptions() without sanitizing
   * chat history, so passing those on resume would corrupt cross-family tool_call
   * shapes. Resume trusts the SDK's persisted session model (recorded in session
   * event logs) rather than re-applying the global settings default.
   */
  forResume?: boolean;
  modelMetadata?: readonly CopilotModelContextMetadata[];
}

export interface SessionConfigBuilderDeps {
  checklistStore?: ChecklistStore;
  taskAgentDefinitionStore?: TaskAgentDefinitionStore;
  settingsStore?: SettingsStore;
  tagStore?: TagStore;
  mcpServerStore?: McpServerStore;
  docsIndex?: DocsIndex;
  docsStore?: DocsStore;
  config: { sessionMcpServers: Record<string, McpServerConfig>; model?: string };
  builtInMcpServers?: Record<string, McpServerConfig>;
  resolveBuiltInMcpServers?: (opts: { sessionId?: string }) => Record<string, McpServerConfig>;
  nativeBridgeTools?: readonly unknown[];
  permissionPolicy?: AgentPermissionPolicy;
  clientEnv?: Record<string, string | undefined>;
  runtimePaths?: RuntimePaths;
  resolveComputerUsePlugin?: () => ComputerUsePluginStatus;
  sessionPromptProfileStore?: Pick<SessionPromptProfileStore, "getPromptProfile">;
}

export interface SessionConfigBuilderCallbacks {
  resolveEffectiveSessionCwd(opts: { sessionId?: string; task?: Pick<Task, "cwd"> | null }): string | undefined;
  getCopilotHome(): string;
}

export interface BuildSessionConfigParams {
  deps: SessionConfigBuilderDeps;
  options?: SessionConfigOptions;
  callbacks: SessionConfigBuilderCallbacks;
}

function resolveSessionMcpServers(
  deps: SessionConfigBuilderDeps,
  tagSelectedServerIds: string[] = [],
): Record<string, McpServerConfig> {
  if (!deps.mcpServerStore) {
    return deps.settingsStore?.getMcpServers() ?? deps.config.sessionMcpServers;
  }

  const byId = new Map<string, { name: string; config: McpServerConfig }>();
  for (const server of deps.mcpServerStore.listMcpServers()) {
    if (server.enabledByDefault) {
      byId.set(server.id, { name: server.name, config: server.config });
    }
  }
  for (const serverId of tagSelectedServerIds) {
    if (byId.has(serverId)) continue;
    const server = deps.mcpServerStore.getMcpServer(serverId);
    if (!server) continue;
    byId.set(server.id, { name: server.name, config: server.config });
  }

  const resolved: Record<string, McpServerConfig> = {};
  for (const server of byId.values()) {
    resolved[server.name] = server.config;
  }
  return resolved;
}

function addBuiltInMcpServers(
  deps: SessionConfigBuilderDeps,
  servers: Record<string, McpServerConfig>,
  sessionId?: string,
): Record<string, McpServerConfig> {
  const merged = {
    ...servers,
    ...(deps.builtInMcpServers ?? {}),
    ...(deps.resolveBuiltInMcpServers?.({ sessionId }) ?? {}),
  };
  const builtInServer = buildGitHubCopilotSearchMcpServer(deps.clientEnv);
  if (!builtInServer || merged[builtInServer.name]) return merged;
  return { ...merged, [builtInServer.name]: builtInServer.config };
}

function shouldUseSdkGitHubMcp(
  deps: SessionConfigBuilderDeps,
  servers: Record<string, McpServerConfig>,
): boolean {
  return !buildGitHubCopilotSearchMcpServer(deps.clientEnv)
    && !servers[GITHUB_COPILOT_MCP_SERVER_NAME];
}

// The runtime silently runs a different model for an unavailable sub-agent
// model and fails a sub-agent whose effort its model does not support, so
// Bridge omits both and lets the runtime choose. Warn once per value.
const warnedDroppedSubagentValues = new Set<string>();
function warnDroppedSubagentModels(
  requested: ResolvedSubagentSettings | undefined,
  applied: ResolvedSubagentSettings,
): void {
  for (const [name, entry] of Object.entries(requested?.agents ?? {})) {
    const kept = applied.agents[name];
    const droppedModel = entry.model && !kept?.model ? entry.model : undefined;
    const droppedEffort = !droppedModel && entry.effortLevel && !kept?.effortLevel ? entry.effortLevel : undefined;
    const key = droppedModel ? `model:${droppedModel}` : droppedEffort ? `effort:${entry.model}:${droppedEffort}` : undefined;
    if (!key || warnedDroppedSubagentValues.has(key)) continue;
    warnedDroppedSubagentValues.add(key);
    console.warn(droppedModel
      ? `[sdk] Sub-agent model ${droppedModel} is not in the model list; ${name} uses the runtime default`
      : `[sdk] ${entry.model} does not support reasoning effort ${droppedEffort}; ${name} uses the model default`);
  }
}

export function buildSessionConfig(params: BuildSessionConfigParams) {
  const { deps, callbacks } = params;
  const {
    sessionId,
    task,
    isNewTask,
    scheduleContext,
    modelOverride,
    reasoningEffortOverride,
    contextTierOverride,
    agentOverride,
    forResume,
  } = params.options ?? {};
  const workingDirectory = callbacks.resolveEffectiveSessionCwd({ sessionId, task });

  const resolvedMcpServers = resolveSessionMcpServers(deps);
  const taskAgentDefinitions = task
    ? deps.taskAgentDefinitionStore?.listTaskAgentDefinitions(task.id) ?? []
    : [];
  const hasTaskAgentDefinitions = taskAgentDefinitions.length > 0;
  const selectedTaskAgent = agentOverride?.trim();
  if (selectedTaskAgent) {
    const definition = taskAgentDefinitions.find((candidate) => candidate.name === selectedTaskAgent);
    if (!definition) {
      throw new TaskAgentDefinitionValidationError(
        `Agent definition "${selectedTaskAgent}" is not available for task ${task?.id ?? "unknown"}`,
      );
    }
    if (!definition.userInvocable) {
      throw new TaskAgentDefinitionValidationError(
        `Agent definition "${selectedTaskAgent}" cannot be selected for a new chat`,
      );
    }
  }
  const cfg: any = {
    pendingInteractionEvents: true,
    enableExperimentalMode: true,
    streaming: true,
    includeSubAgentStreamingEvents: false,
    excludedTools: [...BRIDGE_EXCLUDED_TOOLS],
    mcpServers: toRuntimeMcpServerConfigs(
      addBuiltInMcpServers(deps, resolvedMcpServers, sessionId),
    ),
    ...(deps.nativeBridgeTools && deps.nativeBridgeTools.length > 0 ? { tools: deps.nativeBridgeTools } : {}),
    skillDirectories: [
      join(REPO_ROOT, "skills"),
      join(callbacks.getCopilotHome(), "skills"),
    ],
    ...(hasTaskAgentDefinitions
      ? { customAgents: taskAgentDefinitions.map(toCopilotCustomAgentConfig) }
      : {}),
    ...(hasTaskAgentDefinitions ? { customAgentsLocalOnly: true } : {}),
    ...(!forResume && selectedTaskAgent ? { agent: selectedTaskAgent } : {}),
  };
  // Explicitly disable Copilot's cloud-backed agentic memory. The feature stores
  // and recalls facts via the remote Memory API (`/v1/memory_stores/.../memories`)
  // with user- or repository-scoped visibility, and is designed around a per-store
  // human confirmation prompt. The Bridge uses native automatic tool approvals,
  // which would let sessions silently persist memories server-side — and repository
  // scope shares them with repo collaborators. Forwarded on both create and resume
  // so memory stays off even when resuming older sessions.
  cfg.memory = { enabled: false };

  if (deps.permissionPolicy) {
    cfg.onPermissionRequest = deps.permissionPolicy;
  }

  if (shouldUseSdkGitHubMcp(deps, resolvedMcpServers)) {
    cfg.githubMcpToolConfig = buildGitHubCopilotMcpToolConfig();
  }

  const settings = deps.settingsStore?.getSettings();
  // Applied on create and resume: the runtime drops this override on resume.
  const subagents = resolveSubagentSettings(settings?.subagents, params.options?.modelMetadata);
  if (subagents) {
    cfg.subagents = subagents;
    warnDroppedSubagentModels(resolveSubagentSettings(settings?.subagents), subagents);
  }

  // Computer Use is upstream's plugin from the SDK platform package. Loading it per
  // session keeps the Bridge setting as the only gate, independent of CLI user settings.
  const computerUseEnabled = settings?.computerUse?.enabled === true;
  const computerUsePlugin = computerUseEnabled
    ? (deps.resolveComputerUsePlugin ?? resolveComputerUsePlugin)()
    : undefined;
  if (computerUsePlugin?.available && computerUsePlugin.pluginDirectory) {
    cfg.pluginDirectories = [computerUsePlugin.pluginDirectory];
  }

  // Model + reasoningEffort only belong on createSession. On resume the SDK
  // overwrites _selectedModel without sanitizing chat history (which corrupts
  // cross-family tool_call shapes). Resume intentionally trusts the SDK's
  // persisted session model; only Bridge-owned runtime config (tools, MCP,
  // user-input handlers, system context) is refreshed on resume.
  if (!forResume) {
    if (sessionId) cfg.sessionId = sessionId;

    // Explicit launch override > schedule override > settings store > deps.config > SDK default
    const explicitModelOverride = modelOverride ?? scheduleContext?.model;
    const model = explicitModelOverride ?? settings?.model ?? deps.config.model;
    if (model) cfg.model = model;

    const selectedModelMetadata = model
      ? params.options?.modelMetadata?.find((candidate) => candidate.id === model)
      : undefined;

    // An explicit model override must not inherit an unsupported effort from
    // the global model. Unknown override models use their SDK default.
    const scheduleReasoningEffort = scheduleContext?.reasoningEffort;
    if (reasoningEffortOverride) {
      cfg.reasoningEffort = reasoningEffortOverride;
    } else if (
      scheduleReasoningEffort
      && (
        !selectedModelMetadata
        || selectedModelMetadata.supportedReasoningEfforts?.includes(scheduleReasoningEffort)
      )
    ) {
      cfg.reasoningEffort = scheduleReasoningEffort;
    } else {
      const reasoningEffort = settings?.reasoningEffort;
      const overrideModelSupportsGlobalEffort = !explicitModelOverride
        || selectedModelMetadata?.supportedReasoningEfforts?.includes(reasoningEffort ?? "") === true;
      if (reasoningEffort && overrideModelSupportsGlobalEffort) {
        cfg.reasoningEffort = reasoningEffort;
      }
    }

    const requestedContextTier = contextTierOverride
      ?? scheduleContext?.contextTier
      ?? normalizeCopilotContextTier(settings?.contextTier);
    const contextTier = selectedModelMetadata
      ? resolveContextTierForModel(selectedModelMetadata, requestedContextTier)
      : requestedContextTier;
    if (contextTier) cfg.contextTier = contextTier;
    const modelCapabilities = getModelCapabilitiesOverride(selectedModelMetadata, contextTier);
    if (modelCapabilities) cfg.modelCapabilities = modelCapabilities;
  }

  if (workingDirectory) {
    cfg.workingDirectory = workingDirectory;
  }

  // The Bridge never wants the runtime's commit Co-authored-by instruction.
  cfg.coauthorEnabled = false;

  // Keep stable guidance ahead of mutable task, tag, and docs context.
  const contextParts: string[] = [
    RESPONSE_QUALITY_GUIDANCE,
    ASK_OR_PROCEED_GUIDANCE,
    ...(settings?.customInstructions?.trim() ? [settings.customInstructions.trim()] : []),
    RESEARCH_GUIDANCE,
    HOME_GUIDANCE,
    TOOL_NAMING_GUIDANCE,
    WORK_REFERENCE_GUIDANCE,
    ...(computerUseEnabled ? [] : [COMPUTER_USE_OFF_GUIDANCE]),
  ];

  if (task) {
    contextParts.push(
      `You are helping with a Bridge task (taskId: ${task.id}). Its latest state (title, status, links, where things stand, notes, checklist and recent history) arrives in <bridge_context> blocks at the start of user messages.`,
      "Use the task tools to manage linked resources when you discover relevant work items or PRs.",
    );
    if (isNewTask) {
      contextParts.push(
        "This task was just created without a title. After reading the user's first message, use the task update tool to set a concise, descriptive title (3-6 words). Do this silently without mentioning it to the user.",
      );
    }
    if (task.instructions?.trim()) {
      contextParts.push(`<task_instructions>\nStanding rules for this task. Follow them in every session.\n${task.instructions.trim()}\n</task_instructions>`);
    }
    if (taskAgentDefinitions.length > 0) {
      const definitions = taskAgentDefinitions.map((definition) => {
        const invocation = definition.infer ? "automatic or explicit" : "explicit only";
        const description = definition.description.replace(/\s+/g, " ");
        const tools = definition.tools === null
          ? "all session tools"
          : definition.tools.length === 0
            ? "no tools"
            : definition.tools.join(", ");
        return `- ${definition.name}: ${description} (${invocation}; tools: ${tools})`;
      }).join("\n");
      contextParts.push(
        `Task agent definitions available through Copilot's native task/custom-agent surface:\n${definitions}`,
      );
    }
  }

  const promptProfileId = params.options?.promptProfile
    ?? (sessionId ? deps.sessionPromptProfileStore?.getPromptProfile(sessionId) : undefined)
    ?? LEGACY_PROMPT_PROFILE;
  const promptProfile = PROMPT_PROFILE_DEFINITIONS[promptProfileId];

  if (scheduleContext) {
    const kind = scheduleContext.type === "cron" ? "recurring" : "one-time";
    const runLabel = scheduleContext.runCount > 0
      ? `, run #${scheduleContext.runCount + 1}`
      : "";
    contextParts.push(
      `\nThis session was triggered by schedule "${scheduleContext.name}" (${kind}${runLabel}). There is no human waiting — work autonomously and avoid asking clarifying questions.`,
    );
    if (promptProfileId === "monitor") {
      contextParts.push(formatPreviousRunReport(scheduleContext.previousRunReport));
    }
  }

  // Staging rules — only when working on the bridge repo itself. A session without a
  // resolved cwd is not evidence of Bridge work.
  const isSelfRepo = !!workingDirectory && pathsEqual(workingDirectory, REPO_ROOT);
  const sections: Partial<Record<string, AgentSectionOverride>> = {};
  // The staging workflow is an operational rule of this repository, so it applies whatever
  // the profile; only the CLI's general coding rules depend on the profile.
  const stagingApplies = isSelfRepo
    && isBridgeSourceManagementAvailable(deps.runtimePaths?.env ?? process.env, REPO_ROOT);
  if (promptProfile.keepCodingRules) {
    if (stagingApplies) sections.code_change_rules = { action: "append", content: STAGING_INSTRUCTIONS };
  } else {
    sections.code_change_rules = stagingApplies
      ? { action: "replace", content: STAGING_INSTRUCTIONS }
      : { action: "remove" };
  }

  // `identity` is a section group that also carries tone, tool efficiency, search
  // guidance and the model self-identification, so only the preamble is replaced.
  // Child overrides apply before the group transform sees the rendered group.
  const identityText = settings?.identity?.trim() || DEFAULT_IDENTITY;
  const preambleText = `${identityText}\n\n${promptProfile.role}`;
  sections.identity = { action: createCodingModeStatementRemover(preambleText) };
  sections.preamble = { action: "replace", content: preambleText };
  // The CLI's tone differs by model family and conflicts with the Bridge style setting.
  sections.tone = {
    action: "replace",
    content: `${renderResponseStyle(settings?.responseStyle)}\n\n${WRITING_GUIDANCE}\n\n${promptProfile.communication}`,
  };
  sections.guidelines = { action: "append", content: promptProfile.approach };
  sections.tool_efficiency = { action: removeCliOutputSurfaceNote };
  sections.last_instructions = { action: removeConciseReplyDirective };

  // Tighten the SDK's native task/write_agent contract and teach web_fetch escalation
  // without replacing the broader per-tool guidance.
  sections.tool_instructions = {
    action: "append",
    content: `${AGENT_LIFECYCLE_GUIDANCE}\n\n${BROWSER_GUIDANCE}`,
  };

  // Tag-based configuration — resolve effective tags and merge instructions + MCP servers
  if (task && deps.tagStore) {
    const resolved = deps.tagStore.resolveEffectiveTags(task.id, task.groupId);
    if (resolved.mergedInstructions) {
      contextParts.push(`\n<tag_instructions>\n${resolved.mergedInstructions}\n</tag_instructions>`);
    }
    // Merge tag-selected MCP registry servers into session config.
    if (resolved.mcpServerIds.length > 0) {
      cfg.mcpServers = addBuiltInMcpServers(
        deps,
        resolveSessionMcpServers(deps, resolved.mcpServerIds),
        sessionId,
      );
    }
  }

  // Upstream current_datetime now carries a local offset, but we still expose the
  // server's IANA zone name for scheduling and timezone-specific prompts.
  const serverTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  sections.environment_context = { action: "append", content: `\n* Server timezone: ${serverTz}` };

  const hasContent = contextParts.length > 0;

  cfg.systemMessage = {
    mode: "customize" as const,
    sections,
    content: hasContent ? contextParts.join("\n") : undefined,
  };

  return cfg;
}
