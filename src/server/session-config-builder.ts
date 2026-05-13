import { approveAll, type SectionOverride, type defineTool } from "@github/copilot-sdk";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { NativeUserInputRequest, NativeUserInputResponse } from "./user-input-types.js";
import type { Task } from "./task-store.js";
import type { ChecklistStore } from "./checklist-store.js";
import type { SettingsStore } from "./settings-store.js";
import type { TagStore } from "./tag-store.js";
import type { DocsIndex } from "./docs-index.js";
import type { DocsStore, DocTreeNode } from "./docs-store.js";
import type { McpServerConfig } from "./mcp-config.js";
import type { McpServerStore } from "./mcp-server-store.js";
import type { RuntimePaths } from "./runtime-paths.js";
import {
  BRIDGE_EXCLUDED_TOOLS,
  BROWSER_GUIDANCE,
  DEFAULT_IDENTITY,
  DEMO_MODE_INSTRUCTIONS,
  FEED_GUIDANCE,
  RESEARCH_GUIDANCE,
  STAGING_INSTRUCTIONS,
} from "./session-instructions.js";
import {
  formatPromptTagList,
  formatRelatedDocManifestEntry,
} from "./session-formatting.js";
import { formatTaskMomentumContext } from "./session-task-momentum.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");

function isDemoMode(runtimePaths?: RuntimePaths): boolean {
  return runtimePaths?.demoMode ?? false;
}

export interface ScheduleContext {
  name: string;
  type: "cron" | "once";
  runCount: number;
  lastRunAt?: string;
}

export interface SessionConfigOptions {
  sessionId?: string;
  task?: Task | null;
  isNewTask?: boolean;
  prDescriptions?: string[];
  scheduleContext?: ScheduleContext;
  /** Group notes to inject into context (looked up by caller) */
  groupNotes?: { groupName: string; notes: string } | null;
  /**
   * When true, omit `model` and `reasoningEffort` from the config.
   * The SDK silently overwrites _selectedModel via updateOptions() without sanitizing
   * chat history, so passing those on resume would corrupt cross-family tool_call
   * shapes. Resume trusts the SDK's persisted session model (recorded in session
   * event logs) rather than re-applying the global settings default.
   */
  forResume?: boolean;
}

export interface SessionConfigBuilderDeps {
  tools: ReturnType<typeof defineTool>[];
  checklistStore?: ChecklistStore;
  settingsStore?: SettingsStore;
  tagStore?: TagStore;
  mcpServerStore?: McpServerStore;
  docsIndex?: DocsIndex;
  docsStore?: DocsStore;
  config: { sessionMcpServers: Record<string, McpServerConfig>; model?: string };
  runtimePaths?: RuntimePaths;
}

export interface SessionConfigBuilderCallbacks {
  resolveEffectiveSessionCwd(opts: { sessionId?: string; task?: Pick<Task, "cwd"> | null }): string | undefined;
  getCopilotHome(): string;
  handleUserInputRequest(
    request: NativeUserInputRequest,
    invocation: { sessionId: string },
  ): Promise<NativeUserInputResponse>;
}

export interface BuildSessionConfigParams {
  deps: SessionConfigBuilderDeps;
  options?: SessionConfigOptions;
  callbacks: SessionConfigBuilderCallbacks;
}

function renderDocsTree(nodes: DocTreeNode[], depth = 0): string {
  return nodes.map((n) => {
    const indent = "  ".repeat(depth);
    if (n.type === "folder") {
      const label = n.isDb
        ? `${n.name}/ (collection)`
        : n.hasIndex ? `${n.name}/ (page: docs_read "${n.path}")` : `${n.name}/`;
      const children = depth < 1 && n.children?.length
        ? "\n" + renderDocsTree(n.children, depth + 1)
        : n.children?.length ? ` (${n.children.length} items)` : "";
      return `${indent}- 📁 ${label}${children}`;
    }
    return `${indent}- ${n.name}`;
  }).join("\n");
}

function collectDocsDatabaseSummaries(docsStore: DocsStore, nodes: DocTreeNode[], summaries: string[] = []): string[] {
  for (const n of nodes) {
    if (n.type !== "folder") continue;
    if (n.isDb) {
      const schema = docsStore.readSchema(n.path);
      if (schema) {
        const entries = docsStore.listDbEntries(n.path);
        const fields = schema.fields.map((f) => `${f.name} (${f.type})`).join(", ");
        summaries.push(`- ${n.path}/ "${schema.name}" (${entries.length} entries): ${fields}`);
      }
    }
    if (n.children?.length) collectDocsDatabaseSummaries(docsStore, n.children, summaries);
  }
  return summaries;
}

function resolveSessionMcpServers(
  deps: SessionConfigBuilderDeps,
  tagSelectedServerIds: string[] = [],
  fallbackTagServers?: Record<string, McpServerConfig>,
): Record<string, McpServerConfig> {
  if (!deps.mcpServerStore) {
    const base = deps.settingsStore?.getMcpServers() ?? deps.config.sessionMcpServers;
    return fallbackTagServers && Object.keys(fallbackTagServers).length > 0
      ? { ...base, ...fallbackTagServers }
      : base;
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

export function buildSessionConfig(params: BuildSessionConfigParams) {
  const { deps, callbacks } = params;
  const { sessionId, task, isNewTask, prDescriptions, scheduleContext, groupNotes, forResume } = params.options ?? {};
  const runtimePaths = deps.runtimePaths;
  const demoMode = isDemoMode(runtimePaths);
  const workingDirectory = callbacks.resolveEffectiveSessionCwd({ sessionId, task });

  const cfg: any = {
    onPermissionRequest: approveAll,
    onUserInputRequest: (request: NativeUserInputRequest, invocation: { sessionId: string }) =>
      callbacks.handleUserInputRequest(request, invocation),
    streaming: true,
    includeSubAgentStreamingEvents: false,
    tools: deps.tools,
    excludedTools: [...BRIDGE_EXCLUDED_TOOLS],
    mcpServers: resolveSessionMcpServers(deps),
    skillDirectories: [
      join(REPO_ROOT, "skills"),
      join(callbacks.getCopilotHome(), "skills"),
    ],
  };

  const settings = deps.settingsStore?.getSettings();

  // Model + reasoningEffort only belong on createSession. On resume the SDK
  // overwrites _selectedModel without sanitizing chat history (which corrupts
  // cross-family tool_call shapes). Resume intentionally trusts the SDK's
  // persisted session model; only Bridge-owned runtime config (tools, MCP,
  // user-input handlers, system context) is refreshed on resume.
  if (!forResume) {
    // Model priority: settings store > deps.config > SDK default
    const model = settings?.model ?? deps.config.model;
    if (model) cfg.model = model;

    // Reasoning effort: settings store > SDK default
    const reasoningEffort = settings?.reasoningEffort;
    if (reasoningEffort) cfg.reasoningEffort = reasoningEffort;
  }

  if (workingDirectory) {
    cfg.workingDirectory = workingDirectory;
  }

  const contextParts: string[] = [];

  if (task) {
    contextParts.push(
      `You are helping with task "${task.title}" (taskId: ${task.id}).`,
      `Task status: ${task.status}.`,
      `Task kind: ${task.kind}.`,
      "Use the task tools to manage linked resources when you discover relevant work items or PRs.",
    );
    if (isNewTask) {
      contextParts.push(
        'This task was just created without a title. After reading the user\'s first message, call `task_update` with a concise, descriptive title (3-6 words). Do this silently without mentioning it to the user.',
      );
    }
    if (task.workItems.length > 0) {
      contextParts.push(`Currently linked work items: ${task.workItems.map((w) => `#${w.id} (${w.provider})`).join(", ")}.`);
    }
    const prStrings = prDescriptions
      ?? (task.pullRequests.length > 0
        ? task.pullRequests.map((pr) => `${pr.repoName || pr.repoId} #${pr.prId}`)
        : []);
    if (prStrings.length > 0) {
      contextParts.push(`Currently linked PRs: ${prStrings.join(", ")}.`);
    }
    const momentumContext = formatTaskMomentumContext(task);
    if (momentumContext) {
      contextParts.push(momentumContext);
    }
    if (task.notes.trim()) {
      contextParts.push(`Task notes:\n${task.notes}`);
    }
    // Inject group notes if provided
    if (groupNotes?.notes?.trim()) {
      contextParts.push(`Group notes (from task group "${groupNotes.groupName}" that this task belongs to):\n${groupNotes.notes}`);
    }
    const checklistItems = deps.checklistStore?.listChecklistItems(task.id) ?? [];
    if (checklistItems.length > 0) {
      const today = new Date().toISOString().slice(0, 10);
      const checklistItemLines = checklistItems.map((t) => {
        let line = `- [${t.done ? "x" : " "}] ${t.text} [id: ${t.id}]`;
        if (t.deadline) {
          const overdue = !t.done && t.deadline < today;
          line += ` (due ${t.deadline}${overdue ? " ⚠️ OVERDUE" : ""})`;
        }
        return line;
      }).join("\n");
      contextParts.push(`Task checklist:\n${checklistItemLines}`);
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
  }

  if (demoMode) {
    contextParts.push(DEMO_MODE_INSTRUCTIONS);
  }

  // Staging rules — only when working on the bridge repo itself
  const isSelfRepo = !workingDirectory || resolve(workingDirectory) === resolve(REPO_ROOT);
  const sections: Partial<Record<string, SectionOverride>> = {};
  if (isSelfRepo && !demoMode) {
    sections.code_change_rules = { action: "append", content: STAGING_INSTRUCTIONS };
  }

  // Identity override — always replace the SDK default with Bridge identity
  const identityText = settings?.identity?.trim() || DEFAULT_IDENTITY;
  sections.identity = { action: "replace", content: identityText };

  // Custom instructions — append user-defined instructions to context
  if (settings?.customInstructions?.trim()) {
    contextParts.push(settings.customInstructions.trim());
  }

  contextParts.push(RESEARCH_GUIDANCE);
  contextParts.push(FEED_GUIDANCE);

  // Tag-based configuration — resolve effective tags and merge instructions + MCP servers
  if (task && deps.tagStore) {
    const resolved = deps.tagStore.resolveEffectiveTags(task.id, task.groupId);
    if (resolved.mergedInstructions) {
      contextParts.push(`\n<tag_instructions>\n${resolved.mergedInstructions}\n</tag_instructions>`);
    }
    // Merge tag-selected MCP registry servers into session config.
    if (resolved.mcpServerIds.length > 0 || Object.keys(resolved.mergedMcpServers).length > 0) {
      cfg.mcpServers = resolveSessionMcpServers(deps, resolved.mcpServerIds, resolved.mergedMcpServers);
    }

    // Inject related docs manifest — tell the AI which docs are available
    if (resolved.tags.length > 0 && deps.docsIndex) {
      const tagNames = resolved.tags.map((t) => t.name);
      const relatedDocs = deps.docsIndex.findDocsByTagNames(tagNames, 20);
      if (relatedDocs.length > 0) {
        const manifest = relatedDocs.map((d) => formatRelatedDocManifestEntry(d)).join("\n");
        contextParts.push(
          `\n<related_docs>\nThese knowledge base docs are related to your current task's tags (${formatPromptTagList(tagNames)}). Use docs_read to access them when relevant:\n${manifest}\n</related_docs>`,
        );
      }
    }
  }

  // Inject 2-level docs tree so the AI knows the knowledge base structure
  if (deps.docsStore) {
    const tree = deps.docsStore.listTree();
    if (tree.length > 0) {
      contextParts.push(`\n<docs_tree>\nKnowledge base structure (use docs_read/docs_search to access). Folder entries marked as pages are readable with docs_read using the shown folder path; index.md is hidden because it is represented by the folder path.\n${renderDocsTree(tree)}\n</docs_tree>`);

      // Collect all DB collections from the full tree and inject schema summaries
      const dbSummaries = collectDocsDatabaseSummaries(deps.docsStore, tree);
      if (dbSummaries.length > 0) {
        contextParts.push(`\n<docs_databases>\nDatabase collections (use docs_db_query/docs_db_add to interact, docs_db_schema for full field options):\n${dbSummaries.join("\n")}\n</docs_databases>`);
      }
    }
  }

  // Upstream current_datetime now carries a local offset, but we still expose the
  // server's IANA zone name for scheduling and timezone-specific prompts.
  const serverTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  sections.environment_context = { action: "append", content: `\n* Server timezone: ${serverTz}` };

  // Browser escalation guidance — teach the model to recognize web_fetch failures
  sections.web_fetch = { action: "append", content: BROWSER_GUIDANCE };

  const hasContent = contextParts.length > 0;

  cfg.systemMessage = {
    mode: "customize" as const,
    sections,
    content: hasContent ? contextParts.join("\n") : undefined,
  };

  return cfg;
}
