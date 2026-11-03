import type { AgentPermissionPolicy, AgentSectionOverride } from "./agent-backend/index.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBridgeControlRoot } from "./control-root.js";
import type { Task } from "./task-store.js";
import type { ChecklistStore } from "./checklist-store.js";
import { isImageGenerationEnabled, type SettingsStore } from "./settings-store.js";
import { buildSubagentPlan } from "../shared/subagent-settings.js";
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
  COMPUTER_USE_OFF_GUIDANCE,
  DEFAULT_IDENTITY,
  HOME_GUIDANCE,
  IMAGE_GENERATION_GUIDANCE,
  LONG_RUNNING_WORK_GUIDANCE,
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
import { renderResponseStyle } from "../shared/response-style.js";
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolveBridgeControlRoot(join(__dirname, "..", ".."));

export interface ScheduleContext {
  name: string;
  type: "cron" | "once";
  runCount: number;
  lastRunAt?: string;
  /** Resolved against Settings › Models when the session is created; unset follows New chats. */
  modelTier?: ModelPresetSlot;
  /** The playbook the schedule pins for its runs. */
  playbook?: string;
  /** The session of the schedule's previous run. */
  previousSessionId?: string;
  /** What the previous run left, for playbooks that compare runs (Watch, Sweep). */
  previousRunReport?: PreviousRunReport;
}

export interface SessionConfigOptions {
  sessionId?: string;
  task?: Task | null;
  /**
   * Adds this task's tag-linked MCP servers without the rest of the task (prompt context, working
   * directory). Defer workers use it to get their parent chat's servers.
   */
  mcpServerTask?: Pick<Task, "id" | "groupId"> | null;
  scheduleContext?: ScheduleContext;
  modelOverride?: string;
  reasoningEffortOverride?: string;
  contextTierOverride?: CopilotContextTier;
  /** Replaces the base method's role sentence in the preamble (Helm's chat says it is Helm). */
  promptRole?: string;
  /** Guidance appended after the Bridge's own, for chats with a role of their own (Helm). */
  extraGuidance?: string;
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

/**
 * The runtime keeps the first skill it finds under a name, so folders go in precedence order:
 * the user's home skills, then packs, then the Bridge's bundled skills. A home copy of a bundled
 * playbook (Settings › Skills › Customize) therefore replaces it on this machine.
 */
export function orderSkillDirectories(dirs: { bundled: string; packs: readonly string[]; home: string }): string[] {
  return [...new Set([dirs.home, ...dirs.packs, dirs.bundled])];
}

export function buildSessionConfig(params: BuildSessionConfigParams) {
  const { deps, callbacks } = params;
  const {
    sessionId,
    task,
    scheduleContext,
    modelOverride,
    reasoningEffortOverride,
    contextTierOverride,
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
  const cfg: any = {
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
  // Applied by the backend on create and resume (the runtime drops it on resume) and again
  // whenever the chat's model changes, since rubber-duck's model depends on it.
  if (settings) {
    const models = params.options?.modelMetadata;
    cfg.subagents = buildSubagentPlan({
      helpers: resolveModelRole(settings, "subagents", models),
      reviewers: resolveModelRole(settings, "reviewers", models),
      tiers: [...MODEL_PRESET_SLOTS].reverse().map((slot) => settings.modelPresets?.[slot]),
    }, models);
  }
  // Experimental (Settings › Experimental). The Copilot backend gives it only to a session on Fusion.
  const fusionContextTokens = settings?.experimental?.fusionContextTokens;
  if (fusionContextTokens !== undefined) cfg.fusionContextTokens = fusionContextTokens;

  // Computer Use is upstream's plugin from the SDK platform package. Loading it per
  // session keeps the Bridge setting as the only gate, independent of CLI user settings.
  const computerUseEnabled = settings?.computerUse?.enabled === true;
  const computerUsePlugin = computerUseEnabled
    ? (deps.resolveComputerUsePlugin ?? resolveComputerUsePlugin)()
    : undefined;
  if (computerUsePlugin?.available && computerUsePlugin.pluginDirectory) {
    cfg.pluginDirectories = [computerUsePlugin.pluginDirectory];
  }

  // The runtime offers its image tool only when asked, and a resident session keeps whatever it
  // was last given, so the switch is sent explicitly on create and on every resume.
  const imageGenerationEnabled = isImageGenerationEnabled(settings);
  cfg.imageGeneration = { enabled: imageGenerationEnabled };

  // Model + reasoningEffort only belong on createSession. On resume the SDK
  // overwrites _selectedModel without sanitizing chat history (which corrupts
  // cross-family tool_call shapes). Resume intentionally trusts the SDK's
  // persisted session model; only Bridge-owned runtime config (tools, MCP,
  // user-input handlers, system context) is refreshed on resume.
  if (!forResume) {
    if (sessionId) cfg.sessionId = sessionId;

    const modelMetadata = params.options?.modelMetadata;
    // A schedule's tier gives its model, effort and context as one choice, never New chats' values.
    // When the tier can't be used, the run follows New chats.
    const scheduleTier = scheduleContext?.modelTier && !modelOverride
      ? resolveModelTier(settings, scheduleContext.modelTier, modelMetadata)
      : undefined;
    if (scheduleTier && "warning" in scheduleTier) {
      console.warn(`[schedule] "${scheduleContext?.name}": ${scheduleTier.warning} Running on the New chats model instead.`);
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

    // An explicit model override must not inherit an unsupported effort from
    // the global model. Unknown override models use their SDK default.
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
    ...(settings?.customInstructions?.trim() ? [settings.customInstructions.trim()] : []),
    RESEARCH_GUIDANCE,
    HOME_GUIDANCE,
    TOOL_NAMING_GUIDANCE,
    WORK_REFERENCE_GUIDANCE,
    DOC_LINK_GUIDANCE,
    ...(computerUseEnabled ? [] : [COMPUTER_USE_OFF_GUIDANCE]),
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
      `\nThis session was triggered by schedule "${scheduleContext.name}" (${kind}${runLabel}). There is no human waiting — work autonomously and avoid asking clarifying questions.`,
    );
    // Only playbooks that compare runs ask for it; the session manager reads it for those.
    if (scheduleContext.previousRunReport) {
      contextParts.push(formatPreviousRunReport(scheduleContext.previousRunReport));
    }
  }

  // Staging rules — only when working on the bridge repo itself. A session without a
  // resolved cwd is not evidence of Bridge work.
  const isSelfRepo = !!workingDirectory && pathsEqual(workingDirectory, REPO_ROOT);
  const sections: Partial<Record<string, AgentSectionOverride>> = {};
  // The staging workflow is an operational rule of this repository, so it applies to every chat
  // there; the CLI's general coding rules apply only to chats with a project folder.
  const stagingApplies = isSelfRepo
    && isBridgeSourceManagementAvailable(deps.runtimePaths?.env ?? process.env, REPO_ROOT);
  if (hasProjectFolder) {
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
  const preambleText = `${identityText}\n\n${params.options?.promptRole ?? BASE_METHOD_ROLE}`;
  sections.identity = { action: createCodingModeStatementRemover(preambleText) };
  sections.preamble = { action: "replace", content: preambleText };
  // The CLI's tone differs by model family and conflicts with the Bridge style setting.
  sections.tone = {
    action: "replace",
    content: `${renderResponseStyle(settings?.responseStyle)}\n\n${WRITING_GUIDANCE}\n\n${BASE_METHOD_REPORTING}`,
  };
  sections.guidelines = { action: "append", content: BASE_METHOD };
  sections.tool_efficiency = { action: removeCliOutputSurfaceNote };
  sections.last_instructions = { action: removeConciseReplyDirective };

  // Tighten the SDK's native task/write_agent contract, say how to use the time a slow command
  // takes, make ask_user forms carry their own context, and teach web_fetch escalation without
  // replacing the broader per-tool guidance.
  sections.tool_instructions = {
    action: "append",
    content: `${AGENT_LIFECYCLE_GUIDANCE}\n\n${LONG_RUNNING_WORK_GUIDANCE}\n\n${ASK_USER_CONTEXT_GUIDANCE}\n\n${BROWSER_GUIDANCE}`,
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

  // Upstream current_datetime now carries a local offset, but we still expose the
  // server's IANA zone name for scheduling and timezone-specific prompts.
  const serverTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  sections.environment_context = { action: "append", content: `\n* Server timezone: ${serverTz}` };

  if (params.options?.extraGuidance?.trim()) contextParts.push(params.options.extraGuidance.trim());

  const hasContent = contextParts.length > 0;

  cfg.systemMessage = {
    mode: "customize" as const,
    sections,
    content: hasContent ? contextParts.join("\n") : undefined,
  };

  return cfg;
}
