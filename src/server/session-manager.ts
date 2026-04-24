// Copilot SDK session manager
// Universal tools — taskId is a parameter, same tools for every session

import { CopilotClient, approveAll, defineTool } from "@github/copilot-sdk";
import type { SectionOverride } from "@github/copilot-sdk";
import { writeFileSync, readFileSync, mkdirSync, existsSync, cpSync, readdirSync, statSync } from "node:fs";
import { readdir, readFile, stat, rm } from "node:fs/promises";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, dirname, resolve, basename, isAbsolute, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";
import { getLastVisibleActivityAt, transformEventsToMessages, type TransformedEntry } from "./event-transform.js";
import { config } from "./config.js";
import { createTaskStore, InvalidTaskUpdateError } from "./task-store.js";
import type { WorkItemRef } from "./task-store.js";
import type { Task } from "./task-store.js";
import type { TaskGroupStore } from "./task-group-store.js";
import { createTaskGroupStore } from "./task-group-store.js";
import { createScheduleStore } from "./schedule-store.js";
import * as schedulerModule from "./scheduler.js";
import { resolveScheduleSessionSelection } from "./schedule-targeting.js";
import { getOrCreateBus, getBus } from "./event-bus.js";
import { createSessionTitlesStore } from "./session-titles.js";
import * as globalBus from "./global-bus.js";
import { STAGING_TOOLS } from "./staging-tools.js";
import { createWebSearchTools } from "./web-search-tools.js";
import { createBrowserFetchTools } from "./browser-fetch-tools.js";
import { createBrowserExecTools } from "./browser-exec-tools.js";
import { createBrowserSessionTools } from "./browser-session-tools.js";
import { createComputerUseTools } from "./computer-use-tools.js";
import { SESSION_TITLE_WORD_RE, looksLikePromptEchoTitle, normalizeSessionTitle } from "./session-title-utils.js";
import type { AppContext } from "./app-context.js";
import type { GlobalBus } from "./global-bus.js";
import type { EventBusRegistry } from "./event-bus.js";
import type { SessionTitlesStore } from "./session-titles.js";
import type { TaskStore } from "./task-store.js";
import type { ChecklistStore } from "./checklist-store.js";

import type { SettingsStore } from "./settings-store.js";
import type { TagStore } from "./tag-store.js";
import type { TelemetryStore } from "./telemetry-store.js";
import type { DocsIndex } from "./docs-index.js";
import type { DocsStore, DocTreeNode } from "./docs-store.js";
import type { BrowserSessionStore } from "./browser-session-store.js";
import type { McpServerConfig } from "./mcp-config.js";
import { getOrCreateBrowserSessionStore } from "./browser-session-store.js";
import { getBridgeBrowserTarget, shutdownBridgeBrowser } from "./agent-browser.js";
import { DEPENDENCY_SYNC_GIT_PATHSPEC } from "./dependency-sync.js";
import { preserveOrCreateRollbackCheckpoint, removeRollbackCheckpointIfCreated } from "./pre-deploy-checkpoint.js";
import { err, getToolExecutionDisplayText, ok, toolFailure, type Result } from "./tool-results.js";
import type { RuntimePaths } from "./runtime-paths.js";
import { publishOutboundAttachment } from "./outbound-attachments.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const SIGNAL_FILE = join(REPO_ROOT, "data", "restart.signal");
const PRE_DEPLOY_SHA_FILE = join(REPO_ROOT, "data", "pre-deploy-sha");
// Keep the cloud-only session store tool out of bridge-managed sessions.
const BRIDGE_EXCLUDED_TOOLS = ["session_store_sql"];

function isDemoMode(runtimePaths?: RuntimePaths): boolean {
  return runtimePaths?.demoMode ?? false;
}

function resolveDemoWorkspaceDir(runtimePaths?: RuntimePaths): string | undefined {
  if (!isDemoMode(runtimePaths)) return undefined;
  return runtimePaths?.workspaceDir ?? (runtimePaths ? join(resolve(runtimePaths.dataDir), "workspace") : undefined);
}

const DEMO_MODE_INSTRUCTIONS = `
<demo_mode>
You are running inside a seeded demo workspace for Copilot Bridge.

- Treat the main repository checkout and the user's normal .copilot home as read-only.
- Keep any file edits inside the demo sandbox workspace unless the user explicitly asks to abandon the demo.
- Do not suggest or rely on restart, self-update, or staging workflows in demo mode.
- If a task has no working directory, default to the demo sandbox workspace instead of the live repository.
</demo_mode>
`.trim();

function run(cmd: string): { ok: boolean; output: string } {
  try {
    const output = execSync(cmd, { cwd: REPO_ROOT, encoding: "utf-8", timeout: 120_000 });
    return { ok: true, output };
  } catch (err: any) {
    return { ok: false, output: err.stderr || err.stdout || String(err) };
  }
}

function resolvePublishableAttachmentSourcePath(pathValue: string): string {
  if (pathValue === "~") return homedir();
  if (pathValue.startsWith("~/")) return join(homedir(), pathValue.slice(2));
  return isAbsolute(pathValue) ? pathValue : resolve(REPO_ROOT, pathValue);
}

function escapeAttachmentMarkdownText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
}

function encodeAttachmentUrlSegment(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function buildSessionAttachmentUrlPath(apiBasePath: string | undefined, sessionId: string, attachmentId: string): string {
  const trimmed = apiBasePath?.trim();
  const normalizedBase = !trimmed
    ? "/api"
    : (trimmed.startsWith("/") ? trimmed : `/${trimmed}`).replace(/\/+$/, "");
  return `${normalizedBase}/sessions/${encodeAttachmentUrlSegment(sessionId)}/attachments/${encodeAttachmentUrlSegment(attachmentId)}`;
}

function getAttachmentApiBasePath(ctx: AppContext): string {
  const explicitBasePath = ctx.apiBasePath?.trim();
  if (explicitBasePath) {
    return explicitBasePath;
  }
  if (ctx.isStaging) {
    const stagingRootName = ctx.runtimePaths?.dataDir
      ? basename(dirname(ctx.runtimePaths.dataDir))
      : basename(REPO_ROOT);
    const prefix = `${stagingRootName}${ctx.runtimePaths?.demoMode ? "-demo" : ""}`;
    return `/staging/${prefix}/api`;
  }
  return "/api";
}

function renderPublishedAttachment(
  apiBasePath: string,
  sessionId: string,
  attachment: {
    attachmentId: string;
    displayName: string;
    inline: boolean;
  },
): {
  urlPath: string;
  linkMarkdown: string;
  imageMarkdown?: string;
  recommendedMarkdown: string;
} {
  const urlPath = buildSessionAttachmentUrlPath(apiBasePath, sessionId, attachment.attachmentId);
  const escapedDisplayName = escapeAttachmentMarkdownText(attachment.displayName);
  const linkMarkdown = `[${escapeAttachmentMarkdownText(`Download ${attachment.displayName}`)}](${urlPath})`;
  const imageMarkdown = attachment.inline ? `![${escapedDisplayName}](${urlPath})` : undefined;
  return {
    urlPath,
    linkMarkdown,
    imageMarkdown,
    recommendedMarkdown: imageMarkdown ?? linkMarkdown,
  };
}

function deriveFallbackSessionTitle(sourceText: string): string | undefined {
  const normalized = normalizeSessionTitle(sourceText);
  if (!normalized) return undefined;

  const trimmedLeadIn = normalized
    .replace(/^(please\s+)?(can|could|would|will)\s+you\s+/i, "")
    .replace(/^let'?s\s+/i, "")
    .replace(/^help\s+me\s+/i, "")
    .replace(/^i\s+(need|want)\s+to\s+/i, "")
    .replace(/^we\s+need\s+to\s+/i, "")
    .trim();

  const words = (trimmedLeadIn || normalized).match(SESSION_TITLE_WORD_RE) ?? [];
  if (words.length === 0) return undefined;

  const fallbackTitle = normalizeSessionTitle(words.slice(0, 6).join(" "));
  if (!fallbackTitle || fallbackTitle.length > 80 || looksLikePromptEchoTitle(fallbackTitle)) {
    return undefined;
  }

  return fallbackTitle[0]?.toUpperCase() + fallbackTitle.slice(1);
}

function parseWorkspaceSummary(content: string): string | undefined {
  let summary: string | undefined;
  let inSummary = false;
  const summaryLines: string[] = [];

  for (const line of content.split(/\r?\n/)) {
    if (inSummary) {
      if (line.startsWith("  ")) {
        summaryLines.push(line.slice(2));
        continue;
      }
      if (line.trim() === "") {
        summaryLines.push("");
        continue;
      }
      inSummary = false;
    }
    if (line.startsWith("summary: |-")) {
      inSummary = true;
    } else if (line.startsWith("summary:")) {
      summary = line.slice(9).trim();
    }
  }

  return summary ?? (summaryLines.length > 0 ? summaryLines.join("\n") : undefined);
}

function looksLikeExistingSessionTitle(summary: string): boolean {
  const normalized = normalizeSessionTitle(summary);
  if (!normalized) return false;
  const wordCount = normalized.match(SESSION_TITLE_WORD_RE)?.length ?? 0;
  return normalized.length <= 80 && wordCount <= 8;
}

function normalizeInlineText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function escapePromptText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeUnicodeLineSeparators(text: string): string {
  return text
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function escapePromptLiteral(text: string): string {
  return escapePromptText(
    escapeUnicodeLineSeparators(
      text
        .replace(/\r/g, "\\r")
        .replace(/\n/g, "\\n")
        .replace(/\t/g, "\\t")
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " "),
    ),
  );
}

const SIMPLE_PROMPT_TAG_RE = /^[\p{L}\p{N}._:/-]+$/u;

function formatPromptTag(tag: string): string {
  return SIMPLE_PROMPT_TAG_RE.test(tag)
    ? escapePromptText(tag)
    : escapePromptText(escapeUnicodeLineSeparators(JSON.stringify(tag)));
}

function formatPromptTagList(tags: string[]): string {
  return tags.map(formatPromptTag).join(", ");
}

function formatRelatedDocManifestEntry(doc: {
  title: string;
  path: string;
  description?: string;
  matchedTags: string[];
}): string {
  const title = escapePromptText(normalizeInlineText(doc.title));
  const path = escapePromptLiteral(doc.path);
  const description = doc.description ? escapePromptText(normalizeInlineText(doc.description)) : "";
  const matchedTags = doc.matchedTags.filter(Boolean);

  let line = `- ${title} (${path})`;
  if (description) line += ` — ${description}`;
  if (matchedTags.length > 0) {
    const suffix = description && !/[.!?]$/.test(description) ? "." : "";
    line += `${suffix} [matched: ${formatPromptTagList(matchedTags)}]`;
  }
  return line;
}

function isPromptEchoSummary(summary: string, firstUserPrompt?: string): boolean {
  const normalizedSummary = normalizeSessionTitle(summary);
  const normalizedPrompt = normalizeSessionTitle(firstUserPrompt);
  if (!normalizedSummary || !normalizedPrompt) return false;
  if (normalizedSummary === normalizedPrompt) return true;
  if (!normalizedPrompt.startsWith(normalizedSummary)) return false;

  const summaryWords = normalizedSummary.match(SESSION_TITLE_WORD_RE)?.length ?? 0;
  const promptWords = normalizedPrompt.match(SESSION_TITLE_WORD_RE)?.length ?? 0;
  return normalizedPrompt.length - normalizedSummary.length >= 20
    || promptWords - summaryWords >= 3;
}

function storeSessionTitle(
  sessionTitles: SessionTitlesStore,
  eventBusRegistry: EventBusRegistry,
  globalBus: GlobalBus,
  sessionId: string,
  title: string,
): void {
  sessionTitles.setTitle(sessionId, title);
  eventBusRegistry.getBus(sessionId)?.emit({ type: "title_changed", title });
  globalBus.emit({ type: "session:title", sessionId, title });
}

const DEFAULT_IDENTITY = `You are a helpful AI assistant powered by Copilot Bridge. You are an interactive CLI tool that helps users with software engineering tasks, answers questions, and assists with a wide range of topics. You are versatile and conversational — not limited to coding.`;

const STAGING_INSTRUCTIONS = `
<staging_workflow>
When modifying code in this repository (the Copilot Bridge):
1. Call staging_init to create a fresh, isolated worktree
2. Make ALL code edits in the returned staging directory — never in the production directory
3. Run quality checks in the staging directory:
   - npx tsc --noEmit (type checking)
   - npm run test:xplat-audit (cross-platform test audit)
   - npx vite build (client build)
   - npx vitest run (test suite)
4. Call staging_preview to build and serve a preview of the staged frontend
5. Share the preview URL with the user and WAIT for their confirmation before proceeding
6. Only after the user approves, call staging_deploy with a descriptive commit message
7. Do NOT make further tool calls after staging_deploy — the server will restart

If staging_deploy fails due to rebase conflicts:
- Your staging worktree is still intact — do NOT call staging_cleanup
- Follow the resolution steps returned by staging_deploy (rebase, resolve conflicts, continue)
- Call staging_deploy again after resolving — it will skip the commit and proceed to merge
- Only use staging_cleanup if you want to completely abandon your changes

IMPORTANT: Never edit source files directly in the production directory.
Always use the staging workflow for any code changes to this codebase.
For non-code restarts (config, env), use self_restart instead.
For pulling the latest remote code and restarting, use self_update instead.
</staging_workflow>
`.trim();

const BROWSER_GUIDANCE = `
<browser_escalation>
If web_fetch returns any of these signals, the site likely blocks automated access — retry with browser_fetch (a direct tool) instead:
- HTTP 403/429 status or empty body
- Page content contains "enable JavaScript", "captcha", "verify you are human", "access denied", "please wait", or "checking your browser"
- Content is very short or clearly incomplete compared to what the page should have
- The site is a known SPA or JS-heavy app (React, Angular, Vue dashboards, etc.)

Escalation path: web_fetch (fast, simple) → browser_fetch (real browser, single page) → browser_exec (hardened freeform browser steps) → browser_session_* (explicit multi-turn browser continuity) → browser skill (raw multi-step escape hatch)
</browser_escalation>
`.trim();

const RESEARCH_GUIDANCE = `
<research_behavior>
When a question depends on current facts, third-party behavior, online documentation, or other information that can drift from model memory, verify it online before answering confidently.

- Prefer web_search for source discovery and narrow fact-finding checks.
- Split independent claims into separate checks, and run those checks in parallel when practical.
- Use browser_fetch to confirm rendered or canonical pages after search fan-out, especially for JS-heavy or bot-protected sites.
- Use browser_exec when verification or extraction needs multiple browser steps but should stay on the bridge-managed browser lane.
- Use browser_session_* tools when browser work must persist explicitly across turns.
- For important claims, compare more than one source when reasonable before making a strong assertion.
- Skip unnecessary browsing for purely local codebase work or when the answer is already fully grounded in the files/context you have.
</research_behavior>
`.trim();

// ── Session config builder ───────────────────────────────────────

interface ScheduleContext {
  name: string;
  type: "cron" | "once";
  runCount: number;
  lastRunAt?: string;
}

interface SessionConfigOptions {
  sessionId?: string;
  task?: Task | null;
  isNewTask?: boolean;
  prDescriptions?: string[];
  scheduleContext?: ScheduleContext;
  /** Group notes to inject into context (looked up by caller) */
  groupNotes?: { groupName: string; notes: string } | null;
}

// Module-level ref so universal tools can query session state
let _instance: SessionManager | null = null;
let _restartPending = false;
let _restartPendingSince = 0;
const RESTART_TIMEOUT = 15 * 60 * 1000; // 15 min — if server is still alive, restart failed
export const RESTART_PENDING_MESSAGE = "Restart pending — wait for reconnect.";
const DEFAULT_FLEET_PROMPT = "Implement the current plan using Fleet. Run independent tracks in parallel where possible, respect dependencies in the plan, and report the results in this session.";

export function isRestartPending(): boolean {
  if (_restartPending && _restartPendingSince && Date.now() - _restartPendingSince > RESTART_TIMEOUT) {
    clearRestartPending();
  }
  return _restartPending;
}
export function clearRestartPending(): void {
  if (!_restartPending) return;
  _restartPending = false;
  _restartPendingSince = 0;
  globalBus.emit({ type: "server:restart-cleared" });
}
export function getRestartWaitingCount(): number {
  return _instance ? _instance.getActiveSessions().length : 0;
}

/** Restart is imminent — pending AND no active sessions blocking it. */
export function isRestartImminent(): boolean {
  return isRestartPending() && getRestartWaitingCount() === 0;
}

export function isRestartPendingError(err: unknown): boolean {
  return err instanceof Error && err.message === RESTART_PENDING_MESSAGE;
}

/**
 * Shared logic for both self_restart and staging_deploy.
 * Sets restart-pending state, emits the SSE event, and starts the watchdog.
 * Returns the waiting-session count (excludes the calling session).
 */
export function triggerRestartPending(): number {
  _restartPending = true;
  _restartPendingSince = Date.now();

  // Watchdog: if the launcher consumes the signal file but this process
  // survives (restart failed / rolled back), auto-clear the pending state.
  const watchdog = setInterval(() => {
    if (!_restartPending) { clearInterval(watchdog); return; }
    if (!existsSync(SIGNAL_FILE)) {
      setTimeout(() => {
        if (_restartPending) clearRestartPending();
      }, 90_000);
      clearInterval(watchdog);
    }
  }, 5_000);

  // The calling session is still counted as active; subtract 1 since it will
  // finish momentarily and should not count as "blocking" the restart.
  const waitingCount = _instance ? Math.max(0, _instance.getActiveSessions().length - 1) : 0;
  globalBus.emit({ type: "server:restart-pending", waitingSessions: waitingCount });
  return waitingCount;
}

// Universal tools — same instance for every session
export function createBridgeTools(ctx: AppContext) {
  const demoMode = isDemoMode(ctx.runtimePaths);
  const ensureTask = (taskId: string): Result<Task> => {
    const task = ctx.taskStore.getTask(taskId);
    return task ? ok(task) : err(`Task ${taskId} not found`);
  };

  const ensureTaskGroup = (
    groupId: string,
  ): Result<NonNullable<ReturnType<TaskGroupStore["getGroup"]>>> => {
    const group = ctx.taskGroupStore.getGroup(groupId);
    return group ? ok(group) : err(`Group ${groupId} not found`);
  };

  const ensureTagStore = (): Result<TagStore> => {
    return ctx.tagStore ? ok(ctx.tagStore) : err("Tags not available");
  };

  const ensureTag = (tagId: string): Result<NonNullable<ReturnType<TagStore["getTag"]>>> => {
    const tagStore = ensureTagStore();
    if (!tagStore.ok) return tagStore;
    const tag = tagStore.value.getTag(tagId);
    return tag ? ok(tag) : err(`Tag ${tagId} not found`);
  };

  const ensureChecklistItem = (checklistItemId: string): Result<NonNullable<ReturnType<ChecklistStore["getChecklistItem"]>>> => {
    const checklistItem = ctx.checklistStore.getChecklistItem(checklistItemId);
    return checklistItem ? ok(checklistItem) : err(`Checklist item ${checklistItemId} not found`);
  };

  const normalizeDocsToolFailure = (error: unknown) => toolFailure(error instanceof Error ? error.message : String(error));
  const TAGGED_DOC_DESCRIPTION_ERROR = "Tagged docs must include a non-empty frontmatter description";

  function getTaggedDocFrontmatterTags(frontmatter: { tags?: unknown }): string[] {
    if (Array.isArray(frontmatter.tags)) {
      return frontmatter.tags
        .filter((tag): tag is string => typeof tag === "string")
        .map((tag) => tag.trim())
        .filter(Boolean);
    }
    if (typeof frontmatter.tags === "string") {
      const trimmed = frontmatter.tags.trim();
      return trimmed ? [trimmed] : [];
    }
    return [];
  }

  function validateTaggedDocContent(content: string): void {
    const { data } = matter(content);
    const tags = getTaggedDocFrontmatterTags(data);
    if (tags.length === 0) return;
    if (typeof data.description !== "string" || !data.description.trim()) {
      throw new Error(TAGGED_DOC_DESCRIPTION_ERROR);
    }
  }

  const tools = [
  defineTool("task_link_work_item", {
    description: "Link a work item to a task by its ID",
    parameters: { type: "object", properties: { taskId: { type: "string", description: "The task ID" }, workItemId: { type: "string", description: "The work item ID" }, provider: { type: "string", enum: ["ado", "github", "linear"], description: "The provider (ado or github). Defaults to ado." } }, required: ["taskId", "workItemId"] },
    handler: async (args: any) => {
      const task = ensureTask(args.taskId);
      if (!task.ok) return toolFailure(task.error);
      ctx.taskStore.linkWorkItem(args.taskId, String(args.workItemId), args.provider ?? "ado");
      return { success: true, message: `Work item ${args.workItemId} (${args.provider ?? "ado"}) linked to task` };
    },
  }),
  defineTool("task_unlink_work_item", {
    description: "Remove a work item from a task",
    parameters: { type: "object", properties: { taskId: { type: "string", description: "The task ID" }, workItemId: { type: "string", description: "The work item ID" }, provider: { type: "string", enum: ["ado", "github", "linear"], description: "The provider (ado or github)" } }, required: ["taskId", "workItemId"] },
    handler: async (args: any) => {
      const task = ensureTask(args.taskId);
      if (!task.ok) return toolFailure(task.error);
      ctx.taskStore.unlinkWorkItem(args.taskId, String(args.workItemId), args.provider);
      return { success: true, message: `Work item ${args.workItemId} unlinked from task` };
    },
  }),
  defineTool("task_link_pr", {
    description: "Link a pull request to a task",
    parameters: { type: "object", properties: { taskId: { type: "string", description: "The task ID" }, repoName: { type: "string", description: "Repository name" }, prId: { type: "number", description: "PR number" }, provider: { type: "string", enum: ["ado", "github", "linear"], description: "The provider (ado or github). Defaults to ado." } }, required: ["taskId", "repoName", "prId"] },
    handler: async (args: any) => {
      const task = ensureTask(args.taskId);
      if (!task.ok) return toolFailure(task.error);
      ctx.taskStore.linkPR(args.taskId, { repoId: args.repoName, repoName: args.repoName, prId: args.prId, provider: args.provider ?? "ado" });
      return { success: true, message: `PR #${args.prId} from ${args.repoName} linked to task` };
    },
  }),
  defineTool("task_unlink_pr", {
    description: "Remove a pull request from a task",
    parameters: { type: "object", properties: { taskId: { type: "string", description: "The task ID" }, repoName: { type: "string", description: "Repository name" }, prId: { type: "number", description: "PR number" }, provider: { type: "string", enum: ["ado", "github", "linear"], description: "The provider (ado or github)" } }, required: ["taskId", "repoName", "prId"] },
    handler: async (args: any) => {
      const task = ensureTask(args.taskId);
      if (!task.ok) return toolFailure(task.error);
      ctx.taskStore.unlinkPR(args.taskId, args.repoName, args.prId, args.provider);
      return { success: true, message: `PR #${args.prId} from ${args.repoName} unlinked from task` };
    },
  }),
  defineTool("task_update", {
    description: "Update a task's title, notes, working directory, group, and/or tags. Only provided fields are changed.",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "The task ID" },
        title: { type: "string", description: "New title" },
        notes: { type: "string", description: "New notes content (markdown). Overwrites existing notes." },
        cwd: { type: "string", description: "Working directory path for the task" },
        groupId: { type: "string", description: "Task group ID to assign to (use empty string to ungroup)" },
        doneWhen: { anyOf: [{ type: "string" }, { type: "null" }], description: "Definition of done for this task. Null clears it." },
        nextAction: { anyOf: [{ type: "string" }, { type: "null" }], description: "The next concrete action for this task. Null clears it." },
        waitingOn: { anyOf: [{ type: "string" }, { type: "null" }], description: "What this task is waiting on. Null clears it." },
        nextTouchAt: { anyOf: [{ type: "string" }, { type: "null" }], description: "ISO timestamp with timezone for when to revisit the task. Null clears it." },
        tags: { type: "array", items: { type: "string" }, description: "Tag names to set on this task. Creates tags if they don't exist." },
      },
      required: ["taskId"],
    },
    handler: async (args: any) => {
      const updates: Record<string, string | null> = {};
      if (args.title !== undefined) updates.title = args.title;
      if (args.notes !== undefined) updates.notes = args.notes;
      if (args.cwd !== undefined) updates.cwd = args.cwd;
      if (args.groupId !== undefined) updates.groupId = args.groupId || "";
      if (args.doneWhen !== undefined) updates.doneWhen = args.doneWhen;
      if (args.nextAction !== undefined) updates.nextAction = args.nextAction;
      if (args.waitingOn !== undefined) updates.waitingOn = args.waitingOn;
      if (args.nextTouchAt !== undefined) updates.nextTouchAt = args.nextTouchAt;
      const hasTags = Array.isArray(args.tags);
      if (Object.keys(updates).length === 0 && !hasTags) return toolFailure("No fields to update. Provide at least one of: title, notes, cwd, groupId, doneWhen, nextAction, waitingOn, nextTouchAt, tags");
      const task = ensureTask(args.taskId);
      if (!task.ok) return toolFailure(task.error);
      let tagStore: TagStore | undefined;
      if (hasTags) {
        const tagStoreResult = ensureTagStore();
        if (!tagStoreResult.ok) return toolFailure(tagStoreResult.error);
        tagStore = tagStoreResult.value;
      }
      if (Object.keys(updates).length > 0) {
        try {
          ctx.taskStore.updateTask(args.taskId, updates as any);
        } catch (error) {
          if (error instanceof InvalidTaskUpdateError) return toolFailure(error.message);
          throw error;
        }
      }
      if (hasTags && tagStore) {
        const tagIds = args.tags.map((name: string) => {
          const existing = tagStore.getTagByName(name);
          if (existing) return existing.id;
          return tagStore.createTag(name).id;
        });
        tagStore.setEntityTags("task", args.taskId, tagIds);
      }
      const fields = [...Object.keys(updates), ...(hasTags ? ["tags"] : [])].join(", ");
      return { success: true, message: `Task updated (${fields})` };
    },
  }),
  defineTool("task_get_info", {
    description: "Get task details including title, status, linked work items, PRs, and notes",
    parameters: { type: "object", properties: { taskId: { type: "string", description: "The task ID" } }, required: ["taskId"] },
    handler: async (args: any) => {
      const task = ensureTask(args.taskId);
      if (!task.ok) return toolFailure(task.error);
      const checklistItems = ctx.checklistStore.listChecklistItems(args.taskId);
      return {
        ...task.value,
        checklistItems: checklistItems.map((t) => ({ id: t.id, text: t.text, done: t.done, deadline: t.deadline ?? null })),
      };
    },
  }),
  defineTool("task_list", {
    description: "List all tasks with their IDs, titles, statuses, and group IDs",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      return { tasks: ctx.taskStore.listTasks().map((t) => ({ id: t.id, title: t.title, status: t.status, groupId: t.groupId })) };
    },
  }),
  defineTool("task_create", {
    description: "Create a new task",
    parameters: { type: "object", properties: { title: { type: "string", description: "The task title" }, tags: { type: "array", items: { type: "string" }, description: "Tag names to set on this task. Creates tags if they don't exist." }, groupId: { type: "string", description: "Optional task group ID to create the task in" } }, required: ["title"] },
    handler: async (args: any) => {
      let tagStore: TagStore | undefined;
      if (Array.isArray(args.tags) && args.tags.length > 0) {
        const tagStoreResult = ensureTagStore();
        if (!tagStoreResult.ok) return toolFailure(tagStoreResult.error);
        tagStore = tagStoreResult.value;
      }
      const task = ctx.taskStore.createTask(args.title, args.groupId);
      if (Array.isArray(args.tags) && args.tags.length > 0 && tagStore) {
        const tagIds = args.tags.map((name: string) => {
          const existing = tagStore.getTagByName(name);
          if (existing) return existing.id;
          return tagStore.createTag(name).id;
        });
        tagStore.setEntityTags("task", task.id, tagIds);
      }
      return { success: true, message: `Task "${task.title}" created`, taskId: task.id };
    },
  }),
  defineTool("task_group_create", {
    description: "Create a new task group for organizing related tasks",
    parameters: { type: "object", properties: { name: { type: "string", description: "Group name (e.g., 'Frontend App', 'Backend API')" }, color: { type: "string", description: "Optional color: blue, purple, amber, rose, cyan, orange, slate" }, notes: { type: "string", description: "Optional markdown notes for the group" } }, required: ["name"] },
    handler: async (args: any) => {
      const group = ctx.taskGroupStore.createGroup(args.name, args.color);
      if (args.notes) ctx.taskGroupStore.updateGroup(group.id, { notes: args.notes });
      return { success: true, message: `Group "${group.name}" created`, groupId: group.id };
    },
  }),
  defineTool("task_group_list", {
    description: "List all task groups with their IDs, names, and notes",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      return { groups: ctx.taskGroupStore.listGroups().map((g) => ({ id: g.id, name: g.name, color: g.color, notes: g.notes || undefined })) };
    },
  }),
  defineTool("task_group_delete", {
    description: "Delete a task group. Tasks in the group become ungrouped.",
    parameters: { type: "object", properties: { groupId: { type: "string", description: "The group ID to delete" } }, required: ["groupId"] },
    handler: async (args: any) => {
      const tasks = ctx.taskStore.listTasks().filter((t) => t.groupId === args.groupId);
      for (const t of tasks) ctx.taskStore.updateTask(t.id, { groupId: undefined });
      ctx.tagStore?.setEntityTags("task_group", args.groupId, []);
      ctx.taskGroupStore.deleteGroup(args.groupId);
      return { success: true, message: `Group deleted, ${tasks.length} task(s) ungrouped` };
    },
  }),
  defineTool("task_group_update", {
    description: "Update a task group's name, color, and/or notes. Only provided fields are changed.",
    parameters: { type: "object", properties: { groupId: { type: "string", description: "The group ID to update" }, name: { type: "string", description: "New group name" }, color: { type: "string", description: "New color: blue, purple, amber, rose, cyan, orange, slate" }, notes: { type: "string", description: "New notes content (markdown). Overwrites existing notes." } }, required: ["groupId"] },
    handler: async (args: any) => {
      const group = ensureTaskGroup(args.groupId);
      if (!group.ok) return toolFailure(group.error);
      const updates: any = {};
      if (args.name !== undefined) updates.name = args.name;
      if (args.color !== undefined) updates.color = args.color;
      if (args.notes !== undefined) updates.notes = args.notes;
      const updatedGroup = ctx.taskGroupStore.updateGroup(args.groupId, updates);
      return { success: true, message: `Group "${updatedGroup.name}" updated`, groupId: updatedGroup.id };
    },
  }),
  // ── Tag tools ────────────────────────────────────────────────
  defineTool("tag_list", {
    description: "List all tags with their IDs, names, and colors",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      return { tags: ctx.tagStore?.listTags().map((t) => ({ id: t.id, name: t.name, color: t.color })) };
    },
  }),
  defineTool("tag_create", {
    description: "Create a new tag for organizing tasks, groups, and docs",
    parameters: { type: "object", properties: { name: { type: "string", description: "Tag name (e.g., 'python', 'frontend', 'urgent')" }, color: { type: "string", description: "Optional color: blue, purple, amber, rose, cyan, orange, slate, emerald, indigo, pink" } }, required: ["name"] },
    handler: async (args: any) => {
      const tagStore = ensureTagStore();
      if (!tagStore.ok) return toolFailure(tagStore.error);
      if (tagStore.value.getTagByName(args.name)) return toolFailure(`Tag "${args.name}" already exists`);
      const tag = tagStore.value.createTag(args.name, args.color);
      return { success: true, message: `Tag "${tag.name}" created`, tagId: tag.id };
    },
  }),
  defineTool("tag_update", {
    description: "Update a tag's name, color, or instructions",
    parameters: { type: "object", properties: { tagId: { type: "string", description: "The tag ID" }, name: { type: "string", description: "New name" }, color: { type: "string", description: "New color" }, instructions: { type: "string", description: "Custom instructions for sessions with this tag" } }, required: ["tagId"] },
    handler: async (args: any) => {
      const tagStore = ensureTagStore();
      if (!tagStore.ok) return toolFailure(tagStore.error);
      const tag = ensureTag(args.tagId);
      if (!tag.ok) return toolFailure(tag.error);
      const updates: Record<string, any> = {};
      if (args.name !== undefined) {
        const existingTag = tagStore.value.getTagByName(args.name);
        if (existingTag && existingTag.id !== args.tagId) return toolFailure(`Tag "${args.name}" already exists`);
        updates.name = args.name;
      }
      if (args.color !== undefined) updates.color = args.color;
      if (args.instructions !== undefined) updates.instructions = args.instructions;
      if (Object.keys(updates).length === 0) return toolFailure("Provide at least one of: name, color, instructions");
      tagStore.value.updateTag(args.tagId, updates);
      ctx.sessionManager.evictAllCachedSessions();
      return { success: true, message: `Tag updated` };
    },
  }),
  defineTool("tag_delete", {
    description: "Delete a tag. Removes it from all entities.",
    parameters: { type: "object", properties: { tagId: { type: "string", description: "The tag ID to delete" } }, required: ["tagId"] },
    handler: async (args: any) => {
      ctx.tagStore?.deleteTag(args.tagId);
      ctx.sessionManager.evictAllCachedSessions();
      return { success: true, message: "Tag deleted" };
    },
  }),
  // ── Checklist tools ───────────────────────────────────────────
  defineTool("checklist_add", {
    description: "Add a checklist item to a task's checklist, or create a global checklist item if no taskId is provided",
    parameters: { type: "object", properties: { taskId: { type: "string", description: "The task ID. Omit to create a global (unparented) checklist item." }, text: { type: "string", description: "The checklist item text" }, deadline: { type: "string", description: "Optional deadline date in YYYY-MM-DD format" } }, required: ["text"] },
    handler: async (args: any) => {
      if (args.taskId !== undefined && args.taskId !== null) {
        const task = ensureTask(args.taskId);
        if (!task.ok) return toolFailure(task.error);
      }
      const checklistItem = ctx.checklistStore.createChecklistItem(args.taskId ?? null, args.text, args.deadline);
      return {
        success: true,
        message: `Checklist item added: "${checklistItem.text}"${checklistItem.deadline ? ` (due ${checklistItem.deadline})` : ""}`,
        checklistItemId: checklistItem.id,
      };
    },
  }),
  defineTool("checklist_list", {
    description: "List all checklist items for a task",
    parameters: { type: "object", properties: { taskId: { type: "string", description: "The task ID" } }, required: ["taskId"] },
    handler: async (args: any) => {
      const checklistItems = ctx.checklistStore.listChecklistItems(args.taskId);
      const today = new Date().toISOString().slice(0, 10);
      return {
        checklistItems: checklistItems.map((t) => ({ id: t.id, text: t.text, done: t.done, deadline: t.deadline ?? null, isOverdue: !t.done && !!t.deadline && t.deadline < today })),
        total: checklistItems.length,
        done: checklistItems.filter((t) => t.done).length,
      };
    },
  }),
  defineTool("checklist_update", {
    description: "Update a checklist item's text, done status, or deadline",
    parameters: { type: "object", properties: { checklistItemId: { type: "string", description: "The checklist item ID" }, text: { type: "string", description: "New text" }, done: { type: "boolean", description: "Mark done (true) or not done (false)" }, deadline: { type: "string", description: "Deadline date in YYYY-MM-DD format, or null to clear" } }, required: ["checklistItemId"] },
    handler: async (args: any) => {
      const updates: Record<string, any> = {};
      if (args.text !== undefined) updates.text = args.text;
      if (args.done !== undefined) updates.done = args.done;
      if (args.deadline !== undefined) updates.deadline = args.deadline || undefined;
      if (Object.keys(updates).length === 0) return toolFailure("Provide at least one of: text, done, deadline");
      const checklistItem = ensureChecklistItem(args.checklistItemId);
      if (!checklistItem.ok) return toolFailure(checklistItem.error);
      const updatedChecklistItem = ctx.checklistStore.updateChecklistItem(args.checklistItemId, updates);
      return { success: true, message: `Checklist item ${args.done ? "completed" : "updated"}: "${updatedChecklistItem.text}"` };
    },
  }),
  defineTool("checklist_remove", {
    description: "Remove a checklist item from a task's checklist",
    parameters: { type: "object", properties: { checklistItemId: { type: "string", description: "The checklist item ID" } }, required: ["checklistItemId"] },
    handler: async (args: any) => {
      ctx.checklistStore.deleteChecklistItem(args.checklistItemId);
      return { success: true, message: "Checklist item removed" };
    },
  }),
  defineTool("session_rename", {
    description: "Rename a chat session. Use this to give a session a more descriptive title.",
    parameters: { type: "object", properties: { sessionId: { type: "string", description: "The session ID to rename" }, title: { type: "string", description: "The new title (3-6 words recommended)" } }, required: ["title"] },
    handler: async (args: any, invocation: any) => {
      const sessionId = normalizeSessionTitle(args.sessionId) || invocation.sessionId;
      const title = normalizeSessionTitle(args.title);

      if (!sessionId) return toolFailure("sessionId is required");
      if (!title) return toolFailure("Title is required");
      if (looksLikePromptEchoTitle(title)) return toolFailure("Title looks like echoed prompt text");
      if (title.length > 80) return toolFailure("Title is too long");

      storeSessionTitle(ctx.sessionTitles, ctx.eventBusRegistry, ctx.globalBus, sessionId, title);
      return { success: true, sessionId, message: `Session renamed to "${title}"` };
    },
  }),
  defineTool("send_attachment", {
    description:
      "Publish a file as an attachment the user can open or download. " +
      "Use this when the user asks you to send them a file, export, image, report, or other artifact. " +
      "Provide exactly one of `path` or `content`. When using `path`, absolute paths work best and relative paths resolve from the bridge repository root. " +
      "After calling this tool, include the returned `markdown` snippet verbatim in your next assistant response so the attachment appears in chat.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or repository-relative path of an existing file to publish." },
        content: { type: "string", description: "UTF-8 text content to write into a new attachment file." },
        displayName: { type: "string", description: "Optional filename to show the user. Required when using content." },
      },
    },
    handler: async (args: any, invocation: any) => {
      if (!invocation.sessionId) return toolFailure("sessionId is required");

      const rawPath = typeof args.path === "string" ? args.path.trim() : "";
      const content = typeof args.content === "string" ? args.content : undefined;
      const attachmentApiBasePath = getAttachmentApiBasePath(ctx);
      const published = publishOutboundAttachment({
        copilotHome: ctx.copilotHome ?? join(homedir(), ".copilot"),
        sessionId: invocation.sessionId,
        apiBasePath: attachmentApiBasePath,
        ...(rawPath ? { sourcePath: resolvePublishableAttachmentSourcePath(rawPath) } : {}),
        ...(content !== undefined ? { content } : {}),
        ...(typeof args.displayName === "string" ? { displayName: args.displayName } : {}),
      });
      if (!published.ok) return toolFailure(published.error);

      const attachment = published.value;
      const rendered = renderPublishedAttachment(attachmentApiBasePath, invocation.sessionId, attachment);
      const instructions =
        `Attachment "${attachment.displayName}" is ready. ` +
        `In your next response, include this markdown exactly:\n\n${rendered.recommendedMarkdown}`;
      return {
        success: true,
        content: instructions,
        message: `Attachment "${attachment.displayName}" published`,
        attachmentId: attachment.attachmentId,
        displayName: attachment.displayName,
        mimeType: attachment.mimeType,
        size: attachment.size,
        url: rendered.urlPath,
        markdown: rendered.recommendedMarkdown,
        linkMarkdown: rendered.linkMarkdown,
        ...(rendered.imageMarkdown ? { imageMarkdown: rendered.imageMarkdown } : {}),
      };
    },
  }),
  defineTool("self_restart", {
    description: "Restart the Copilot Bridge server WITHOUT code changes (config reload, env changes, emergency restart). For deploying code changes, use staging_init → make changes → staging_deploy instead. The launcher will auto-checkpoint, rebuild, and swap processes. IMPORTANT: This session counts as active — do not make further tool calls after invoking this, or you will block the restart. RESTRICTED: Only the primary session agent may call this tool. Sub-agents spawned via the task tool must NEVER call this.",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      const dataDir = join(REPO_ROOT, "data");
      if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
      writeFileSync(SIGNAL_FILE, new Date().toISOString());

      const otherBusy = triggerRestartPending();
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
      if (existsSync(SIGNAL_FILE)) {
        return toolFailure("A restart is already pending. Wait for it to complete before updating.");
      }

      const dataDir = join(REPO_ROOT, "data");
      if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

      // Determine current branch
      const branchResult = run("git rev-parse --abbrev-ref HEAD");
      const branch = branchResult.ok ? branchResult.output.trim() : "main";

      // Save pre-update checkpoint so the launcher can roll back
      const headResult = run("git rev-parse HEAD");
      const preUpdateSha = headResult.ok ? headResult.output.trim() : "";
      const rollbackCheckpoint = preserveOrCreateRollbackCheckpoint(PRE_DEPLOY_SHA_FILE, preUpdateSha);

      // Pull latest
      const pullResult = run(`git pull --rebase origin ${branch}`);
      if (!pullResult.ok) {
        // Abort rebase if it left us in a conflicted state
        run("git rebase --abort");
        removeRollbackCheckpointIfCreated(PRE_DEPLOY_SHA_FILE, rollbackCheckpoint);
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
        removeRollbackCheckpointIfCreated(PRE_DEPLOY_SHA_FILE, rollbackCheckpoint);
        return { success: true, message: "Already up to date — no restart needed." };
      }

      // Signal restart — launcher will sync dependencies, build, health-check, and roll back if needed
      const dependencyInputsChanged = !!preUpdateSha
        && (() => {
          const diffResult = run(`git diff "${preUpdateSha}" HEAD --name-only -- ${DEPENDENCY_SYNC_GIT_PATHSPEC}`);
          return diffResult.ok && !!diffResult.output.trim();
        })();
      writeFileSync(SIGNAL_FILE, new Date().toISOString());
      const otherBusy = triggerRestartPending();
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
  // ── Schedule tools ──────────────────────────────────────────────
  defineTool("schedule_create", {
    description: "Create a scheduled session that runs automatically on a cron schedule or at a specific time. The schedule belongs to a task and will create sessions linked to that task when triggered.",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "The task ID this schedule belongs to" },
        name: { type: "string", description: "Human-readable name (e.g. 'Daily standup prep')" },
        prompt: { type: "string", description: "The message to send when the schedule fires" },
        type: { type: "string", enum: ["cron", "once"], description: "Schedule type: 'cron' for recurring, 'once' for one-shot" },
        cron: { type: "string", description: "Cron expression (e.g. '0 8 * * 1-5' for weekdays at 8am). Required for type=cron. Interpreted in the schedule's timezone (server-local by default)." },
        runAt: { type: "string", description: "ISO timestamp for one-shot runs (e.g. '2026-03-21T18:00:00Z'). Required for type=once. Always interpreted as UTC." },
        timezone: { type: "string", description: "IANA timezone for cron interpretation (e.g. 'America/New_York'). Defaults to server-local timezone if omitted." },
        sessionMode: {
          type: "string",
          enum: ["new", "reuse-last", "reuse-target"],
          description: "How the schedule chooses its session: 'new' creates a fresh session each run, 'reuse-last' continues the last session used by this schedule, and 'reuse-target' always uses targetSessionId.",
        },
        targetSessionId: {
          type: "string",
          description: "Session to use when sessionMode='reuse-target'. If omitted during an in-session tool call, defaults to the invoking session.",
        },
        maxRuns: { type: "number", description: "Auto-disable after N runs (optional)" },
        expiresAt: { type: "string", description: "ISO timestamp after which the schedule auto-disables (optional)" },
      },
      required: ["taskId", "name", "prompt", "type"],
    },
    handler: async (args: any, invocation: any) => {
      if (args.type === "cron" && !args.cron) return toolFailure("cron expression is required for cron schedules");
      if (args.type === "once" && !args.runAt) return toolFailure("runAt is required for one-shot schedules");
      if (args.timezone && !schedulerModule.isValidTimezone(args.timezone)) return toolFailure(`Invalid timezone: ${args.timezone}`);
      const task = ensureTask(args.taskId);
      if (!task.ok) return toolFailure(task.error);

      const selection = await resolveScheduleSessionSelection(
        { sessionMode: args.sessionMode, targetSessionId: args.targetSessionId },
        {
          taskId: args.taskId,
          taskStore: ctx.taskStore,
          listSessionsFromDisk: () => ctx.sessionManager.listSessionsFromDisk(),
          defaultSessionMode: "new",
          defaultTargetSessionId: args.sessionMode === "reuse-target" ? invocation?.sessionId : undefined,
        },
      );
      if (!selection.ok) return toolFailure(selection.error);

      const schedule = ctx.scheduleStore.createSchedule({
        taskId: args.taskId,
        name: args.name,
        prompt: args.prompt,
        type: args.type,
        cron: args.cron,
        runAt: args.runAt,
        timezone: args.timezone,
        sessionMode: selection.value.sessionMode,
        targetSessionId: selection.value.targetSessionId,
        maxRuns: args.maxRuns,
        expiresAt: args.expiresAt,
      });

      if (schedule.type === "cron") {
        schedulerModule.registerSchedule(schedule.id);
      } else if (schedule.type === "once" && schedule.runAt) {
        schedulerModule.armOneShot(schedule.id, schedule.runAt);
      }

      ctx.globalBus.emit({ type: "schedule:changed", taskId: schedule.taskId, scheduleId: schedule.id });
      return { success: true, message: `Schedule "${schedule.name}" created (${schedule.type})`, scheduleId: schedule.id, timezone: schedule.timezone, nextRunAt: schedule.nextRunAt };
    },
  }),
  defineTool("schedule_update", {
    description: "Update a scheduled session's settings. Only provided fields are changed.",
    parameters: {
      type: "object",
      properties: {
        scheduleId: { type: "string", description: "The schedule ID to update" },
        name: { type: "string", description: "New name" },
        prompt: { type: "string", description: "New prompt text" },
        cron: { type: "string", description: "New cron expression" },
        runAt: { type: "string", description: "New one-shot run time (ISO timestamp)" },
        timezone: { type: "string", description: "IANA timezone for cron interpretation (e.g. 'America/Los_Angeles')" },
        enabled: { type: "boolean", description: "Enable or disable the schedule" },
        sessionMode: {
          type: "string",
          enum: ["new", "reuse-last", "reuse-target"],
          description: "Change how the schedule chooses its session.",
        },
        targetSessionId: {
          type: "string",
          description: "Session to use when sessionMode='reuse-target'. If omitted while switching to target mode from inside a session, defaults to the invoking session.",
        },
        maxRuns: { type: "number", description: "Auto-disable after N runs" },
        expiresAt: { type: "string", description: "ISO timestamp after which the schedule auto-disables" },
      },
      required: ["scheduleId"],
    },
    handler: async (args: any, invocation: any) => {
      const { scheduleId, ...updates } = args;
      if (Object.keys(updates).length === 0) return toolFailure("No fields to update");
      if (args.timezone && !schedulerModule.isValidTimezone(args.timezone)) return toolFailure(`Invalid timezone: ${args.timezone}`);
      const existing = ctx.scheduleStore.getSchedule(scheduleId);
      if (!existing) return toolFailure(`Schedule ${scheduleId} not found`);

      const nextUpdates = { ...updates };
      if (args.sessionMode !== undefined || args.targetSessionId !== undefined) {
        const requestedSessionMode = args.sessionMode ?? existing.sessionMode;
        const existingTargetStillLinked = !!existing.targetSessionId
          && ctx.taskStore.getTask(existing.taskId)?.sessionIds.includes(existing.targetSessionId) === true;
        const preservingExistingTarget = requestedSessionMode === "reuse-target"
          && args.targetSessionId === undefined
          && existing.sessionMode === "reuse-target"
          && existingTargetStillLinked;
        if (preservingExistingTarget) {
          nextUpdates.sessionMode = "reuse-target";
        } else {
          const defaultTargetSessionId = existing.sessionMode === "reuse-target"
            ? existing.targetSessionId
            : args.sessionMode === "reuse-target"
              ? invocation?.sessionId
              : undefined;
          const selection = await resolveScheduleSessionSelection(
            { sessionMode: args.sessionMode, targetSessionId: args.targetSessionId },
            {
              taskId: existing.taskId,
              taskStore: ctx.taskStore,
              listSessionsFromDisk: () => ctx.sessionManager.listSessionsFromDisk(),
              defaultSessionMode: existing.sessionMode,
              defaultTargetSessionId,
            },
          );
          if (!selection.ok) return toolFailure(selection.error);
          nextUpdates.sessionMode = selection.value.sessionMode;
          if (selection.value.sessionMode === "reuse-target" || args.targetSessionId !== undefined) {
            nextUpdates.targetSessionId = selection.value.targetSessionId;
          }
        }
      }

      const schedule = ctx.scheduleStore.updateSchedule(scheduleId, nextUpdates);

      if (schedule.type === "cron") {
        if (schedule.enabled) schedulerModule.registerSchedule(schedule.id);
        else schedulerModule.unregisterSchedule(schedule.id);
      } else if (schedule.type === "once" && args.runAt && schedule.enabled) {
        schedulerModule.armOneShot(schedule.id, schedule.runAt!);
      }

      ctx.globalBus.emit({ type: "schedule:changed", taskId: schedule.taskId, scheduleId: schedule.id });
      return { success: true, message: `Schedule "${schedule.name}" updated`, nextRunAt: schedule.nextRunAt };
    },
  }),
  defineTool("schedule_delete", {
    description: "Delete a scheduled session permanently.",
    parameters: {
      type: "object",
      properties: {
        scheduleId: { type: "string", description: "The schedule ID to delete" },
      },
      required: ["scheduleId"],
    },
    handler: async (args: any) => {
      const schedule = ctx.scheduleStore.getSchedule(args.scheduleId);
      const taskId = schedule?.taskId;
      schedulerModule.unregisterSchedule(args.scheduleId);
      ctx.scheduleStore.deleteSchedule(args.scheduleId);
      if (taskId) ctx.globalBus.emit({ type: "schedule:changed", taskId, scheduleId: args.scheduleId });
      return { success: true, message: "Schedule deleted" };
    },
  }),
  defineTool("schedule_list", {
    description: "List all scheduled sessions, optionally filtered by task.",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Filter by task ID (optional)" },
      },
    },
    handler: async (args: any) => {
      const schedules = ctx.scheduleStore.listSchedules(args.taskId);
      return {
        schedules: schedules.map((s) => ({
          id: s.id,
          taskId: s.taskId,
          name: s.name,
          type: s.type,
          cron: s.cron,
          runAt: s.runAt,
          timezone: s.timezone,
          enabled: s.enabled,
          sessionMode: s.sessionMode,
          targetSessionId: s.targetSessionId,
          lastRunAt: s.lastRunAt,
          nextRunAt: s.nextRunAt,
          runCount: s.runCount,
          prompt: s.prompt,
          maxRuns: s.maxRuns,
          expiresAt: s.expiresAt,
        })),
      };
    },
  }),
  defineTool("schedule_trigger", {
    description: "Manually trigger a scheduled session right now, regardless of its cron schedule.",
    parameters: {
      type: "object",
      properties: {
        scheduleId: { type: "string", description: "The schedule ID to trigger" },
      },
      required: ["scheduleId"],
    },
    handler: async (args: any) => {
      const result = await schedulerModule.triggerSchedule(args.scheduleId);
      return result;
    },
  }),

  // ── Docs / Knowledge Base tools ─────────────────────────────────

  ...(ctx.docsStore && ctx.docsIndex ? [
    defineTool("docs_search", {
      description: "Search the knowledge base using full-text search. Returns matching pages with titles, snippets, and relevance scores.",
      parameters: { type: "object", properties: { query: { type: "string", description: "Search query text" }, limit: { type: "number", description: "Max results (default 20)" }, offset: { type: "number", description: "Offset for pagination (default 0)" } }, required: ["query"] },
      handler: async (args: any) => ctx.docsIndex!.search(args.query, args.limit ?? 20, args.offset ?? 0),
    }),
    defineTool("docs_read", {
      description: "Read a knowledge base page by its path. Returns frontmatter metadata and markdown body.",
      parameters: { type: "object", properties: { path: { type: "string", description: "Page path relative to docs root (e.g., 'incidents/march-outage')" } }, required: ["path"] },
      handler: async (args: any) => {
        try {
          const page = ctx.docsStore!.readPage(args.path);
          if (!page) return toolFailure(`Page not found: ${args.path}`);
          return { path: page.path, title: page.title, tags: page.tags, frontmatter: page.frontmatter, body: page.body };
        } catch (error) {
          return normalizeDocsToolFailure(error);
        }
      },
    }),
    defineTool("docs_write", {
      description: "Create or update a knowledge base page. Provide raw markdown content (with optional YAML frontmatter). Tagged or reference pages should include frontmatter title, description, and tags so the bridge can surface them to agents. Supports [[wikilinks]] — use [[page-path]] or [[page-path|Display Text]] to link between pages (resolved by path, title, or slug). Rejects writes to database collection folders — for those, use docs_db_add with { folder, fields: { title, ... }, body }.",
      parameters: { type: "object", properties: { path: { type: "string", description: "Page path relative to docs root (e.g., 'notes/my-page')" }, content: { type: "string", description: "Raw markdown content (may include YAML frontmatter)" } }, required: ["path", "content"] },
      handler: async (args: any) => {
        try {
          validateTaggedDocContent(args.content);
          const page = ctx.docsStore!.writePage(args.path, args.content);
          ctx.docsIndex!.indexPage(page);
          return { path: page.path, success: true };
        } catch (error) {
          return normalizeDocsToolFailure(error);
        }
      },
    }),
    defineTool("docs_edit", {
      description: "Make a surgical string replacement in a knowledge base page. Finds exactly one occurrence of old_str in the raw markdown (frontmatter + body) and replaces it with new_str. Tagged or reference pages must still include a frontmatter description after the edit. Supports [[wikilinks]] — use [[page-path]] or [[page-path|Display Text]] to link between pages. Errors if old_str is not found or matches multiple times — include more surrounding context to disambiguate.",
      parameters: { type: "object", properties: { path: { type: "string", description: "Page path relative to docs root (e.g., 'notes/my-page')" }, old_str: { type: "string", description: "The exact string to find in the raw page content" }, new_str: { type: "string", description: "The replacement string" } }, required: ["path", "old_str", "new_str"] },
      handler: async (args: any) => {
        try {
          const updatedContent = ctx.docsStore!.previewEditPageContent(args.path, args.old_str, args.new_str);
          validateTaggedDocContent(updatedContent);
          const page = ctx.docsStore!.writePage(args.path, updatedContent);
          ctx.docsIndex!.indexPage(page);
          return { path: page.path, success: true };
        } catch (error) {
          return normalizeDocsToolFailure(error);
        }
      },
    }),
    defineTool("docs_list", {
      description: "List pages and folders in the knowledge base. Returns a tree structure with file/folder types and database folder indicators.",
      parameters: { type: "object", properties: { folder: { type: "string", description: "Folder path to list (omit for root)" } }, required: [] },
      handler: async (args: any) => {
        try {
          return { tree: ctx.docsStore!.listTree(args.folder) };
        } catch (error) {
          return normalizeDocsToolFailure(error);
        }
      },
    }),
    defineTool("docs_db_schema", {
      description: "Get the schema for a database collection folder. Returns field names, types, options, and entry count. Call this before docs_db_add to discover valid fields.",
      parameters: { type: "object", properties: { folder: { type: "string", description: "Database folder name (e.g., 'incidents')" } }, required: ["folder"] },
      handler: async (args: any) => {
        try {
          const schema = ctx.docsStore!.readSchema(args.folder);
          if (!schema) return toolFailure(`No schema found for folder "${args.folder}"`);
          const entries = ctx.docsStore!.listDbEntries(args.folder);
          return { ...schema, entryCount: entries.length };
        } catch (error) {
          return normalizeDocsToolFailure(error);
        }
      },
    }),
    defineTool("docs_db_add", {
      description: "Create a new entry in a database collection. Preferred shape: { folder: 'incidents', fields: { title: 'March Outage', severity: 'sev1' }, body: '# Notes' }. The server validates fields against the schema and generates the markdown file.",
      parameters: { type: "object", properties: { folder: { type: "string", description: "Database folder name (e.g., 'incidents')" }, fields: { type: "object", description: "Field values as key-value pairs. Preferred shape: { title: 'Entry title', ... }." }, body: { type: "string", description: "Optional markdown body content for the entry" } }, required: ["folder"] },
      handler: async (args: any) => {
        try {
          const { fields, body } = ctx.docsStore!.normalizeDbEntryInput(args, "add", args.folder);
          const entry = ctx.docsStore!.addDbEntry(args.folder, fields, body);
          const page = ctx.docsStore!.readPage(entry.path);
          if (page) ctx.docsIndex!.indexPage(page);
          return { path: entry.path, slug: entry.slug, success: true };
        } catch (error) {
          return normalizeDocsToolFailure(error);
        }
      },
    }),
    defineTool("docs_db_update", {
      description: "Update an existing database entry. Preferred shape: { folder: 'incidents', slug: 'march-outage', fields: { severity: 'sev2' }, body?: '# Updated notes' }. Only changed fields are updated; other fields are preserved.",
      parameters: { type: "object", properties: { folder: { type: "string", description: "Database folder name (e.g., 'incidents')" }, slug: { type: "string", description: "Entry slug (filename without .md, returned by docs_db_add or docs_db_query)" }, fields: { type: "object", description: "Field values to update (preferred shape: { fieldName: value })." }, body: { type: "string", description: "Optional new markdown body content" } }, required: ["folder", "slug"] },
      handler: async (args: any) => {
        try {
          const { fields, body } = ctx.docsStore!.normalizeDbEntryInput(args, "update", args.folder);
          const entry = ctx.docsStore!.updateDbEntry(args.folder, args.slug, fields, body);
          const page = ctx.docsStore!.readPage(entry.path);
          if (page) ctx.docsIndex!.indexPage(page);
          return { path: entry.path, success: true };
        } catch (error) {
          return normalizeDocsToolFailure(error);
        }
      },
    }),
    defineTool("docs_db_query", {
      description: "Query entries in a database collection by field values. Supports equality filters, multi-value OR (pass array), pagination, sorting, and optional markdown body inclusion.",
      parameters: { type: "object", properties: { folder: { type: "string", description: "Database folder name (e.g., 'incidents')" }, filters: { type: "object", description: "Field filters as key-value pairs. Arrays match any value (OR). Example: { severity: 'sev1' } or { severity: ['sev1', 'sev2'] }" }, includeBody: { type: "boolean", description: "When true, include each entry's markdown body content in the response." }, _sort: { type: "string", description: "Field to sort by (default: 'modified')" }, _order: { type: "string", enum: ["asc", "desc"], description: "Sort order (default: 'desc')" }, _limit: { type: "number", description: "Max results (default 50)" }, _offset: { type: "number", description: "Offset for pagination (default 0)" } }, required: ["folder"] },
      handler: async (args: any) => {
        return ctx.docsIndex!.queryByFolder(
          args.folder,
          args.filters,
          args._sort ? { field: args._sort, order: args._order ?? "desc" } : undefined,
          args._limit ?? 50,
          args._offset ?? 0,
          args.includeBody === true,
        );
      },
    }),
    defineTool("docs_db_create", {
      description: "Create a new database collection by defining a schema. Creates a folder with a _schema.yaml file. Supported field types: text, select, date, number, boolean, url.",
      parameters: { type: "object", properties: { folder: { type: "string", description: "Folder name for the new database (e.g., 'incidents')" }, name: { type: "string", description: "Human-readable name for the database (e.g., 'Incidents')" }, fields: { type: "array", description: "Array of field definitions", items: { type: "object", properties: { name: { type: "string" }, type: { type: "string", enum: ["text", "select", "date", "number", "boolean", "url"] }, options: { type: "array", items: { type: "string" }, description: "Options for select fields" }, required: { type: "boolean" } }, required: ["name", "type"] } } }, required: ["folder", "name", "fields"] },
      handler: async (args: any) => {
        try {
          ctx.docsStore!.writeSchema(args.folder, { name: args.name, fields: args.fields });
          return { folder: args.folder, success: true };
        } catch (error) {
          return normalizeDocsToolFailure(error);
        }
      },
    }),
    defineTool("docs_delete", {
      description: "Delete a knowledge base page permanently. Returns whether the page was found and deleted. Cannot delete pages inside database collections — use docs_db_delete for those.",
      parameters: { type: "object", properties: { path: { type: "string", description: "Page path relative to docs root (e.g., 'notes/my-page')" } }, required: ["path"] },
      handler: async (args: any) => {
        try {
          const pagePath: string = args.path;
          // Guard: don't allow deleting DB entries via this tool
          const page = ctx.docsStore!.readPage(pagePath);
          if (page?.isDbItem) {
            return toolFailure(`"${pagePath}" is a database entry. Use docs_db_delete with { folder, slug } to remove it.`);
          }
          const canonicalPath = page?.path ?? pagePath;
          const deleted = ctx.docsStore!.deletePage(pagePath);
          if (deleted) ctx.docsIndex!.removePage(canonicalPath);
          return { path: canonicalPath, deleted };
        } catch (error) {
          return normalizeDocsToolFailure(error);
        }
      },
    }),
    defineTool("docs_db_delete", {
      description: "Delete an entry from a database collection permanently. Removes the markdown file for the entry.",
      parameters: { type: "object", properties: { folder: { type: "string", description: "Database folder name (e.g., 'incidents')" }, slug: { type: "string", description: "Entry slug (filename without .md, returned by docs_db_add or docs_db_query)" } }, required: ["folder", "slug"] },
      handler: async (args: any) => {
        try {
          const schema = ctx.docsStore!.readSchema(args.folder);
          if (!schema) return toolFailure(`No database collection found at "${args.folder}"`);
          const pagePath = `${args.folder}/${args.slug}`;
          // Verify it's actually a DB entry
          const page = ctx.docsStore!.readPage(pagePath);
          if (page && !page.isDbItem) {
            return toolFailure(`"${pagePath}" is not a database entry`);
          }
          const deleted = ctx.docsStore!.deletePage(pagePath);
          if (deleted) ctx.docsIndex!.removePage(pagePath);
          return { folder: args.folder, slug: args.slug, deleted };
        } catch (error) {
          return normalizeDocsToolFailure(error);
        }
      },
    }),
  ] : []),

    ...(demoMode ? [] : STAGING_TOOLS),

    ...createWebSearchTools(ctx),

    ...createBrowserFetchTools(ctx),

    ...createBrowserExecTools(ctx),

    ...createBrowserSessionTools(ctx),

    ...createComputerUseTools(ctx),
  ];

  if (!demoMode) return tools;

  const hiddenTools = new Set<string>([
    "self_restart",
    "self_update",
    ...STAGING_TOOLS.map((tool) => tool.name),
  ]);
  return tools.filter((tool) => !hiddenTools.has(tool.name));
}

export type SessionRunState = "busy" | "stalled" | "idle";

interface SessionRunRecord {
  state: Exclude<SessionRunState, "idle">;
  startedAt: number;
  lastEventAt: number;
  stalledAt?: number;
}

interface SessionRunController {
  completion: Promise<void>;
  isCompleted(): boolean;
  completeDone(content: string): void;
  completeError(message: string): void;
  completeAborted(content: string): void;
  completeShutdown(content: string): void;
  awaitAbortConfirmation(delayMs: number, getContent: () => string): Promise<boolean>;
  clearAbortWait(): void;
}

const ABORT_CONFIRMATION_TIMEOUT_MS = 2_000;
const SYNC_SHELL_TOOL_NAMES = new Set(["bash", "powershell"]);

function asObjectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function getSyncShellInitialWaitUntil(toolName: string, args: unknown, startedAt: number): number | undefined {
  if (!SYNC_SHELL_TOOL_NAMES.has(toolName)) return undefined;
  const argRecord = asObjectRecord(args);
  if (!argRecord || argRecord.mode !== "sync") return undefined;

  const rawInitialWait = argRecord.initial_wait;
  const initialWaitSeconds = typeof rawInitialWait === "number"
    ? rawInitialWait
    : typeof rawInitialWait === "string"
      ? Number(rawInitialWait)
      : Number.NaN;
  if (!Number.isFinite(initialWaitSeconds) || initialWaitSeconds <= 0) return undefined;
  return startedAt + initialWaitSeconds * 1000;
}

function getSessionShutdownType(data: any): string | undefined {
  return typeof data?.shutdownType === "string" ? data.shutdownType.toLowerCase() : undefined;
}

export interface SessionActivity {
  id: string;
  state: Exclude<SessionRunState, "idle">;
  startedAt: number;
  lastEventAt: number;
  stalledAt?: number;
  elapsedMs: number;
  staleMs: number;
}

export interface SessionManagerDeps {
  tools: ReturnType<typeof defineTool>[];
  globalBus: GlobalBus;
  eventBusRegistry: EventBusRegistry;
  sessionTitles: SessionTitlesStore;
  taskStore: TaskStore;
  taskGroupStore?: TaskGroupStore;
  checklistStore?: ChecklistStore;
  settingsStore?: SettingsStore;
  tagStore?: TagStore;
  docsIndex?: DocsIndex;
  docsStore?: DocsStore;
  browserSessionStore?: BrowserSessionStore;
  config: { sessionMcpServers: Record<string, McpServerConfig>; model?: string };
  telemetryStore?: TelemetryStore;
  /** Custom env for CopilotClient — use to set COPILOT_HOME for session isolation */
  clientEnv?: Record<string, string | undefined>;
  /** Root of .copilot directory — defaults to homedir()/.copilot */
  copilotHome?: string;
  runtimePaths?: RuntimePaths;
}

/** Options that don't come from AppContext — caller provides these directly. */
export interface CreateSessionManagerOpts {
  tools: ReturnType<typeof defineTool>[];
  config: SessionManagerDeps["config"];
  clientEnv?: SessionManagerDeps["clientEnv"];
  copilotHome?: string;
  runtimePaths?: RuntimePaths;
}

/**
 * Factory that maps AppContext → SessionManagerDeps.
 *
 * Staging preview dynamically imports this from the worktree, so new deps are
 * picked up automatically without touching staging-tools.ts.
 */
export function createSessionManager(ctx: AppContext, opts: CreateSessionManagerOpts): SessionManager {
  const runtimePaths = opts.runtimePaths ?? ctx.runtimePaths;
  const copilotHome = opts.copilotHome ?? ctx.copilotHome ?? runtimePaths?.copilotHome;
  const clientEnv = opts.clientEnv
    ?? runtimePaths?.env
    ?? (copilotHome ? { ...process.env, COPILOT_HOME: copilotHome } : undefined);
  return new SessionManager({
    tools: opts.tools,
    globalBus: ctx.globalBus,
    eventBusRegistry: ctx.eventBusRegistry,
    sessionTitles: ctx.sessionTitles,
    taskStore: ctx.taskStore,
    taskGroupStore: ctx.taskGroupStore,
    checklistStore: ctx.checklistStore,
    settingsStore: ctx.settingsStore,
    tagStore: ctx.tagStore,
    docsIndex: ctx.docsIndex,
    docsStore: ctx.docsStore,
    browserSessionStore: getOrCreateBrowserSessionStore(ctx, {
      copilotHome,
      telemetryStore: ctx.telemetryStore,
    }),
    telemetryStore: ctx.telemetryStore,
    config: opts.config,
    clientEnv,
    copilotHome,
    runtimePaths,
  });
}

export interface McpServerStatus {
  name: string;
  status: "connected" | "failed" | "pending" | "disabled" | "not_configured" | "unknown";
  error?: string;
  source?: string;
}

export class SessionManager {
  private client: CopilotClient | null = null;
  private deps: SessionManagerDeps;
  private sessionRuns = new Map<string, SessionRunRecord>();
  private activeRunControllers = new Map<string, SessionRunController>();
  private resumingSessions = new Set<string>();
  private sessionObjects = new Map<string, any>(); // cached CopilotSession objects
  private mcpStatus = new Map<string, McpServerStatus[]>(); // per-session MCP server status
  private visibleActivityCache = new Map<string, { eventsMtimeMs: number; lastVisibleActivityAt?: string }>();

  // listSessions cache — avoids expensive SDK filesystem scan on every call
  private sessionListCache: { data: any[]; timestamp: number } | null = null;
  private static SESSION_LIST_TTL = 60_000; // 1 minute TTL

  constructor(deps: SessionManagerDeps) {
    this.deps = deps;
  }

  private recordSpan(name: string, duration: number, sessionId?: string, metadata?: Record<string, unknown>): void {
    try {
      this.deps.telemetryStore?.recordSpan({ name, duration, sessionId, metadata, source: "server" });
    } catch { /* telemetry should never break core flow */ }
  }

  private createRunController(
    sessionId: string,
    bus: ReturnType<typeof getOrCreateBus>,
  ): SessionRunController {
    let completed = false;
    let abortFallbackTimer: ReturnType<typeof setTimeout> | undefined;
    let abortFallbackPromise: Promise<boolean> | null = null;
    let resolveCompletion!: () => void;
    let resolveAbortFallback: ((fired: boolean) => void) | undefined;

    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });

    const settleAbortFallback = (fired: boolean) => {
      const resolver = resolveAbortFallback;
      resolveAbortFallback = undefined;
      abortFallbackPromise = null;
      resolver?.(fired);
    };

    const clearAbortWait = () => {
      if (abortFallbackTimer) {
        clearTimeout(abortFallbackTimer);
        abortFallbackTimer = undefined;
      }
      settleAbortFallback(false);
    };

    const finish = (emitTerminal?: (timestamp: string) => void): boolean => {
      if (completed) return false;
      completed = true;
      clearAbortWait();
      emitTerminal?.(new Date().toISOString());
      resolveCompletion();
      return true;
    };

    return {
      completion,
      isCompleted: () => completed,
      completeDone: (content) => {
        finish((timestamp) => {
          bus.emit({ type: "done", content, timestamp });
        });
      },
      completeError: (message) => {
        finish((timestamp) => {
          bus.emit({ type: "error", message, timestamp });
        });
      },
      completeAborted: (content) => {
        finish((timestamp) => {
          bus.emit({ type: "aborted", content, timestamp });
        });
      },
      completeShutdown: (content) => {
        finish((timestamp) => {
          bus.emit({ type: "shutdown", content, timestamp });
        });
      },
      awaitAbortConfirmation: (delayMs, getContent) => {
        if (completed) return Promise.resolve(false);
        if (abortFallbackPromise) return abortFallbackPromise;
        abortFallbackPromise = new Promise<boolean>((resolve) => {
          resolveAbortFallback = resolve;
          abortFallbackTimer = setTimeout(() => {
            abortFallbackTimer = undefined;
            abortFallbackPromise = null;
            resolveAbortFallback = undefined;
            if (completed) {
              resolve(false);
              return;
            }
            console.warn(`[sdk] [${sessionId.slice(0, 8)}] 🛑 Abort not confirmed after ${delayMs}ms — resolving locally`);
            resolve(finish((timestamp) => {
              bus.emit({ type: "aborted", content: getContent(), timestamp });
            }));
          }, delayMs);
        });
        return abortFallbackPromise;
      },
      clearAbortWait,
    };
  }

  private setSessionRunState(
    sessionId: string,
    state: SessionRunState,
    opts: { now?: number; lastEventAt?: number } = {},
  ): void {
    const current = this.sessionRuns.get(sessionId);
    const now = opts.now ?? Date.now();

    if (state === "idle") {
      if (!current) return;
      this.sessionRuns.delete(sessionId);
      this.deps.globalBus.emit({ type: "session:idle", sessionId });
      if (_restartPending) {
        this.deps.globalBus.emit({ type: "server:restart-pending", waitingSessions: this.sessionRuns.size });
      }
      return;
    }

    const next: SessionRunRecord = {
      state,
      startedAt: current?.startedAt ?? now,
      lastEventAt: opts.lastEventAt ?? current?.lastEventAt ?? now,
      stalledAt: state === "stalled" ? current?.stalledAt ?? now : undefined,
    };
    this.sessionRuns.set(sessionId, next);

    if (current?.state === state) return;

    this.deps.globalBus.emit({ type: state === "stalled" ? "session:stalled" : "session:busy", sessionId });
    if (_restartPending && !current) {
      this.deps.globalBus.emit({ type: "server:restart-pending", waitingSessions: this.sessionRuns.size });
    }
  }

  private touchSessionRun(sessionId: string, at = Date.now()): void {
    const current = this.sessionRuns.get(sessionId);
    if (!current) return;
    if (current.state === "stalled") {
      this.setSessionRunState(sessionId, "busy", { now: at, lastEventAt: at });
      return;
    }
    current.lastEventAt = at;
  }

  private async getCachedLastVisibleActivityAt(
    sessionId: string,
    eventsPath: string,
    eventsMtimeMs: number,
  ): Promise<string | undefined> {
    const cached = this.visibleActivityCache.get(sessionId);
    if (cached && cached.eventsMtimeMs === eventsMtimeMs) {
      return cached.lastVisibleActivityAt;
    }

    let raw: string;
    try {
      raw = await readFile(eventsPath, "utf-8");
    } catch {
      this.visibleActivityCache.set(sessionId, { eventsMtimeMs, lastVisibleActivityAt: cached?.lastVisibleActivityAt });
      return cached?.lastVisibleActivityAt;
    }

    const events: any[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        continue;
      }
    }

    const lastVisibleActivityAt = getLastVisibleActivityAt(events, sessionId);
    this.visibleActivityCache.set(sessionId, { eventsMtimeMs, lastVisibleActivityAt });
    return lastVisibleActivityAt;
  }

  private getWorkspaceSummary(sessionId: string): string | undefined {
    const yamlPath = join(this.getSessionStateDir(sessionId), "workspace.yaml");
    try {
      return parseWorkspaceSummary(readFileSync(yamlPath, "utf-8"));
    } catch {
      return undefined;
    }
  }

  private getCopilotHome(): string {
    return this.deps.copilotHome ?? join(homedir(), ".copilot");
  }

  private getSessionStateDir(sessionId: string): string {
    return join(this.getCopilotHome(), "session-state", sessionId);
  }

  private getSessionPlanPath(sessionId: string): string {
    return join(this.getSessionStateDir(sessionId), "plan.md");
  }

  hasPlan(sessionId: string): boolean {
    return existsSync(this.getSessionPlanPath(sessionId));
  }

  private getFirstUserPrompt(sessionId: string): string | undefined {
    const copilotHome = this.deps.copilotHome ?? join(homedir(), ".copilot");
    const eventsPath = join(copilotHome, "session-state", sessionId, "events.jsonl");
    try {
      const raw = readFileSync(eventsPath, "utf-8");
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event?.type !== "user.message") continue;
          const content = event?.data?.content ?? event?.data?.prompt;
          if (typeof content === "string" && content.trim()) return content;
        } catch {
          continue;
        }
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  private hasStoredSessionTitle(sessionId: string): boolean {
    return this.deps.sessionTitles.hasTitle(sessionId);
  }

  private hasExistingSessionTitle(sessionId: string): boolean {
    const summary = this.getWorkspaceSummary(sessionId);
    if (!summary || !looksLikeExistingSessionTitle(summary)) return false;
    const firstUserPrompt = this.getFirstUserPrompt(sessionId);
    return !isPromptEchoSummary(summary, firstUserPrompt);
  }

  private shouldInjectSelfRenameGuidance(sessionId?: string): boolean {
    if (!sessionId) return true;
    return !this.hasStoredSessionTitle(sessionId) && !this.hasExistingSessionTitle(sessionId);
  }

  private lookupGroupNotes(groupId?: string): { groupName: string; notes: string } | null {
    if (!groupId || !this.deps.taskGroupStore) return null;
    const group = this.deps.taskGroupStore.getGroup(groupId);
    if (!group?.notes?.trim()) return null;
    return { groupName: group.name, notes: group.notes };
  }

  private buildSessionConfig(opts: SessionConfigOptions = {}) {
    const { sessionId, task, isNewTask, prDescriptions, scheduleContext, groupNotes } = opts;
    const runtimePaths = this.deps.runtimePaths;
    const demoMode = isDemoMode(runtimePaths);
    const workingDirectory = task?.cwd ?? resolveDemoWorkspaceDir(runtimePaths);

    const cfg: any = {
      onPermissionRequest: approveAll,
      tools: this.deps.tools,
      excludedTools: [...BRIDGE_EXCLUDED_TOOLS],
      mcpServers: this.deps.settingsStore?.getMcpServers() ?? this.deps.config.sessionMcpServers,
      skillDirectories: [
        join(REPO_ROOT, "skills"),                                          // built-in (ships with bridge)
        join(this.getCopilotHome(), "skills"), // user-level
      ],
    };

    // Model priority: settings store > deps.config > SDK default
    const model = this.deps.settingsStore?.getSettings().model ?? this.deps.config.model;
    if (model) cfg.model = model;

    // Reasoning effort: settings store > SDK default
    const reasoningEffort = this.deps.settingsStore?.getSettings().reasoningEffort;
    if (reasoningEffort) cfg.reasoningEffort = reasoningEffort;

    if (workingDirectory) {
      cfg.workingDirectory = workingDirectory;
    }

    const contextParts: string[] = [];

    if (task) {
      contextParts.push(
        `You are helping with task "${task.title}" (taskId: ${task.id}).`,
        `Task status: ${task.status}.`,
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
          ? task.pullRequests.map((pr: any) => `${pr.repoName || pr.repoId} #${pr.prId}`)
          : []);
      if (prStrings.length > 0) {
        contextParts.push(`Currently linked PRs: ${prStrings.join(", ")}.`);
      }
      if (task.notes.trim()) {
        contextParts.push(`Task notes:\n${task.notes}`);
      }
      // Inject group notes if provided
      if (groupNotes?.notes?.trim()) {
        contextParts.push(`Group notes (from task group "${groupNotes.groupName}" that this task belongs to):\n${groupNotes.notes}`);
      }
      const checklistItems = this.deps.checklistStore?.listChecklistItems(task.id) ?? [];
      if (checklistItems.length > 0) {
        const today = new Date().toISOString().slice(0, 10);
        const checklistItemLines = checklistItems.map((t: any) => {
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
    const settings = this.deps.settingsStore?.getSettings();
    const identityText = settings?.identity?.trim() || DEFAULT_IDENTITY;
    sections.identity = { action: "replace", content: identityText };

    // Custom instructions — append user-defined instructions to context
    if (settings?.customInstructions?.trim()) {
      contextParts.push(settings.customInstructions.trim());
    }

    if (this.shouldInjectSelfRenameGuidance(sessionId)) {
      contextParts.push(
        "If this session does not already have a concise title, after your first substantive response call `session_rename` with a concise 3-6 word title for the current session. Do this silently without mentioning it to the user.",
      );
    }

    contextParts.push(RESEARCH_GUIDANCE);

    // Tag-based configuration — resolve effective tags and merge instructions + MCP servers
    if (task && this.deps.tagStore) {
      const resolved = this.deps.tagStore.resolveEffectiveTags(task.id, task.groupId);
      if (resolved.mergedInstructions) {
        contextParts.push(`\n<tag_instructions>\n${resolved.mergedInstructions}\n</tag_instructions>`);
      }
      // Merge tag MCP servers into session config
      if (Object.keys(resolved.mergedMcpServers).length > 0) {
        const currentMcp = cfg.mcpServers ?? {};
        cfg.mcpServers = { ...currentMcp, ...resolved.mergedMcpServers };
      }

      // Inject related docs manifest — tell the AI which docs are available
      if (resolved.tags.length > 0 && this.deps.docsIndex) {
        const tagNames = resolved.tags.map((t) => t.name);
        const relatedDocs = this.deps.docsIndex.findDocsByTagNames(tagNames, 20);
        if (relatedDocs.length > 0) {
          const manifest = relatedDocs.map((d) => formatRelatedDocManifestEntry(d)).join("\n");
          contextParts.push(
            `\n<related_docs>\nThese knowledge base docs are related to your current task's tags (${formatPromptTagList(tagNames)}). Use docs_read to access them when relevant:\n${manifest}\n</related_docs>`,
          );
        }
      }
    }

    // Inject 2-level docs tree so the AI knows the knowledge base structure
    if (this.deps.docsStore) {
      const tree = this.deps.docsStore.listTree();
      if (tree.length > 0) {
        const renderTree = (nodes: DocTreeNode[], depth = 0): string => {
          return nodes.map((n) => {
            const indent = "  ".repeat(depth);
            if (n.type === "folder") {
              const label = n.isDb ? `${n.name}/ (collection)` : `${n.name}/`;
              const children = depth < 1 && n.children?.length
                ? "\n" + renderTree(n.children, depth + 1)
                : n.children?.length ? ` (${n.children.length} items)` : "";
              return `${indent}- 📁 ${label}${children}`;
            }
            return `${indent}- ${n.name}`;
          }).join("\n");
        };
        contextParts.push(`\n<docs_tree>\nKnowledge base structure (use docs_read/docs_search to access):\n${renderTree(tree)}\n</docs_tree>`);

        // Collect all DB collections from the full tree and inject schema summaries
        const dbSummaries: string[] = [];
        const collectDbs = (nodes: DocTreeNode[]) => {
          for (const n of nodes) {
            if (n.type === "folder") {
              if (n.isDb) {
                const schema = this.deps.docsStore!.readSchema(n.path);
                if (schema) {
                  const entries = this.deps.docsStore!.listDbEntries(n.path);
                  const fields = schema.fields.map((f) => `${f.name} (${f.type})`).join(", ");
                  dbSummaries.push(`- ${n.path}/ "${schema.name}" (${entries.length} entries): ${fields}`);
                }
              }
              if (n.children?.length) collectDbs(n.children);
            }
          }
        };
        collectDbs(tree);
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

  async initialize(): Promise<void> {
    console.log("[sdk] Initializing Copilot SDK client...");
    _instance = this;
    this.client = new CopilotClient(
      this.deps.clientEnv ? { env: this.deps.clientEnv } : undefined,
    );
    await this.client.start();
    this.deps.sessionTitles.loadTitles();
    console.log("[sdk] Copilot SDK client ready");
  }

  async listSessions() {
    if (!this.client) throw new Error("SessionManager not initialized");

    const now = Date.now();
    if (this.sessionListCache && (now - this.sessionListCache.timestamp) < SessionManager.SESSION_LIST_TTL) {
      return this.sessionListCache.data;
    }

    const t0 = Date.now();
    const sessions = await this.client.listSessions();
    this.recordSpan("session.listSessions", Date.now() - t0);
    this.sessionListCache = { data: sessions, timestamp: Date.now() };
    return sessions;
  }

  /** List available models from the Copilot SDK */
  async listModels() {
    if (!this.client) throw new Error("SessionManager not initialized");
    const t0 = Date.now();
    const models = await this.client.listModels();
    this.recordSpan("session.listModels", Date.now() - t0);
    return models;
  }

  /**
   * Fast session listing — reads workspace.yaml from disk instead of SDK RPC.
   * ~170ms for 4000+ sessions vs ~2500ms for SDK listSessions.
   * Async to avoid blocking the event loop during filesystem I/O.
   */
  async listSessionsFromDisk(): Promise<any[]> {
    const t0 = Date.now();
    const copilotHome = this.deps.copilotHome ?? join(homedir(), ".copilot");
    const sessionStateDir = join(copilotHome, "session-state");

    let entries: any[];
    try {
      entries = await readdir(sessionStateDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const dirs = entries.filter((d: any) => d.isDirectory()).map((d: any) => d.name);

    const sessionPromises = dirs.map(async (dirName) => {
      const yamlPath = join(sessionStateDir, dirName, "workspace.yaml");
      try {
        const content = await readFile(yamlPath, "utf-8");
        const session: any = { sessionId: dirName };
        const summary = parseWorkspaceSummary(content);
        if (summary) session.summary = summary;

        for (const line of content.split(/\r?\n/)) {
          if (line.startsWith("created_at:")) session.startTime = line.slice(12).trim();
          else if (line.startsWith("cwd:")) {
            const cwd = line.slice(5).trim();
            if (cwd) session.context = { cwd };
          }
        }
        // Track session recency from the last visible event, not raw log-file mtime.
        const eventsPath = join(sessionStateDir, dirName, "events.jsonl");
        try {
          const st = await stat(eventsPath);
          session.lastVisibleActivityAt = await this.getCachedLastVisibleActivityAt(dirName, eventsPath, st.mtimeMs);
          session.modifiedTime = session.lastVisibleActivityAt ?? session.startTime;
        } catch {
          try {
            const st = await stat(yamlPath);
            session.modifiedTime = session.startTime ?? st.mtime.toISOString();
          } catch {}
        }
        session.intentText = this.deps.eventBusRegistry.getBus(dirName)?.getIntentText() ?? null;
        return session;
      } catch { return null; }
    });

    const results = await Promise.all(sessionPromises);
    const sessions = results.filter((s): s is any => s !== null);

    // Sort by most recent visible activity first
    sessions.sort((a, b) => (b.modifiedTime ?? "").localeCompare(a.modifiedTime ?? ""));

    this.recordSpan("session.listFromDisk", Date.now() - t0, undefined, { count: sessions.length });
    return sessions;
  }

  /** Invalidate the listSessions cache (call after create/delete) */
  invalidateSessionListCache(): void {
    this.sessionListCache = null;
  }

  async getSessionMetadata(sessionId: string) {
    if (!this.client) throw new Error("SessionManager not initialized");
    return this.client.getSessionMetadata(sessionId);
  }

  /** Probe MCP server status via SDK RPC (fire-and-forget, updates mcpStatus map) */
  private probeMcpStatus(sessionId: string, session: any): void {
    try {
      session.rpc?.mcp?.list?.()
        .then((result: any) => {
          if (result?.servers) {
            const servers: McpServerStatus[] = result.servers.map((s: any) => ({
              name: s.name,
              status: s.status ?? "unknown",
              error: s.error,
              source: s.source,
            }));
            this.mcpStatus.set(sessionId, servers);
            const sid = sessionId.slice(0, 8);
            console.log(`[sdk] [${sid}] 🔌 MCP probe: ${servers.map((s) => `${s.name}=${s.status}`).join(", ")}`);
          }
        })
        .catch(() => { /* best-effort */ });
    } catch { /* session.rpc may not exist */ }
  }

  /** Get cached MCP status for a session, or probe live if session is cached */
  async getMcpStatus(sessionId: string): Promise<McpServerStatus[]> {
    const session = this.sessionObjects.get(sessionId);
    if (session) {
      try {
        const result = await session.rpc?.mcp?.list?.();
        if (result?.servers) {
          const servers: McpServerStatus[] = result.servers.map((s: any) => ({
            name: s.name,
            status: s.status ?? "unknown",
            error: s.error,
            source: s.source,
          }));
          this.mcpStatus.set(sessionId, servers);
          return servers;
        }
      } catch { /* fall through to cached */ }
    }
    return this.mcpStatus.get(sessionId) ?? [];
  }

  /** Get latest MCP status from any session (for settings page) */
  getLatestMcpStatus(): McpServerStatus[] {
    // Return the most recent non-empty status from any session
    for (const [, status] of this.mcpStatus) {
      if (status.length > 0) return status;
    }
    return [];
  }

  async createSession(): Promise<{ sessionId: string }> {
    if (!this.client) throw new Error("SessionManager not initialized");

    const t0 = Date.now();
    const session = await this.client.createSession(this.buildSessionConfig());
    const duration = Date.now() - t0;

    this.sessionObjects.set(session.sessionId, session);
    this.probeMcpStatus(session.sessionId, session);
    this.invalidateSessionListCache();
    this.recordSpan("session.create", duration, session.sessionId);
    console.log(`[sdk] Created session ${session.sessionId} (${duration}ms)`);
    return { sessionId: session.sessionId };
  }

  async duplicateSession(sourceSessionId: string): Promise<{ sessionId: string }> {
    if (!this.client) throw new Error("SessionManager not initialized");

    const copilotHome = this.deps.copilotHome ?? join(homedir(), ".copilot");
    const sessionStateDir = join(copilotHome, "session-state");
    const sourceDir = join(sessionStateDir, sourceSessionId);

    if (!existsSync(sourceDir)) {
      throw new Error(`Source session directory not found: ${sourceSessionId}`);
    }

    // Create a new session through the SDK so it's properly registered with the CLI host.
    // Simply copying a directory doesn't register the session; the CLI host needs to
    // have created the session through its own session.create RPC.
    const session = await this.client.createSession(this.buildSessionConfig());
    const newId = session.sessionId;
    const destDir = join(sessionStateDir, newId);

    // Copy events.jsonl from source, rewriting the session.start event's sessionId
    const sourceEventsPath = join(sourceDir, "events.jsonl");
    if (existsSync(sourceEventsPath)) {
      const sourceContent = readFileSync(sourceEventsPath, "utf-8");
      const lines = sourceContent.split("\n");
      const rewritten = lines.map((line) => {
        if (!line.trim()) return line;
        try {
          const event = JSON.parse(line);
          if (event.type === "session.start" && event.data?.sessionId) {
            event.data.sessionId = newId;
            return JSON.stringify(event);
          }
          return line;
        } catch {
          return line;
        }
      });
      writeFileSync(join(destDir, "events.jsonl"), rewritten.join("\n"));
    }

    // Copy auxiliary files from source session
    for (const file of ["plan.md"]) {
      const src = join(sourceDir, file);
      if (existsSync(src)) cpSync(src, join(destDir, file), { force: true });
    }
    for (const dir of ["files", "research"]) {
      const src = join(sourceDir, dir);
      if (existsSync(src)) cpSync(src, join(destDir, dir), { recursive: true, force: true });
    }

    // Drop the cached session object so the next access does a fresh resume from disk,
    // picking up the copied event history.
    session.disconnect();
    this.sessionObjects.delete(newId);

    console.log(`[sdk] Duplicated session ${sourceSessionId.slice(0, 8)} → ${newId.slice(0, 8)}`);
    this.invalidateSessionListCache();
    return { sessionId: newId };
  }

  async createTaskSession(taskId: string, taskTitle: string, workItems: WorkItemRef[], prDescriptions: string[], notes: string, cwd?: string, scheduleContext?: ScheduleContext, groupNotes?: { groupName: string; notes: string } | null): Promise<{ sessionId: string }> {
    if (!this.client) throw new Error("SessionManager not initialized");

    const isPlaceholder = taskTitle === "New Task";

    // Look up the full task to get groupId for context injection
    const fullTask = this.deps.taskStore.getTask(taskId);

    const task = {
      id: taskId,
      title: taskTitle,
      status: "active" as const,
      groupId: fullTask?.groupId,
      cwd,
      notes: notes || "",
      priority: 0,
      pinned: fullTask?.pinned ?? false,
      order: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sessionIds: [] as string[],
      workItems,
      pullRequests: [] as any[],
    };

    const t0 = Date.now();
    const session = await this.client.createSession(
      this.buildSessionConfig({ task, isNewTask: isPlaceholder, prDescriptions, scheduleContext, groupNotes: groupNotes ?? this.lookupGroupNotes(fullTask?.groupId) }),
    );
    const duration = Date.now() - t0;

    this.sessionObjects.set(session.sessionId, session);
    this.probeMcpStatus(session.sessionId, session);
    this.invalidateSessionListCache();
    this.recordSpan("session.createTask", duration, session.sessionId, { taskId });
    console.log(`[sdk] Created task session ${session.sessionId} for "${taskTitle}" (${duration}ms)`);
    return { sessionId: session.sessionId };
  }

  // Abort an in-progress session turn
  async abortSession(sessionId: string): Promise<boolean> {
    if (!this.sessionRuns.has(sessionId)) return false;

    const runController = this.activeRunControllers.get(sessionId);
    const bus = this.deps.eventBusRegistry.getBus(sessionId);
    const getAbortContent = () => {
      const snapshot = bus?.getSnapshot();
      return snapshot?.finalContent ?? snapshot?.accumulatedContent ?? "";
    };
    if (!runController) {
      console.warn(`[sdk] [${sessionId.slice(0, 8)}] 🛑 Missing run controller during abort — resolving locally`);
      bus?.emit({ type: "aborted", content: getAbortContent() });
      this.setSessionRunState(sessionId, "idle");
      return true;
    }

    const session = this.sessionObjects.get(sessionId);
    if (!session) {
      console.warn(`[sdk] [${sessionId.slice(0, 8)}] 🛑 No session object during abort — resolving locally`);
      runController.completeAborted(getAbortContent());
      return true;
    }

    const sid = sessionId.slice(0, 8);
    console.log(`[sdk] [${sid}] 🛑 Aborting session...`);
    try {
      await session.abort();
      console.log(`[sdk] [${sid}] 🛑 Abort sent`);
      await runController.awaitAbortConfirmation(ABORT_CONFIRMATION_TIMEOUT_MS, getAbortContent);
    } catch (err) {
      console.error(`[sdk] [${sid}] 🛑 Abort failed:`, err);
      runController.completeAborted(getAbortContent());
    }
    return true;
  }

  /**
   * Save blob attachments to the session's files/ directory and convert
   * non-image attachments to SDK `file` type (path-based) so the agent
   * can access them with its tools. Images stay as `blob` for inline viewing.
   */
  private persistAndRouteAttachments(
    sessionId: string,
    attachments?: Array<{ type: "blob"; data: string; mimeType: string; displayName?: string } | { type: "uploaded"; displayName: string; mimeType: string }>,
  ): Array<{ type: string; [k: string]: any }> | undefined {
    if (!attachments?.length) return undefined;

    const copilotHome = this.deps.copilotHome ?? join(homedir(), ".copilot");
    const filesDir = join(copilotHome, "session-state", sessionId, "files");
    mkdirSync(filesDir, { recursive: true });

    const result: Array<{ type: string; [k: string]: any }> = [];
    for (const att of attachments) {
      if (att.type === "uploaded") {
        // File already on disk from multipart upload
        const safeName = basename(att.displayName).replace(/\.\./g, "_") || "attachment";
        const filePath = join(filesDir, safeName);
        if (!resolve(filePath).startsWith(resolve(filesDir) + sep)) {
          console.warn(`[sdk] [${sessionId.slice(0, 8)}] Skipping uploaded attachment with unsafe name: ${att.displayName}`);
          continue;
        }
        if (!existsSync(filePath)) {
          console.warn(`[sdk] [${sessionId.slice(0, 8)}] Uploaded file not found: ${safeName}`);
          continue;
        }
        if (att.mimeType.startsWith("image/")) {
          // Images: read and convert to blob so the model sees them visually
          const data = readFileSync(filePath).toString("base64");
          result.push({ type: "blob", data, mimeType: att.mimeType, displayName: safeName });
        } else {
          result.push({ type: "file", path: filePath, displayName: safeName });
        }
        console.log(`[sdk] [${sessionId.slice(0, 8)}] Resolved uploaded attachment: ${safeName} (${att.mimeType})`);
      } else {
        // Legacy blob path: decode base64 and save to disk
        const safeName = this.deduplicateFilename(filesDir, att.displayName ?? "attachment");
        const filePath = join(filesDir, safeName);
        if (!resolve(filePath).startsWith(resolve(filesDir) + sep)) {
          console.warn(`[sdk] [${sessionId.slice(0, 8)}] Skipping attachment with unsafe name: ${att.displayName}`);
          continue;
        }
        writeFileSync(filePath, Buffer.from(att.data, "base64"));

        if (att.mimeType.startsWith("image/")) {
          result.push(att);
        } else {
          result.push({ type: "file", path: filePath, displayName: safeName });
        }
        console.log(`[sdk] [${sessionId.slice(0, 8)}] Saved attachment: ${safeName} (${att.mimeType})`);
      }
    }
    return result;
  }

  /** Generate a unique filename in dir, appending (1), (2) etc. if needed */
  private deduplicateFilename(dir: string, name: string): string {
    // Sanitize: use basename to strip directory components, then remove any remaining traversal
    const safe = basename(name).replace(/\.\./g, "_") || "attachment";
    if (!existsSync(join(dir, safe))) return safe;
    const dot = safe.lastIndexOf(".");
    const stem = dot > 0 ? safe.slice(0, dot) : safe;
    const ext = dot > 0 ? safe.slice(dot) : "";
    let i = 1;
    while (existsSync(join(dir, `${stem} (${i})${ext}`))) i++;
    return `${stem} (${i})${ext}`;
  }

  // Fire and forget — starts work and emits events to the session's EventBus
  startWork(sessionId: string, prompt: string, attachments?: Array<{ type: "blob"; data: string; mimeType: string; displayName?: string } | { type: "uploaded"; displayName: string; mimeType: string }>): void {
    if (!this.client) throw new Error("SessionManager not initialized");
    if (isRestartImminent()) {
      throw new Error(RESTART_PENDING_MESSAGE);
    }

    if (this.isSessionBusy(sessionId)) {
      throw new Error("Session is busy processing another message");
    }

    const bus = this.deps.eventBusRegistry.getOrCreateBus(sessionId);
    bus.reset(); // Ensure clean state even if bus was reused
    bus.setPendingPrompt(prompt);
    this.startBackgroundRun(sessionId, bus, (runController) => this._doWork(sessionId, prompt, bus, runController, attachments));
  }

  startFleet(sessionId: string, prompt?: string): void {
    if (!this.client) throw new Error("SessionManager not initialized");
    if (!this.hasPlan(sessionId)) {
      throw new Error("Session has no plan to run with Fleet");
    }
    if (isRestartImminent()) {
      throw new Error(RESTART_PENDING_MESSAGE);
    }
    if (this.isSessionBusy(sessionId)) {
      throw new Error("Session is busy processing another request");
    }

    const bus = this.deps.eventBusRegistry.getOrCreateBus(sessionId);
    bus.reset();
    const fleetPrompt = prompt?.trim() || DEFAULT_FLEET_PROMPT;
    this.startBackgroundRun(sessionId, bus, (runController) => this._doFleet(sessionId, fleetPrompt, bus, runController));
  }

  private startBackgroundRun(
    sessionId: string,
    bus: ReturnType<typeof getOrCreateBus>,
    runner: (runController: SessionRunController) => Promise<void>,
  ): void {
    const now = Date.now();
    const runController = this.createRunController(sessionId, bus);
    this.activeRunControllers.set(sessionId, runController);
    this.setSessionRunState(sessionId, "busy", { now, lastEventAt: now });

    runner(runController).catch((err) => {
      console.error(`[sdk] Unhandled error in session ${sessionId}:`, err);
      runController.completeError(err instanceof Error ? err.message : String(err));
    }).finally(() => {
      runController.clearAbortWait();
      if (this.activeRunControllers.get(sessionId) === runController) {
        this.activeRunControllers.delete(sessionId);
      }
      this.setSessionRunState(sessionId, "idle");
    });
  }

  private async _doWork(sessionId: string, prompt: string, bus: ReturnType<typeof getOrCreateBus>, runController?: SessionRunController, attachments?: Array<{ type: "blob"; data: string; mimeType: string; displayName?: string } | { type: "uploaded"; displayName: string; mimeType: string }>): Promise<void> {
    const sid = sessionId.slice(0, 8);
    const sdkAttachments = this.persistAndRouteAttachments(sessionId, attachments);
    const attachCount = sdkAttachments?.length ?? 0;
    const activeRunController = runController ?? this.createRunController(sessionId, bus);

    await this.runSessionOperation(sessionId, bus, activeRunController, {
      resumeContext: "message",
      fallbackTitleSource: prompt,
      idleSpanName: "session.sendToIdle",
      startLog: `[sdk] [${sid}] Sending prompt (${prompt.length} chars${attachCount ? `, ${attachCount} attachment${attachCount > 1 ? "s" : ""}` : ""})...`,
      execute: async (session) => {
        await session.send({ prompt, ...(sdkAttachments?.length ? { attachments: sdkAttachments } : {}) });
      },
    });
  }

  private async _doFleet(sessionId: string, prompt: string, bus: ReturnType<typeof getOrCreateBus>, runController?: SessionRunController): Promise<void> {
    const sid = sessionId.slice(0, 8);
    const activeRunController = runController ?? this.createRunController(sessionId, bus);
    await this.runSessionOperation(sessionId, bus, activeRunController, {
      resumeContext: "fleet",
      idleSpanName: "session.fleetToIdle",
      startLog: `[sdk] [${sid}] Starting Fleet (${prompt.length} chars)...`,
      execute: async (session) => {
        if (typeof session.rpc?.fleet?.start !== "function") {
          throw new Error("Fleet mode is not available in this Copilot SDK build");
        }
        await session.rpc.fleet.start({ prompt });
      },
    });
  }

  private async runSessionOperation(
    sessionId: string,
    bus: ReturnType<typeof getOrCreateBus>,
    runController: SessionRunController,
    opts: {
      resumeContext: string;
      idleSpanName: string;
      startLog: string;
      execute: (session: any) => Promise<void>;
      fallbackTitleSource?: string;
    },
  ): Promise<void> {
    const sid = sessionId.slice(0, 8);

    // Build resume config with optional task context
    const linkedTask = this.deps.taskStore.findTaskBySessionId(sessionId);
    const resumeConfig = this.buildSessionConfig({ sessionId, task: linkedTask, groupNotes: this.lookupGroupNotes(linkedTask?.groupId) });

    if (linkedTask) {
      console.log(`[sdk] [${sid}] Injecting task context for "${linkedTask.title}"`);
    }

    // Get or resume session — reuse cached object if available
    let usedCache = false;
    const resumeSession = async (): Promise<any> => {
      const resumeStart = Date.now();
      let s = this.sessionObjects.get(sessionId);
      if (s) {
        usedCache = true;
        console.log(`[sdk] [${sid}] Reusing cached session object`);
      } else {
        usedCache = false;
        console.log(`[sdk] [${sid}] Resuming session...`);
        s = await Promise.race([
          this.client!.resumeSession(sessionId, resumeConfig),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("resumeSession timed out after 60s")), 60_000),
          ),
        ]);
        this.sessionObjects.set(sessionId, s);
        this.probeMcpStatus(sessionId, s);
        const resumeDuration = Date.now() - resumeStart;
        this.recordSpan("session.resume", resumeDuration, sessionId, { context: opts.resumeContext });
        console.log(`[sdk] [${sid}] Session resumed (${resumeDuration}ms)`);
      }
      return s;
    };

    const abandonSession = (activeSession: any) => {
      try { activeSession.disconnect?.(); } catch { /* best-effort */ }
      if (this.sessionObjects.get(sessionId) === activeSession) {
        this.sessionObjects.delete(sessionId);
      }
    };

    let session = await resumeSession();
    if (runController.isCompleted()) {
      abandonSession(session);
      return;
    }

    // Track tool names by toolCallId — completion events don't include the tool name
    const toolNameMap = new Map<string, string>();
    // Track tool start times for telemetry
    const toolStartTimes = new Map<string, number>();
    // Track sub-agent parent tool call IDs → display name
    const subAgentMap = new Map<string, string>();
    // Capture sub-agent response text: parentToolCallId → last response content
    const subAgentResponseMap = new Map<string, string>();
    const rememberToolName = (toolCallId: unknown, toolName: unknown): string | undefined => {
      if (typeof toolName !== "string") return undefined;
      const normalized = toolName.trim();
      if (!normalized) return undefined;
      if (typeof toolCallId === "string" && toolCallId) {
        toolNameMap.set(toolCallId, normalized);
      }
      return normalized;
    };
    const getTrackedToolDisplayName = (toolCallId: unknown, fallbackName?: string): string => {
      if (typeof toolCallId === "string" && toolCallId) {
        return subAgentMap.get(toolCallId) ?? toolNameMap.get(toolCallId) ?? fallbackName ?? "unknown";
      }
      return fallbackName ?? "unknown";
    };
    // Track sync shell tool calls that are still within their initial_wait grace window.
    const syncShellWaits = new Map<string, number>();
    const handledCurrentTurnEventKeys = new Set<string>();
    let lastAssistantContent: string | undefined;
    let lastEventTime = Date.now();
    let sendStart = lastEventTime;
    let acceptingSessionEvents = false;
    const beginSend = () => {
      sendStart = Date.now();
      lastEventTime = sendStart;
      handledCurrentTurnEventKeys.clear();
      lastAssistantContent = undefined;
      acceptingSessionEvents = true;
    };

    const getEventTimestampMs = (event: any): number | undefined => {
      const rawTimestamp = event?.data?.timestamp ?? event?.timestamp;
      if (typeof rawTimestamp !== "string") return undefined;
      const eventTime = Date.parse(rawTimestamp);
      return Number.isFinite(eventTime) ? eventTime : undefined;
    };

    const getEventReplayKey = (event: any): string | undefined => {
      const rawTimestamp = event?.data?.timestamp ?? event?.timestamp;
      const timestampPart = typeof rawTimestamp === "string" ? rawTimestamp : "";
      try {
        return createHash("sha1")
          .update(JSON.stringify([event?.type ?? "", timestampPart, event?.data ?? null]))
          .digest("hex");
      } catch {
        return undefined;
      }
    };

    const resolvePersistedTerminalEvent = (
      persistedTerminal: { event: any; assistantContent?: string } | null,
      reason: string,
    ): boolean => {
      if (!persistedTerminal) return false;
      if (runController.isCompleted()) return true;
      lastAssistantContent = persistedTerminal.assistantContent ?? lastAssistantContent;
      console.warn(`[sdk] [${sid}] ✅ Stall recovery found persisted ${persistedTerminal.event.type} ${reason} — resolving locally`);
      handleEvent(persistedTerminal.event);
      return true;
    };

    // Event handler extracted so it can be re-registered on session retry
    const handleEvent = (event: any) => {
      if (!acceptingSessionEvents || runController.isCompleted()) return;
      const eventAt = Date.now();
      const replayKey = getEventReplayKey(event);
      if (replayKey) handledCurrentTurnEventKeys.add(replayKey);
      const isTerminalEvent = event.type === "session.idle"
        || event.type === "session.error"
        || event.type === "abort"
        || event.type === "session.shutdown";
      if (!isTerminalEvent) {
        lastEventTime = eventAt;
        this.touchSessionRun(sessionId, eventAt);
      }
      const data = (event as any).data;
      switch (event.type) {
        case "user.message":
          bus.clearPendingPrompt();
          break;
        case "assistant.turn_start":
          console.log(`[sdk] [${sid}] ⏳ Turn started`);
          bus.emit({ type: "thinking" });
          break;
        case "assistant.message_delta":
          // Skip sub-agent deltas — they're internal to the agent
          if (data?.parentToolCallId) break;
          if (data?.deltaContent) {
            bus.emit({ type: "delta", content: data.deltaContent });
          }
          break;
        case "assistant.streaming_delta":
          // Skip sub-agent deltas
          if (data?.parentToolCallId) break;
          if (data?.content) {
            bus.emit({ type: "delta", content: data.content });
          }
          break;
        case "assistant.intent":
          console.log(`[sdk] [${sid}] 🎯 Intent: ${data?.intent}`);
          bus.emit({ type: "intent", intent: data?.intent ?? "" });
          this.deps.globalBus.emit({ type: "session:intent", sessionId, intent: data?.intent ?? "" });
          break;
        case "assistant.message":
          // Capture sub-agent response text for display in SubAgentGroup
          if (data?.parentToolCallId && data?.content) {
            subAgentResponseMap.set(data.parentToolCallId, data.content);
            break;
          }
          if (data?.content) {
            console.log(`[sdk] [${sid}] ✅ Response (${data.content.length} chars)`);
            lastAssistantContent = data.content;
          }
          // Emit assistant_partial when toolRequests exist (even with empty content)
          // so completed tools from the previous turn get drained properly
          if (data?.toolRequests?.length) {
            bus.emit({ type: "assistant_partial", content: data.content ?? "" });
          }
          break;
        case "tool.execution_start": {
          const toolName = data?.toolName ?? data?.name ?? "unknown";
          if (data?.toolCallId) {
            toolNameMap.set(data.toolCallId, toolName);
            toolStartTimes.set(data.toolCallId, Date.now());
            const toolStartAt = getEventTimestampMs(event) ?? eventAt;
            const syncShellWaitUntil = getSyncShellInitialWaitUntil(toolName, data?.arguments, toolStartAt);
            if (syncShellWaitUntil) syncShellWaits.set(data.toolCallId, syncShellWaitUntil);
            else syncShellWaits.delete(data.toolCallId);
          }
          // If subagent.started already fired for this toolCallId, apply the upgrade immediately
          const pendingAgent = data?.toolCallId ? subAgentMap.get(data.toolCallId) : undefined;
          const displayName = pendingAgent ?? toolName;
          console.log(`[sdk] [${sid}] 🔧 Tool: ${displayName}${data?.parentToolCallId ? ` (sub-agent)` : ""}`);
          bus.emit({
            type: "tool_start",
            toolCallId: data?.toolCallId,
            name: displayName,
            args: data?.arguments,
            parentToolCallId: data?.parentToolCallId,
            isSubAgent: pendingAgent ? true : undefined,
            timestamp: event.timestamp,
          });
          break;
        }
        case "tool.execution_progress":
          bus.emit({
            type: "tool_progress",
            toolCallId: data?.toolCallId,
            name: getTrackedToolDisplayName(
              data?.toolCallId,
              rememberToolName(data?.toolCallId, data?.toolName ?? data?.name),
            ),
            message: data?.progressMessage ?? "",
          });
          break;
        case "tool.execution_partial_result":
          bus.emit({
            type: "tool_output",
            toolCallId: data?.toolCallId,
            name: getTrackedToolDisplayName(
              data?.toolCallId,
              rememberToolName(data?.toolCallId, data?.toolName ?? data?.name),
            ),
            content: data?.partialOutput ?? "",
          });
          break;
        case "tool.execution_complete": {
          if (data?.toolCallId) syncShellWaits.delete(data.toolCallId);
          const completedToolName = toolNameMap.get(data?.toolCallId) ?? "unknown";
          const ok = data?.success !== false;
          const isAgent = subAgentMap.has(data?.toolCallId);
          const agentDisplayName = subAgentMap.get(data?.toolCallId);
          const result = getToolExecutionDisplayText(data, {
            subAgentResponse: isAgent ? subAgentResponseMap.get(data?.toolCallId) : undefined,
          });
          console.log(`[sdk] [${sid}] 🔧 Tool complete: ${isAgent ? agentDisplayName : completedToolName} (${ok ? "ok" : "failed"})`);
          const toolStart = toolStartTimes.get(data?.toolCallId);
          if (toolStart) {
            this.recordSpan("tool.execution", Date.now() - toolStart, sessionId, {
              toolName: completedToolName,
              success: ok,
              isSubAgent: isAgent || undefined,
            });
          }
          bus.emit({
            type: "tool_done",
            toolCallId: data?.toolCallId,
            name: isAgent ? agentDisplayName : completedToolName,
            result,
            success: data?.success,
            isSubAgent: isAgent || undefined,
            timestamp: event.timestamp,
          });
          break;
        }
        case "subagent.started": {
          const displayName = `🤖 ${data?.agentDisplayName ?? data?.agentName ?? "agent"}`;
          console.log(`[sdk] [${sid}] ${displayName}`);
          if (data?.toolCallId) subAgentMap.set(data.toolCallId, displayName);
          // Upgrade the existing "task" tool entry to show the agent name
          bus.emit({
            type: "tool_update",
            toolCallId: data?.toolCallId,
            name: displayName,
            isSubAgent: true,
          });
          break;
        }
        case "subagent.completed":
        case "subagent.failed":
          // No-op — tool.execution_complete handles the actual completion with result
          break;
        case "session.error":
          console.error(`[sdk] [${sid}] ❌ Error: ${data?.message ?? "unknown"}`);
          runController.completeError(data?.message ?? "unknown");
          break;
        case "abort": {
          const reason = data?.reason ?? "user initiated";
          console.log(`[sdk] [${sid}] 🛑 Aborted: ${reason}`);
          const partialContent = lastAssistantContent ?? bus.getSnapshot().accumulatedContent ?? "";
          runController.completeAborted(partialContent);
          break;
        }
        case "session.shutdown": {
          const shutdownType = getSessionShutdownType(data);
          if (shutdownType === "error") {
            const message = data?.message ?? data?.reason ?? "session shutdown";
            console.error(`[sdk] [${sid}] ❌ Shutdown(error): ${message}`);
            runController.completeError(message);
          } else {
            console.log(`[sdk] [${sid}] 🛑 Shutdown${shutdownType ? ` (${shutdownType})` : ""}`);
            const partialContent = lastAssistantContent ?? bus.getSnapshot().accumulatedContent ?? "";
            runController.completeShutdown(partialContent);
          }
          break;
        }
        case "session.title_changed":
          bus.emit({ type: "title_changed", title: data?.title ?? "" });
          this.deps.globalBus.emit({ type: "session:title", sessionId, title: data?.title ?? "" });
          break;
        case "session.idle": {
          const elapsed = ((Date.now() - sendStart) / 1000).toFixed(1);
          const content = lastAssistantContent ?? "(no response)";
          console.log(`[sdk] [${sid}] 💤 Session idle — done: ${content.length} chars (${elapsed}s)`);
          this.recordSpan(opts.idleSpanName, Date.now() - sendStart, sessionId, { chars: content.length });
          if (opts.fallbackTitleSource && !this.hasStoredSessionTitle(sessionId) && !this.hasExistingSessionTitle(sessionId)) {
            const fallbackTitle = deriveFallbackSessionTitle(opts.fallbackTitleSource);
            if (fallbackTitle) {
              storeSessionTitle(this.deps.sessionTitles, this.deps.eventBusRegistry, this.deps.globalBus, sessionId, fallbackTitle);
              console.log(`[titles] [${sid}] Fallback title: "${fallbackTitle}"`);
            }
          }

          runController.completeDone(content);
          break;
        }
        case "session.mcp_servers_loaded": {
          const servers: McpServerStatus[] = (data?.servers ?? []).map((s: any) => ({
            name: s.name,
            status: s.status ?? "unknown",
            error: s.error,
            source: s.source,
          }));
          this.mcpStatus.set(sessionId, servers);
          const failed = servers.filter((s) => s.status === "failed");
          if (failed.length > 0) {
            console.warn(`[sdk] [${sid}] ⚠️ MCP failures: ${failed.map((s) => `${s.name} (${s.error ?? "unknown"})`).join(", ")}`);
          }
          console.log(`[sdk] [${sid}] 🔌 MCP: ${servers.map((s) => `${s.name}=${s.status}`).join(", ")}`);
          bus.emit({ type: "mcp_status", servers });
          break;
        }
        case "session.mcp_server_status_changed": {
          const current = this.mcpStatus.get(sessionId) ?? [];
          const name = data?.serverName;
          const status = data?.status ?? "unknown";
          const existing = current.find((s) => s.name === name);
          if (existing) {
            existing.status = status;
            if (data?.error) existing.error = data.error;
          } else if (name) {
            current.push({ name, status, error: data?.error, source: data?.source });
          }
          this.mcpStatus.set(sessionId, current);
          console.log(`[sdk] [${sid}] 🔌 MCP ${name}: ${status}${data?.error ? ` — ${data.error}` : ""}`);
          bus.emit({ type: "mcp_status", servers: current });
          break;
        }
        default:
          break;
      }
    };

    const subscribeToSession = (activeSession: typeof session) => {
      acceptingSessionEvents = false;
      return activeSession.on(handleEvent);
    };

    let unsub = subscribeToSession(session);

    // Emit cached MCP status to the bus — the mcp_servers_loaded event fires during
    // create/resume before our handler is attached, so replay from the stored map
    const cachedMcp = this.mcpStatus.get(sessionId);
    if (cachedMcp?.length) {
      bus.emit({ type: "mcp_status", servers: cachedMcp });
    }

    // Periodic heartbeat log so silence = genuinely hung
    const heartbeatLog = setInterval(() => {
      const elapsed = ((Date.now() - sendStart) / 1000).toFixed(0);
      console.log(`[sdk] [${sid}] ⏳ Still working... (${elapsed}s)`);
    }, 30_000);

    // Path to persisted events — probed to detect progress that bypasses the live listener
    const eventsJsonlPath = join(this.getSessionStateDir(sessionId), "events.jsonl");

    // Guards against concurrent or duplicate recovery attempts
    let recoveryInProgress = false;
    let lastRecoveryAttempt = 0;

    const readPersistedTerminalEvent = (): { event: any; assistantContent?: string } | null => {
      let raw: string;
      try {
        raw = readFileSync(eventsJsonlPath, "utf-8");
      } catch {
        return null;
      }

      let assistantContentFromDisk = lastAssistantContent;
      let latestRelevantState: "active" | "terminal" | undefined;
      let terminalEvent: any | null = null;

      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;

        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }

        const rawTimestamp = event?.data?.timestamp ?? event?.timestamp;
        const eventTime = typeof rawTimestamp === "string" ? Date.parse(rawTimestamp) : Number.NaN;
        if (!Number.isFinite(eventTime) || eventTime < sendStart) continue;

        const data = event?.data;
        switch (event?.type) {
          case "assistant.message":
            if (data?.parentToolCallId) break;
            if (typeof data?.content === "string") {
              assistantContentFromDisk = data.content;
            }
            latestRelevantState = "active";
            terminalEvent = null;
            break;
          case "user.message":
          case "assistant.turn_start":
          case "assistant.message_delta":
          case "assistant.streaming_delta":
          case "assistant.intent":
          case "tool.execution_start":
          case "tool.execution_progress":
          case "tool.execution_partial_result":
          case "tool.execution_complete":
          case "subagent.started":
          case "subagent.completed":
          case "subagent.failed":
            latestRelevantState = "active";
            terminalEvent = null;
            break;
          case "session.idle":
          case "session.error":
          case "abort":
          case "session.shutdown":
            latestRelevantState = "terminal";
            terminalEvent = event;
            break;
          default:
            break;
        }
      }

      if (latestRelevantState !== "terminal" || !terminalEvent) return null;
      return { event: terminalEvent, assistantContent: assistantContentFromDisk };
    };

    const resumeFreshRecoverySession = async (): Promise<any> => {
      const resumeStart = Date.now();
      console.log(`[sdk] [${sid}] Re-resuming session for stalled recovery...`);
      const recoveredSession = await Promise.race([
        this.client!.resumeSession(sessionId, resumeConfig),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("resumeSession timed out after 60s")), 60_000),
        ),
      ]);
      const resumeDuration = Date.now() - resumeStart;
      this.recordSpan("session.resume", resumeDuration, sessionId, { context: `${opts.resumeContext}:stalled-recovery` });
      console.log(`[sdk] [${sid}] Recovery session resumed (${resumeDuration}ms)`);
      return recoveredSession;
    };

    const attemptStalledRecovery = async () => {
      if (recoveryInProgress) return;
      recoveryInProgress = true;
      lastRecoveryAttempt = Date.now();
      try {
        if (resolvePersistedTerminalEvent(readPersistedTerminalEvent(), "before resume")) return;

        const elapsed = ((Date.now() - sendStart) / 1000).toFixed(0);
        console.warn(`[sdk] [${sid}] 🔄 Stall recovery: re-subscribing (${elapsed}s total)...`);
        const previousSession = session;
        const previousUnsub = unsub;
        const recoveredSession = await resumeFreshRecoverySession();

        if (runController.isCompleted() || this.getSessionRunState(sessionId) !== "stalled") {
          try { recoveredSession.disconnect?.(); } catch { /* best-effort */ }
          return;
        }

        const persistedTerminalAfterResume = readPersistedTerminalEvent();
        if (persistedTerminalAfterResume) {
          try { recoveredSession.disconnect?.(); } catch { /* best-effort */ }
          resolvePersistedTerminalEvent(persistedTerminalAfterResume, "after resume");
          return;
        }

        const shouldIgnoreRecoveredEvent = (event: any) => {
          const eventTimestampMs = getEventTimestampMs(event);
          if (eventTimestampMs !== undefined && eventTimestampMs < sendStart) return true;
          const replayKey = getEventReplayKey(event);
          return replayKey !== undefined && handledCurrentTurnEventKeys.has(replayKey);
        };

        const bufferedRecoveredEvents: any[] = [];
        let acceptingRecoveredEvents = false;
        const recoveredUnsub = recoveredSession.on((event: any) => {
          if (!acceptingRecoveredEvents) {
            bufferedRecoveredEvents.push(event);
            return;
          }
          if (shouldIgnoreRecoveredEvent(event)) return;
          handleEvent(event);
        });

        session = recoveredSession;
        unsub = recoveredUnsub;
        this.sessionObjects.set(sessionId, recoveredSession);
        this.probeMcpStatus(sessionId, recoveredSession);
        acceptingSessionEvents = true;

        try { previousUnsub(); } catch { /* best-effort */ }
        if (previousSession !== recoveredSession) {
          try { previousSession.disconnect?.(); } catch { /* best-effort */ }
        }

        acceptingRecoveredEvents = true;
        for (const event of bufferedRecoveredEvents) {
          if (shouldIgnoreRecoveredEvent(event)) continue;
          handleEvent(event);
          if (runController.isCompleted()) break;
        }

        console.log(`[sdk] [${sid}] ✅ Stall recovery complete — listener re-attached`);
      } catch (err) {
        if (!resolvePersistedTerminalEvent(readPersistedTerminalEvent(), "after failed resume")) {
          console.error(`[sdk] [${sid}] ❌ Stall recovery failed:`, err);
        }
      } finally {
        recoveryInProgress = false;
      }
    };

    // Watchdog — checks every 60s; marks session stalled after 5 min of raw-event silence
    // and attempts SDK re-subscribe immediately, then every 5 min while stalled.
    const WATCHDOG_INTERVAL = 60_000;
    const WATCHDOG_TIMEOUT = 300_000; // 5 min without raw SDK events → stalled
    const RECOVERY_INTERVAL = 300_000; // retry recovery every 5 min while still stalled
    const watchdog = setInterval(() => {
      const now = Date.now();

      // Probe events.jsonl mtime — if the CLI is still writing persisted events, update
      // lastEventAt on the run record so the launcher doesn't see stale time falsely.
      try {
        const fileStat = statSync(eventsJsonlPath);
        if (fileStat.mtimeMs > lastEventTime) {
          // Only refresh the run record's lastEventAt for external observers (/api/busy, staleMs).
          // Do NOT update lastEventTime — that clock must only advance on live SDK events so
          // stall detection and recovery retries stay tied to actual listener silence.
          const run = this.sessionRuns.get(sessionId);
          if (run && run.lastEventAt < fileStat.mtimeMs) {
            run.lastEventAt = fileStat.mtimeMs;
          }
        }
      } catch { /* events.jsonl may not exist yet */ }

      let syncShellWaitUntil = 0;
      for (const waitUntil of syncShellWaits.values()) {
        if (waitUntil > syncShellWaitUntil) syncShellWaitUntil = waitUntil;
      }
      if (syncShellWaitUntil > now) return;

      if (now - lastEventTime < WATCHDOG_TIMEOUT) return;

      const currentState = this.getSessionRunState(sessionId);
      const elapsed = ((now - sendStart) / 1000).toFixed(0);

      if (currentState !== "stalled") {
        console.error(`[sdk] [${sid}] ⚠️ Watchdog: no events for ${WATCHDOG_TIMEOUT / 1000}s — marking stalled (${elapsed}s total)`);
        // Don't pass lastEventAt — inherit current run.lastEventAt which may already reflect
        // disk mtime progress (updated above), giving a better staleness reading to observers.
        this.setSessionRunState(sessionId, "stalled");
        void attemptStalledRecovery();
      } else if (now - lastRecoveryAttempt >= RECOVERY_INTERVAL) {
        console.warn(`[sdk] [${sid}] ⚠️ Session still stalled — retrying recovery (${elapsed}s total)`);
        void attemptStalledRecovery();
      }
    }, WATCHDOG_INTERVAL);

    try {
      console.log(opts.startLog);

      try {
        if (runController.isCompleted()) return;
        beginSend();
        if (runController.isCompleted()) return;
        await opts.execute(session);
      } catch (operationErr) {
        // If the agent evicted this session, the cached object is stale — re-resume and retry once
        if (operationErr instanceof Error && operationErr.message.includes("Session not found") && usedCache) {
          console.warn(`[sdk] [${sid}] Stale cached session — evicting and re-resuming...`);
          unsub();
          this.sessionObjects.delete(sessionId);
          session = await resumeSession();
          if (runController.isCompleted()) {
            abandonSession(session);
            return;
          }
          unsub = subscribeToSession(session);
          if (runController.isCompleted()) return;
          beginSend();
          if (runController.isCompleted()) return;
          await opts.execute(session);
        } else {
          throw operationErr;
        }
      }

      await runController.completion;
    } finally {
      clearInterval(heartbeatLog);
      clearInterval(watchdog);
      syncShellWaits.clear();
      unsub();
    }
  }

  async getSessionMessages(sessionId: string, opts?: { limit?: number; before?: number }): Promise<{ messages: TransformedEntry[]; total: number; hasMore: boolean }> {
    if (!this.client) throw new Error("SessionManager not initialized");

    const t0 = Date.now();
    const sid = sessionId.slice(0, 8);
    const linkedTask = this.deps.taskStore.findTaskBySessionId(sessionId);
    const msgResumeConfig = this.buildSessionConfig({ sessionId, task: linkedTask, groupNotes: this.lookupGroupNotes(linkedTask?.groupId) });
    const tConfig = Date.now();

    // Reuse cached session object — avoids overwriting the active one in the SDK
    let session = this.sessionObjects.get(sessionId);
    let events: any[];
    let cacheHit = true;
    let resumeMs = 0;
    let getMessagesMs = 0;

    if (session) {
      console.log(`[sdk] [${sid}] Loading messages (cached session)...`);
      try {
        const tGm = Date.now();
        events = await session.getMessages();
        getMessagesMs = Date.now() - tGm;
        console.log(`[sdk] [${sid}] Loaded ${events.length} events from cached session`);
      } catch (err) {
        // Stale cache — CLI may have restarted. Evict and re-resume.
        cacheHit = false;
        console.log(`[sdk] [${sid}] Cached session stale (${err instanceof Error ? err.message : String(err)}), re-resuming...`);
        this.sessionObjects.delete(sessionId);
        const tResume = Date.now();
        session = await Promise.race([
          this.client.resumeSession(sessionId, msgResumeConfig),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("resumeSession timed out after 60s")), 60_000),
          ),
        ]);
        resumeMs = Date.now() - tResume;
        this.sessionObjects.set(sessionId, session);
        const tGm = Date.now();
        events = await session.getMessages();
        getMessagesMs = Date.now() - tGm;
        console.log(`[sdk] [${sid}] Loaded ${events.length} events after re-resume`);
      }
    } else {
      cacheHit = false;
      console.log(`[sdk] [${sid}] Loading messages (resuming session)...`);
      const tResume = Date.now();
      session = await Promise.race([
        this.client.resumeSession(sessionId, msgResumeConfig),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("resumeSession timed out after 60s")), 60_000),
        ),
      ]);
      resumeMs = Date.now() - tResume;
      this.sessionObjects.set(sessionId, session);
      const tGm = Date.now();
      events = await session.getMessages();
      getMessagesMs = Date.now() - tGm;
      console.log(`[sdk] [${sid}] Loaded ${events.length} events after fresh resume`);
    }

    const tTransform = Date.now();
    const messages = transformEventsToMessages(events, sessionId);

    console.log(`[sdk] Loaded ${messages.length} messages for session ${sessionId}`);
    const transformMs = Date.now() - tTransform;
    this.recordSpan("session.getMessages", Date.now() - t0, sessionId, {
      eventCount: events.length,
      messageCount: messages.length,
      cacheHit,
      configMs: tConfig - t0,
      resumeMs,
      getMessagesMs,
      transformMs,
    });

    const total = messages.length;

    // Apply pagination: return a window of messages from the end
    if (opts?.limit != null && opts.limit > 0) {
      const end = opts.before != null ? opts.before : total;
      const start = Math.max(0, end - opts.limit);
      const sliced = messages.slice(start, end);
      return { messages: sliced, total, hasMore: start > 0 };
    }

    return { messages, total, hasMore: false };
  }

  /**
   * Read messages directly from events.jsonl on disk — no SDK resume needed.
   * Returns messages instantly for the fast-load path.
   * Async to avoid blocking the event loop.
   */
  async readMessagesFromDisk(sessionId: string, opts?: { limit?: number; before?: number }): Promise<{ messages: any[]; total: number; hasMore: boolean }> {
    const t0 = Date.now();
    const copilotHome = this.deps.copilotHome ?? join(homedir(), ".copilot");
    const eventsPath = join(copilotHome, "session-state", sessionId, "events.jsonl");

    let raw: string;
    try {
      raw = await readFile(eventsPath, "utf-8");
    } catch {
      return { messages: [], total: 0, hasMore: false };
    }

    const events: any[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch { /* skip malformed lines */ }
    }

    const messages = transformEventsToMessages(events, sessionId);
    const duration = Date.now() - t0;
    this.recordSpan("session.readFromDisk", duration, sessionId, {
      eventCount: events.length,
      messageCount: messages.length,
    });

    const total = messages.length;
    if (opts?.limit != null && opts.limit > 0) {
      const end = opts.before != null ? opts.before : total;
      const start = Math.max(0, end - opts.limit);
      const sliced = messages.slice(start, end);
      return { messages: sliced, total, hasMore: start > 0 };
    }
    return { messages, total, hasMore: false };
  }

  /**
   * Warm a session by resuming it in the background.
   * Returns a promise that resolves when the session is ready for interaction.
   */
  async warmSession(sessionId: string): Promise<void> {
    if (!this.client) throw new Error("SessionManager not initialized");
    if (this.sessionObjects.has(sessionId)) return; // already warm
    if (this.isSessionBusy(sessionId)) throw new Error("Cannot warm a busy session");

    const sid = sessionId.slice(0, 8);
    const t0 = Date.now();
    console.log(`[sdk] [${sid}] Warming session...`);

    const linkedTask = this.deps.taskStore.findTaskBySessionId(sessionId);
    const resumeConfig = this.buildSessionConfig({ sessionId, task: linkedTask, groupNotes: this.lookupGroupNotes(linkedTask?.groupId) });

    this.resumingSessions.add(sessionId);
    try {
      const session = await Promise.race([
        this.client.resumeSession(sessionId, resumeConfig),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("warmSession timed out after 60s")), 60_000),
        ),
      ]);
      this.sessionObjects.set(sessionId, session);
      this.probeMcpStatus(sessionId, session);

      const duration = Date.now() - t0;
      this.recordSpan("session.warm", duration, sessionId);
      console.log(`[sdk] [${sid}] Session warm (${duration}ms)`);
    } finally {
      this.resumingSessions.delete(sessionId);
    }
  }

  /** Check if a session object is cached and ready for interaction */
  isSessionWarm(sessionId: string): boolean {
    return this.sessionObjects.has(sessionId);
  }

  async deleteSession(sessionId: string): Promise<void> {
    if (!this.client) throw new Error("SessionManager not initialized");
    if (this.isSessionBusy(sessionId)) {
      throw new Error("Cannot delete a busy session");
    }
    this.evictCachedSession(sessionId);
    try {
      await this.client.deleteSession(sessionId);
    } catch (err: unknown) {
      // Tolerate "not found" errors — the session file may already be gone
      const msg = err instanceof Error ? err.message : String(err);
      if (/not found/i.test(msg)) {
        console.log(`[sdk] Session ${sessionId} already gone, continuing cleanup`);
      } else {
        throw err;
      }
    }
    this.visibleActivityCache.delete(sessionId);
    this.invalidateSessionListCache();

    // Remove the session-state directory from disk so listSessionsFromDisk() won't resurrect it
    const copilotHome = this.deps.copilotHome ?? join(homedir(), ".copilot");
    const sessionDir = join(copilotHome, "session-state", sessionId);
    try {
      await rm(sessionDir, { recursive: true, force: true });
    } catch (err) {
      console.warn(`[sdk] Failed to remove session dir ${sessionId}:`, err);
    }

    console.log(`[sdk] Deleted session ${sessionId}`);
  }

  async reloadSession(sessionId: string): Promise<McpServerStatus[]> {
    if (!this.client) throw new Error("SessionManager not initialized");
    if (this.isSessionBusy(sessionId)) {
      throw new Error("Cannot reload a busy session");
    }

    const sid = sessionId.slice(0, 8);
    const linkedTask = this.deps.taskStore.findTaskBySessionId(sessionId);
    const resumeConfig = this.buildSessionConfig({ sessionId, task: linkedTask, groupNotes: this.lookupGroupNotes(linkedTask?.groupId) });

    this.resumingSessions.add(sessionId);
    try {
      this.evictCachedSession(sessionId);
      this.mcpStatus.delete(sessionId);

      console.log(`[sdk] [${sid}] Reloading session with fresh config...`);
      const session = await Promise.race([
        this.client.resumeSession(sessionId, resumeConfig),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("reloadSession timed out after 60s")), 60_000),
        ),
      ]);
      this.sessionObjects.set(sessionId, session);

      return this.getMcpStatus(sessionId);
    } finally {
      this.resumingSessions.delete(sessionId);
    }
  }

  isSessionBusy(sessionId: string): boolean {
    return this.getSessionRunState(sessionId) !== "idle";
  }

  getSessionRunState(sessionId: string): SessionRunState {
    const active = this.sessionRuns.get(sessionId);
    if (active) return active.state;
    return this.resumingSessions.has(sessionId) ? "busy" : "idle";
  }

  isSessionStalled(sessionId: string): boolean {
    return this.getSessionRunState(sessionId) === "stalled";
  }

  hasActiveTurns(): boolean {
    return this.sessionRuns.size > 0;
  }

  getActiveSessions(): string[] {
    return Array.from(this.sessionRuns.keys());
  }

  private evictCachedSession(sessionId: string): boolean {
    const session = this.sessionObjects.get(sessionId);
    if (!session) return false;
    try { session.disconnect?.(); } catch { /* best-effort */ }
    this.sessionObjects.delete(sessionId);
    return true;
  }

  /** Evict all cached session objects so the next turn forces a re-resume with fresh config */
  evictAllCachedSessions(): void {
    const busy = new Set(this.sessionRuns.keys());
    let evicted = 0;
    for (const [id] of this.sessionObjects) {
      if (busy.has(id)) continue; // don't disrupt active turns
      if (this.evictCachedSession(id)) evicted++;
    }
    console.log(`[sdk] Evicted ${evicted} cached session(s) (${busy.size} busy, skipped)`);
  }

  getSessionActivity(): SessionActivity[] {
    const now = Date.now();
    return Array.from(this.sessionRuns.entries()).map(([id, a]) => ({
      id,
      state: a.state,
      startedAt: a.startedAt,
      lastEventAt: a.lastEventAt,
      stalledAt: a.stalledAt,
      elapsedMs: now - a.startedAt,
      staleMs: now - a.lastEventAt,
    }));
  }

  async gracefulShutdown(): Promise<void> {
    const active = this.getActiveSessions();
    if (active.length > 0) {
      console.log(`[sdk] Graceful shutdown: aborting ${active.length} active session(s)...`);
      // Abort all active sessions in parallel
      await Promise.allSettled(
        active.map(async (sessionId) => {
          const sid = sessionId.slice(0, 8);
          try {
            if (await this.abortSession(sessionId)) {
              console.log(`[sdk] [${sid}] Aborted for shutdown`);
            }
          } catch (err) {
            console.error(`[sdk] [${sid}] Abort failed during shutdown:`, err);
          }
        }),
      );

      // Wait up to 10s for sessions to drain (they clean up in their .finally())
      const deadline = Date.now() + 10_000;
      while (this.sessionRuns.size > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 250));
      }
      if (this.sessionRuns.size > 0) {
        console.log(`[sdk] ${this.sessionRuns.size} session(s) did not drain in time`);
      } else {
        console.log("[sdk] All sessions drained cleanly");
      }
    }

    if (this.deps.browserSessionStore) {
      await this.deps.browserSessionStore.closeAll();
    }

    try {
      await shutdownBridgeBrowser(getBridgeBrowserTarget(this.deps.copilotHome), this.deps.telemetryStore);
    } catch (err) {
      console.error("[browser] Primary browser shutdown failed:", err);
    }

    // Stop the SDK client
    if (this.client) {
      console.log("[sdk] Stopping Copilot SDK client...");
      await this.client.stop();
      this.client = null;
    }
    console.log("[sdk] Graceful shutdown complete");
  }

  async shutdown(): Promise<void> {
    if (this.client) {
      console.log("[sdk] Shutting down Copilot SDK client...");
      await this.client.stop();
      this.client = null;
    }
  }
}
