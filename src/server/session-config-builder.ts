import { userNameLine } from "../shared/user-name.js";
import type { AgentPermissionPolicy } from "./agent-backend/index.js";
import type { ShellAuthHandler } from "./shell-auth-requests.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBridgeControlRoot } from "./control-root.js";
import type { Task } from "./task-store.js";
import type { ChecklistStore } from "./checklist-store.js";
import { isImageGenerationEnabled, type SettingsStore } from "./settings-store.js";
import { buildSubagentPlan, type SubagentPlan } from "../shared/subagent-settings.js";
import { MODEL_PRESET_SLOTS } from "../shared/model-presets.js";
import { isModelUsable, resolveModelRole, resolveModelTier } from "./model-roles.js";
import type { ModelPresetSlot } from "../shared/model-presets.js";
import type { TagStore } from "./tag-store.js";
import type { DocsIndex } from "./docs-index.js";
import type { DocsStore } from "./docs-store.js";
import {
  toRuntimeMcpServerConfigs,
  type McpServerConfig,
} from "./mcp-config.js";
import type { McpServerStore } from "./mcp-server-store.js";
import type { RuntimePaths } from "./runtime-paths.js";
import { isBridgeSourceManagementAvailable } from "./distribution-mode.js";
import {
  AGENT_LIFECYCLE_GUIDANCE,
  ASK_OR_PROCEED_GUIDANCE,
  ASK_USER_CONTEXT_GUIDANCE,
  BRIDGE_EXCLUDED_TOOLS,
  BROWSER_GUIDANCE,
  COMPUTER_USE_CUA_MISSING_GUIDANCE,
  COMPUTER_USE_OFF_GUIDANCE,
  computerUseCuaGuidance,
  DEFAULT_IDENTITY,
  HOME_GUIDANCE,
  IMAGE_GENERATION_GUIDANCE,
  LONG_RUNNING_WORK_GUIDANCE,
  applyAdaptiveReplyDirective,
  applyConciseReplyDirective,
  createCodingModeStatementRemover,
  removeCliOutputSurfaceNote,
  removeConciseReplyDirective,
  RESEARCH_GUIDANCE,
  RESPONSE_QUALITY_GUIDANCE,
  STAGING_INSTRUCTIONS,
  TOOL_NAMING_GUIDANCE,
  WORK_REFERENCE_GUIDANCE,
  DOC_LINK_GUIDANCE,
  WRITING_GUIDANCE,
} from "./session-instructions.js";
import { renderResponseStyle, resolveResponseStyle } from "../shared/response-style.js";
import {
  buildGitHubCopilotMcpToolConfig,
  buildGitHubCopilotSearchMcpServer,
  GITHUB_COPILOT_MCP_SERVER_NAME,
} from "./github-copilot-mcp.js";
import {
  normalizeCopilotContextTier,
  resolveContextTierForModel,
  type CopilotContextTier,
  type CopilotModelContextMetadata,
} from "../shared/copilot-context.js";
import { pathsEqual } from "./path-utils.js";
import { formatPreviousRunReport, type PreviousRunReport } from "./scheduled-run-report.js";
import { BASE_METHOD, BASE_METHOD_REPORTING, BASE_METHOD_ROLE } from "./base-method.js";
import { formatModelRolesBlock, formatSkillRolesBlock, type SkillCatalog } from "./skill-catalog.js";
import { getBundledSkillsDir, getHomeSkillsDir, type SkillPackRoot } from "./skills-registry.js";
import { resolveComputerUsePlugin, type ComputerUsePluginStatus } from "./computer-use-plugin.js";
import {
  buildCuaMcpServerConfig,
  createCuaForegroundGuard,
  CUA_FOREGROUND_REQUEST_TOOL,
  CUA_MCP_SERVER_NAME,
  type CuaDriverStatus,
} from "./cua-driver.js";
import { readSecondsSinceLastInput } from "./platform.js";
import { resolveComputerUseAwayMinutes, resolveComputerUseEngine } from "./settings-store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolveBridgeControlRoot(join(__dirname, "..", ".."));

export interface ScheduleContext {
  name: string;
  type: "cron" | "once";
  runCount: number;
  lastRunAt?: string;
  /** Resolved against Settings › Models when the session is created; unset follows New chats. */
  modelTier?: ModelPresetSlot;
  /** The playbook the trigger pins for the chats it starts. */
  playbook?: string;
  /** The chat the trigger started last time. */
  previousSessionId?: string;
  /** What the previous run left, for playbooks that compare runs (Watch, Sweep). */
  previousRunReport?: PreviousRunReport;
}

export interface SessionConfigOptions {
  sessionId?: string;
  task?: Task | null;
  /** Adds only this task's tag-linked MCP servers (for trigger workers), not its prompt or cwd. */
  mcpServerTask?: Pick<Task, "id" | "groupId"> | null;
  scheduleContext?: ScheduleContext;
  modelOverride?: string;
  reasoningEffortOverride?: string;
  contextTierOverride?: CopilotContextTier;
  /** Starts the chat on this tier, the way a schedule's own tier does: a model A/B test arm. */
  modelTier?: ModelPresetSlot;
  /** Replaces the base method's role sentence in the preamble (Helm's chat says it is Helm). */
  promptRole?: string;
  /** Guidance appended after the Bridge's own, for chats with a role of their own (Helm). */
  extraGuidance?: string;
  /** Omits model and effort: the SDK swaps models on resume without fixing history's tool calls. */
  forResume?: boolean;
  modelMetadata?: readonly CopilotModelContextMetadata[];
}

export interface SessionConfigBuilderDeps {
  checklistStore?: ChecklistStore;
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
  /** Answers shell command prompts such as passwords; only for chats a person can answer. */
  shellAuthenticationHandler?: ShellAuthHandler;
  clientEnv?: Record<string, string | undefined>;
  runtimePaths?: RuntimePaths;
  resolveComputerUsePlugin?: () => ComputerUsePluginStatus;
  /** Cua Driver's install state; without it the Cua engine has no tools. */
  resolveCuaDriver?: () => CuaDriverStatus;
  /** Seconds since the user's last input on this PC; defaults to the Windows session's reading. */
  readIdleSeconds?: () => Promise<number | undefined>;
  computerUsePlatform?: NodeJS.Platform;
  /** The last skill scan: playbooks, roles and extensions for <skill_roles>. */
  skillCatalog?: Pick<SkillCatalog, "current">;
  /** Skill packs a chat loads, given its task's tag names. */
  skillPacks?: { activeRoots(taskTagNames?: readonly string[]): SkillPackRoot[] };
}

export interface SessionConfigBuilderCallbacks {
  resolveEffectiveSessionCwd(opts: { sessionId?: string; task?: Pick<Task, "cwd"> | null }): string | undefined;
  getCopilotHome(): string;
  /** True for the Bridge's own scratch folder, which is not a project the user works in. */
  isNeutralWorkspaceCwd?(cwd: string): boolean;
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

/** Runtime keeps the first skill per name, so home overrides packs, which override bundled. */
export function orderSkillDirectories(dirs: { bundled: string; packs: readonly string[]; home: string }): string[] {
  return [...new Set([dirs.home, ...dirs.packs, dirs.bundled])];
}

type CuaForegroundGuard = ReturnType<typeof createCuaForegroundGuard>;

/** The create or resume config a chat's session gets, as the backend takes it. */
type BuiltSessionConfigBase = {
  pendingInteractionEvents: boolean;
  enableExperimentalMode: boolean;
  enableConfigDiscovery: boolean;
  enableFileHooks: boolean;
  streaming: boolean;
  includeSubAgentStreamingEvents: boolean;
  excludedTools: string[];
  mcpServers: Record<string, McpServerConfig>;
  tools?: readonly unknown[];
  skillDirectories: string[];
  memory?: { enabled: boolean };
  onPermissionRequest?: AgentPermissionPolicy;
  onShellAuthenticationRequest?: ShellAuthHandler;
  githubMcpToolConfig?: ReturnType<typeof buildGitHubCopilotMcpToolConfig>;
  subagents?: SubagentPlan;
  fusionContextTokens?: number;
  hooks?: {
    onPreToolUse: CuaForegroundGuard["beforeToolUse"];
    onPostToolUse: CuaForegroundGuard["afterToolUse"];
    onPostToolUseFailure: CuaForegroundGuard["afterToolUse"];
  };
  pluginDirectories?: string[];
  imageGeneration?: { enabled: boolean };
  sessionId?: string;
  model?: string;
  reasoningEffort?: string;
  contextTier?: CopilotContextTier;
  workingDirectory?: string;
  coauthorEnabled?: boolean;
  /** Set by callers (resume options) and profiles on top of what is built here. */
  [key: string]: unknown;
};

type TransformSection = { action: (content: string) => string };
type TextSection<A extends "replace" | "append"> = { action: A; content: string };

/** The system prompt sections every chat overrides, in the order they are set. */
export type BuiltSystemMessageSections = {
  code_change_rules?: TextSection<"replace" | "append"> | { action: "remove"; content?: undefined };
  identity: TransformSection;
  preamble: TextSection<"replace">;
  tone: TextSection<"replace">;
  guidelines: TextSection<"append">;
  tool_efficiency: TransformSection;
  last_instructions: TransformSection;
  tool_instructions: TextSection<"append">;
  environment_context: TextSection<"append">;
};

export type BuiltSessionConfig = BuiltSessionConfigBase & {
  systemMessage: {
    mode: "customize";
    sections: BuiltSystemMessageSections;
    content: string;
  };
};

export function buildSessionConfig(params: BuildSessionConfigParams): BuiltSessionConfig {
  const { deps, callbacks } = params;
  const {
    sessionId,
    task,
    scheduleContext,
    modelOverride,
    reasoningEffortOverride,
    contextTierOverride,
    modelTier,
    forResume,
  } = params.options ?? {};
  const workingDirectory = callbacks.resolveEffectiveSessionCwd({ sessionId, task });
  const hasProjectFolder = !!workingDirectory && !callbacks.isNeutralWorkspaceCwd?.(workingDirectory);

  // Tags decide tag-linked MCP servers, tag instructions and which skill packs this chat loads.
  const tagTask = task ?? params.options?.mcpServerTask;
  const resolvedTags = tagTask && deps.tagStore
    ? deps.tagStore.resolveEffectiveTags(tagTask.id, tagTask.groupId)
    : undefined;
  const catalogSkills = deps.skillCatalog?.current() ?? [];
  const activePacks = deps.skillPacks?.activeRoots(resolvedTags?.tags.map((tag) => tag.name)) ?? [];
  const packSkillDirs = activePacks.map((pack) => catalogSkills.find((skill) => skill.packId === pack.id)?.skillsDir ?? pack.root);

  const resolvedMcpServers = resolveSessionMcpServers(deps);
  const cfg: BuiltSessionConfigBase = {
    pendingInteractionEvents: true,
    enableExperimentalMode: true,
    enableConfigDiscovery: Boolean(workingDirectory),
    enableFileHooks: false,
    streaming: true,
    includeSubAgentStreamingEvents: false,
    excludedTools: [...BRIDGE_EXCLUDED_TOOLS],
    mcpServers: toRuntimeMcpServerConfigs(
      addBuiltInMcpServers(deps, resolvedMcpServers, sessionId),
    ),
    ...(deps.nativeBridgeTools && deps.nativeBridgeTools.length > 0 ? { tools: deps.nativeBridgeTools } : {}),
    skillDirectories: orderSkillDirectories({
      bundled: getBundledSkillsDir(REPO_ROOT),
      packs: packSkillDirs,
      home: getHomeSkillsDir(callbacks.getCopilotHome()),
    }),
  };
  // Cloud memory off: auto-approvals would save memories server-side; set on resume too.
  cfg.memory = { enabled: false };

  if (deps.permissionPolicy) {
    cfg.onPermissionRequest = deps.permissionPolicy;
  }
  if (deps.shellAuthenticationHandler) {
    cfg.onShellAuthenticationRequest = deps.shellAuthenticationHandler;
  }

  if (shouldUseSdkGitHubMcp(deps, resolvedMcpServers)) {
    cfg.githubMcpToolConfig = buildGitHubCopilotMcpToolConfig();
  }

  const settings = deps.settingsStore?.getSettings();
  // Sent again on resume (the runtime drops it) and on model change (rubber-duck's depends on it).
  if (settings) {
    const models = params.options?.modelMetadata;
    cfg.subagents = buildSubagentPlan({
      helpers: resolveModelRole(settings, "subagents", models),
      reviewers: resolveModelRole(settings, "reviewers", models),
      tiers: [...MODEL_PRESET_SLOTS].reverse().map((slot) => settings.modelPresets?.[slot]),
    }, models);
  }
  // Experimental setting; the Copilot backend applies it only to a session on Fusion.
  const fusionContextTokens = settings?.experimental?.fusionContextTokens;
  if (fusionContextTokens !== undefined) cfg.fusionContextTokens = fusionContextTokens;

  // Cua Driver MCP (Windows default) or the SDK's Computer Use plugin; the setting gates both.
  const computerUseEnabled = settings?.computerUse?.enabled === true;
  const computerUseEngine = resolveComputerUseEngine(settings, deps.computerUsePlatform);
  let computerUseGuidance: string | undefined = computerUseEnabled ? undefined : COMPUTER_USE_OFF_GUIDANCE;
  let cuaMcpServer: McpServerConfig | undefined;
  if (computerUseEnabled && computerUseEngine === "cua") {
    const cua = deps.resolveCuaDriver?.();
    if (cua?.installed && cua.executablePath) {
      const awayAfterMinutes = resolveComputerUseAwayMinutes(settings);
      cuaMcpServer = toRuntimeMcpServerConfigs({ [CUA_MCP_SERVER_NAME]: buildCuaMcpServerConfig(cua.executablePath) })[CUA_MCP_SERVER_NAME];
      const guard = createCuaForegroundGuard({
        awayAfterMinutes,
        readIdleSeconds: deps.readIdleSeconds ?? (() => readSecondsSinceLastInput()),
      });
      cfg.hooks = {
        onPreToolUse: guard.beforeToolUse,
        onPostToolUse: guard.afterToolUse,
        onPostToolUseFailure: guard.afterToolUse,
      };
      computerUseGuidance = computerUseCuaGuidance(awayAfterMinutes);
    } else {
      computerUseGuidance = COMPUTER_USE_CUA_MISSING_GUIDANCE;
    }
  } else if (computerUseEnabled) {
    const computerUsePlugin = (deps.resolveComputerUsePlugin ?? resolveComputerUsePlugin)();
    if (computerUsePlugin.available && computerUsePlugin.pluginDirectory) {
      cfg.pluginDirectories = [computerUsePlugin.pluginDirectory];
    }
  }
  // Asking for the foreground only means something where the Cua guard can refuse it.
  if (!cuaMcpServer) cfg.excludedTools.push(CUA_FOREGROUND_REQUEST_TOOL);

  // A resident session keeps the last value given, so send this on create and every resume.
  const imageGenerationEnabled = isImageGenerationEnabled(settings);
  cfg.imageGeneration = { enabled: imageGenerationEnabled };

  // Create only: setting the model on resume corrupts history (see forResume).
  if (!forResume) {
    if (sessionId) cfg.sessionId = sessionId;

    const modelMetadata = params.options?.modelMetadata;
    // A tier sets model, effort and context together; if it can't be used, New chats applies.
    const tierSlot = modelTier ?? scheduleContext?.modelTier;
    const scheduleTier = tierSlot && !modelOverride
      ? resolveModelTier(settings, tierSlot, modelMetadata)
      : undefined;
    if (scheduleTier && "warning" in scheduleTier) {
      const owner = scheduleContext ? `[trigger] "${scheduleContext.name}"` : "[model-ab-test]";
      console.warn(`${owner}: ${scheduleTier.warning} Running on the New chats model instead.`);
    }
    const tierChoice = scheduleTier?.model ? scheduleTier : undefined;

    // Explicit launch override > schedule tier > settings store > deps.config > SDK default
    const explicitModelOverride = modelOverride ?? tierChoice?.model;
    let model = explicitModelOverride ?? settings?.model ?? deps.config.model;
    // New chats may follow the same unusable tier; then the SDK picks rather than failing the run.
    const fallbackUnusable = !!scheduleTier && !scheduleTier.model && !!model && !isModelUsable(model, modelMetadata);
    if (fallbackUnusable) model = undefined;
    if (model) cfg.model = model;
    // Effort and context come from the tier alone, or from the SDK when it picks the model.
    const scheduleOwnsOptions = !!tierChoice || fallbackUnusable;

    const selectedModelMetadata = model
      ? modelMetadata?.find((candidate) => candidate.id === model)
      : undefined;

    // An override model must not inherit an unsupported effort; unknown ones use the SDK default.
    const scheduleReasoningEffort = tierChoice?.reasoningEffort;
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
    } else if (!scheduleOwnsOptions) {
      const reasoningEffort = settings?.reasoningEffort;
      const overrideModelSupportsGlobalEffort = !explicitModelOverride
        || selectedModelMetadata?.supportedReasoningEfforts?.includes(reasoningEffort ?? "") === true;
      if (reasoningEffort && overrideModelSupportsGlobalEffort) {
        cfg.reasoningEffort = reasoningEffort;
      }
    }

    const requestedContextTier = contextTierOverride
      ?? tierChoice?.contextTier
      ?? (scheduleOwnsOptions ? undefined : normalizeCopilotContextTier(settings?.contextTier));
    const contextTier = selectedModelMetadata
      ? resolveContextTierForModel(selectedModelMetadata, requestedContextTier)
      : requestedContextTier;
    if (contextTier) cfg.contextTier = contextTier;
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
    userNameLine(settings?.userName),
    ...(settings?.customInstructions?.trim() ? [settings.customInstructions.trim()] : []),
    RESEARCH_GUIDANCE,
    HOME_GUIDANCE,
    TOOL_NAMING_GUIDANCE,
    WORK_REFERENCE_GUIDANCE,
    DOC_LINK_GUIDANCE,
    ...(computerUseGuidance ? [computerUseGuidance] : []),
    ...(imageGenerationEnabled ? [IMAGE_GENERATION_GUIDANCE] : []),
    // Changes only when skills, packs or Settings › Models change, which reach a chat on resume.
    ...(deps.skillCatalog ? [formatSkillRolesBlock(catalogSkills, new Set(activePacks.map((pack) => pack.id)))] : []),
    ...(settings ? [formatModelRolesBlock(settings)] : []),
  ].filter((part): part is string => !!part);

  if (task) {
    contextParts.push(
      `You are helping with a Bridge task (taskId: ${task.id}). Its latest state (title, status, links, where things stand, notes, checklist and recent history) arrives in <bridge_context> blocks at the start of user messages.`,
      "Use the task tools to manage linked resources when you discover relevant work items or PRs.",
    );
    if (task.instructions?.trim()) {
      contextParts.push(`<task_instructions>\nStanding rules for this task. Follow them in every session.\n${task.instructions.trim()}\n</task_instructions>`);
    }
  }

  if (scheduleContext) {
    const kind = scheduleContext.type === "cron" ? "recurring" : "one-time";
    const runLabel = scheduleContext.runCount > 0
      ? `, run #${scheduleContext.runCount + 1}`
      : "";
    contextParts.push(
      `\nThis session was started by trigger "${scheduleContext.name}" (${kind}${runLabel}). There is no human waiting — work autonomously and avoid asking clarifying questions.`,
    );
    // Only playbooks that compare runs ask for it; the session manager reads it for those.
    if (scheduleContext.previousRunReport) {
      contextParts.push(formatPreviousRunReport(scheduleContext.previousRunReport));
    }
  }

  // Staging rules apply only in the Bridge repo; a session without a cwd is not Bridge work.
  const isSelfRepo = !!workingDirectory && pathsEqual(workingDirectory, REPO_ROOT);
  // Staging applies to every chat in this repo; the CLI coding rules only with a project folder.
  const stagingApplies = isSelfRepo
    && isBridgeSourceManagementAvailable(deps.runtimePaths?.env ?? process.env, REPO_ROOT);
  const codeChangeRules: BuiltSystemMessageSections["code_change_rules"] = hasProjectFolder
    ? stagingApplies ? { action: "append", content: STAGING_INSTRUCTIONS } : undefined
    : stagingApplies
      ? { action: "replace", content: STAGING_INSTRUCTIONS }
      : { action: "remove" };

  // `identity` also carries tone, tool and search guidance, so only its preamble is replaced.
  const identityText = settings?.identity?.trim() || DEFAULT_IDENTITY;
  const preambleText = `${identityText}\n\n${params.options?.promptRole ?? BASE_METHOD_ROLE}`;
  const resolvedStyle = resolveResponseStyle(settings?.responseStyle);
  const sections: Omit<BuiltSystemMessageSections, "environment_context"> = {
    ...(codeChangeRules ? { code_change_rules: codeChangeRules } : {}),
    identity: { action: createCodingModeStatementRemover(preambleText) },
    preamble: { action: "replace", content: preambleText },
    // The CLI's tone differs by model family and conflicts with the Bridge style setting.
    tone: {
      action: "replace",
      content: `${renderResponseStyle(resolvedStyle)}\n\n${WRITING_GUIDANCE}\n\n${BASE_METHOD_REPORTING}`,
    },
    guidelines: { action: "append", content: BASE_METHOD },
    tool_efficiency: { action: removeCliOutputSurfaceNote },
    last_instructions: {
      action: resolvedStyle.detail === "concise"
        ? applyConciseReplyDirective
        : resolvedStyle.detail === "adaptive"
          ? applyAdaptiveReplyDirective
          : removeConciseReplyDirective,
    },
    tool_instructions: {
      action: "append",
      content: `${AGENT_LIFECYCLE_GUIDANCE}\n\n${LONG_RUNNING_WORK_GUIDANCE}\n\n${ASK_USER_CONTEXT_GUIDANCE}\n\n${BROWSER_GUIDANCE}`,
    },
  };

  // Tag-based configuration — merge tag instructions and tag-selected MCP servers
  if (tagTask && resolvedTags) {
    const resolved = resolvedTags;
    if (task && resolved.mergedInstructions) {
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

  // After the tag merge, which rebuilds the server list.
  if (cuaMcpServer) cfg.mcpServers = { ...cfg.mcpServers, [CUA_MCP_SERVER_NAME]: cuaMcpServer };

  // current_datetime has only an offset; scheduling needs the IANA zone name.
  const serverTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const environmentContext: BuiltSystemMessageSections["environment_context"] = {
    action: "append",
    content: `\n* Server timezone: ${serverTz}`,
  };

  if (params.options?.extraGuidance?.trim()) contextParts.push(params.options.extraGuidance.trim());

  return {
    ...cfg,
    systemMessage: {
      mode: "customize" as const,
      sections: { ...sections, environment_context: environmentContext },
      // Never empty: the response-quality guidance always leads it.
      content: contextParts.join("\n"),
    },
  };
}
