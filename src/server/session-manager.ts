// Copilot SDK session manager
// Universal tools — taskId is a parameter, same tools for every session

import { CopilotClient, approveAll, defineTool } from "@github/copilot-sdk";
import type { SectionOverride, SectionOverrideAction } from "@github/copilot-sdk";
import { writeFileSync, readFileSync, mkdirSync, existsSync, cpSync, readdirSync, statSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { execSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { transformEventsToMessages, type TransformedEntry } from "./event-transform.js";
import { config } from "./config.js";
import { createTaskStore } from "./task-store.js";
import type { WorkItemRef } from "./task-store.js";
import type { Task } from "./task-store.js";
import type { TaskGroupStore } from "./task-group-store.js";
import { createTaskGroupStore } from "./task-group-store.js";
import { createScheduleStore } from "./schedule-store.js";
import * as schedulerModule from "./scheduler.js";
import { getOrCreateBus, getBus } from "./event-bus.js";
import { createSessionTitlesStore } from "./session-titles.js";
import * as globalBus from "./global-bus.js";
import { STAGING_TOOLS } from "./staging-tools.js";
import { createWebSearchTools } from "./web-search-tools.js";
import { createBrowserFetchTools } from "./browser-fetch-tools.js";
import type { AppContext } from "./app-context.js";
import type { GlobalBus } from "./global-bus.js";
import type { EventBusRegistry } from "./event-bus.js";
import type { SessionTitlesStore } from "./session-titles.js";
import type { TaskStore } from "./task-store.js";
import type { TodoStore } from "./todo-store.js";

import type { SettingsStore } from "./settings-store.js";
import type { TagStore } from "./tag-store.js";
import type { TelemetryStore } from "./telemetry-store.js";
import type { DocsIndex } from "./docs-index.js";
import type { DocsStore, DocTreeNode } from "./docs-store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const SIGNAL_FILE = join(REPO_ROOT, "data", "restart.signal");
const PRE_DEPLOY_SHA_FILE = join(REPO_ROOT, "data", "pre-deploy-sha");

function run(cmd: string): { ok: boolean; output: string } {
  try {
    const output = execSync(cmd, { cwd: REPO_ROOT, encoding: "utf-8", timeout: 120_000 });
    return { ok: true, output };
  } catch (err: any) {
    return { ok: false, output: err.stderr || err.stdout || String(err) };
  }
}

const DEFAULT_IDENTITY = `You are a helpful AI assistant powered by Copilot Bridge. You are an interactive CLI tool that helps users with software engineering tasks, answers questions, and assists with a wide range of topics. You are versatile and conversational — not limited to coding.`;

const STAGING_INSTRUCTIONS = `
<staging_workflow>
When modifying code in this repository (the Copilot Bridge):
1. Call staging_init to create a fresh, isolated worktree
2. Make ALL code edits in the returned staging directory — never in the production directory
3. Run quality checks in the staging directory:
   - npx tsc --noEmit (type checking)
   - npx vite build (client build)
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

Escalation path: web_fetch (fast, simple) → browser_fetch (real browser, single page) → browser skill (multi-step interactive flows)
</browser_escalation>
`.trim();

// ── Session config builder ───────────────────────────────────────

interface ScheduleContext {
  name: string;
  type: "cron" | "once";
  runCount: number;
  lastRunAt?: string;
}

interface SessionConfigOptions {
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

  // The calling session is still in activeSessions; subtract 1 since it will
  // finish momentarily and should not count as "blocking" the restart.
  const waitingCount = _instance ? Math.max(0, _instance.getActiveSessions().length - 1) : 0;
  globalBus.emit({ type: "server:restart-pending", waitingSessions: waitingCount });
  return waitingCount;
}

// Universal tools — same instance for every session
export function createBridgeTools(ctx: AppContext) {
  return [
  defineTool("task_link_work_item", {
    description: "Link a work item to a task by its ID",
    parameters: { type: "object", properties: { taskId: { type: "string", description: "The task ID" }, workItemId: { type: "number", description: "The work item ID" }, provider: { type: "string", enum: ["ado", "github"], description: "The provider (ado or github). Defaults to ado." } }, required: ["taskId", "workItemId"] },
    handler: async (args: any) => {
      ctx.taskStore.linkWorkItem(args.taskId, args.workItemId, args.provider ?? "ado");
      return { success: true, message: `Work item #${args.workItemId} (${args.provider ?? "ado"}) linked to task` };
    },
  }),
  defineTool("task_unlink_work_item", {
    description: "Remove a work item from a task",
    parameters: { type: "object", properties: { taskId: { type: "string", description: "The task ID" }, workItemId: { type: "number", description: "The work item ID" }, provider: { type: "string", enum: ["ado", "github"], description: "The provider (ado or github)" } }, required: ["taskId", "workItemId"] },
    handler: async (args: any) => {
      ctx.taskStore.unlinkWorkItem(args.taskId, args.workItemId, args.provider);
      return { success: true, message: `Work item #${args.workItemId} unlinked from task` };
    },
  }),
  defineTool("task_link_pr", {
    description: "Link a pull request to a task",
    parameters: { type: "object", properties: { taskId: { type: "string", description: "The task ID" }, repoName: { type: "string", description: "Repository name" }, prId: { type: "number", description: "PR number" }, provider: { type: "string", enum: ["ado", "github"], description: "The provider (ado or github). Defaults to ado." } }, required: ["taskId", "repoName", "prId"] },
    handler: async (args: any) => {
      ctx.taskStore.linkPR(args.taskId, { repoId: args.repoName, repoName: args.repoName, prId: args.prId, provider: args.provider ?? "ado" });
      return { success: true, message: `PR #${args.prId} from ${args.repoName} linked to task` };
    },
  }),
  defineTool("task_unlink_pr", {
    description: "Remove a pull request from a task",
    parameters: { type: "object", properties: { taskId: { type: "string", description: "The task ID" }, repoName: { type: "string", description: "Repository name" }, prId: { type: "number", description: "PR number" }, provider: { type: "string", enum: ["ado", "github"], description: "The provider (ado or github)" } }, required: ["taskId", "repoName", "prId"] },
    handler: async (args: any) => {
      ctx.taskStore.unlinkPR(args.taskId, args.repoName, args.prId, args.provider);
      return { success: true, message: `PR #${args.prId} from ${args.repoName} unlinked from task` };
    },
  }),
  defineTool("task_update", {
    description: "Update a task's title, notes, working directory, group, and/or tags. Only provided fields are changed.",
    parameters: { type: "object", properties: { taskId: { type: "string", description: "The task ID" }, title: { type: "string", description: "New title" }, notes: { type: "string", description: "New notes content (markdown). Overwrites existing notes." }, cwd: { type: "string", description: "Working directory path for the task" }, groupId: { type: "string", description: "Task group ID to assign to (use empty string to ungroup)" }, tags: { type: "array", items: { type: "string" }, description: "Tag names to set on this task. Creates tags if they don't exist." } }, required: ["taskId"] },
    handler: async (args: any) => {
      const updates: Record<string, string> = {};
      if (args.title !== undefined) updates.title = args.title;
      if (args.notes !== undefined) updates.notes = args.notes;
      if (args.cwd !== undefined) updates.cwd = args.cwd;
      if (args.groupId !== undefined) updates.groupId = args.groupId || "";
      const hasTags = Array.isArray(args.tags);
      if (Object.keys(updates).length === 0 && !hasTags) return { error: "No fields to update. Provide at least one of: title, notes, cwd, groupId, tags" };
      if (Object.keys(updates).length > 0) {
        ctx.taskStore.updateTask(args.taskId, updates);
      }
      if (hasTags) {
        const tagIds = args.tags.map((name: string) => {
          const existing = ctx.tagStore?.getTagByName(name);
          if (existing) return existing.id;
          return ctx.tagStore?.createTag(name).id;
        });
        ctx.tagStore?.setEntityTags("task", args.taskId, tagIds);
      }
      const fields = [...Object.keys(updates), ...(hasTags ? ["tags"] : [])].join(", ");
      return { success: true, message: `Task updated (${fields})` };
    },
  }),
  defineTool("task_get_info", {
    description: "Get task details including title, status, linked work items, PRs, and notes",
    parameters: { type: "object", properties: { taskId: { type: "string", description: "The task ID" } }, required: ["taskId"] },
    handler: async (args: any) => {
      const task = ctx.taskStore.getTask(args.taskId);
      if (!task) return { error: "Task not found" };
      const todos = ctx.todoStore.listTodos(args.taskId);
      return { ...task, todos: todos.map((t) => ({ id: t.id, text: t.text, done: t.done, deadline: t.deadline ?? null })) };
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
      const task = ctx.taskStore.createTask(args.title, args.groupId);
      if (Array.isArray(args.tags) && args.tags.length > 0) {
        const tagIds = args.tags.map((name: string) => {
          const existing = ctx.tagStore?.getTagByName(name);
          if (existing) return existing.id;
          return ctx.tagStore?.createTag(name).id;
        });
        ctx.tagStore?.setEntityTags("task", task.id, tagIds);
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
      const updates: any = {};
      if (args.name !== undefined) updates.name = args.name;
      if (args.color !== undefined) updates.color = args.color;
      if (args.notes !== undefined) updates.notes = args.notes;
      const group = ctx.taskGroupStore.updateGroup(args.groupId, updates);
      return { success: true, message: `Group "${group.name}" updated`, groupId: group.id };
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
      if (!ctx.tagStore) return { error: "Tags not available" };
      const tag = ctx.tagStore.createTag(args.name, args.color);
      return { success: true, message: `Tag "${tag.name}" created`, tagId: tag.id };
    },
  }),
  defineTool("tag_update", {
    description: "Update a tag's name, color, or instructions",
    parameters: { type: "object", properties: { tagId: { type: "string", description: "The tag ID" }, name: { type: "string", description: "New name" }, color: { type: "string", description: "New color" }, instructions: { type: "string", description: "Custom instructions for sessions with this tag" } }, required: ["tagId"] },
    handler: async (args: any) => {
      const updates: Record<string, any> = {};
      if (args.name !== undefined) updates.name = args.name;
      if (args.color !== undefined) updates.color = args.color;
      if (args.instructions !== undefined) updates.instructions = args.instructions;
      if (Object.keys(updates).length === 0) return { error: "Provide at least one of: name, color, instructions" };
      ctx.tagStore?.updateTag(args.tagId, updates);
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
  // ── Todo tools ────────────────────────────────────────────────
  defineTool("todo_add", {
    description: "Add a to-do item to a task's checklist, or create a global to-do if no taskId is provided",
    parameters: { type: "object", properties: { taskId: { type: "string", description: "The task ID. Omit to create a global (unparented) to-do item." }, text: { type: "string", description: "The to-do text" }, deadline: { type: "string", description: "Optional deadline date in YYYY-MM-DD format" } }, required: ["text"] },
    handler: async (args: any) => {
      const todo = ctx.todoStore.createTodo(args.taskId ?? null, args.text, args.deadline);
      return { success: true, message: `Todo added: "${todo.text}"${todo.deadline ? ` (due ${todo.deadline})` : ""}`, todoId: todo.id };
    },
  }),
  defineTool("todo_list", {
    description: "List all to-do items for a task",
    parameters: { type: "object", properties: { taskId: { type: "string", description: "The task ID" } }, required: ["taskId"] },
    handler: async (args: any) => {
      const todos = ctx.todoStore.listTodos(args.taskId);
      const today = new Date().toISOString().slice(0, 10);
      return {
        todos: todos.map((t) => ({ id: t.id, text: t.text, done: t.done, deadline: t.deadline ?? null, isOverdue: !t.done && !!t.deadline && t.deadline < today })),
        total: todos.length,
        done: todos.filter((t) => t.done).length,
      };
    },
  }),
  defineTool("todo_update", {
    description: "Update a to-do item's text, done status, or deadline",
    parameters: { type: "object", properties: { todoId: { type: "string", description: "The to-do item ID" }, text: { type: "string", description: "New text" }, done: { type: "boolean", description: "Mark done (true) or not done (false)" }, deadline: { type: "string", description: "Deadline date in YYYY-MM-DD format, or null to clear" } }, required: ["todoId"] },
    handler: async (args: any) => {
      const updates: Record<string, any> = {};
      if (args.text !== undefined) updates.text = args.text;
      if (args.done !== undefined) updates.done = args.done;
      if (args.deadline !== undefined) updates.deadline = args.deadline || undefined;
      if (Object.keys(updates).length === 0) return { error: "Provide at least one of: text, done, deadline" };
      const todo = ctx.todoStore.updateTodo(args.todoId, updates);
      return { success: true, message: `Todo ${args.done ? "completed" : "updated"}: "${todo.text}"` };
    },
  }),
  defineTool("todo_remove", {
    description: "Remove a to-do item from a task's checklist",
    parameters: { type: "object", properties: { todoId: { type: "string", description: "The to-do item ID" } }, required: ["todoId"] },
    handler: async (args: any) => {
      ctx.todoStore.deleteTodo(args.todoId);
      return { success: true, message: "Todo removed" };
    },
  }),
  defineTool("session_rename", {
    description: "Rename a chat session. Use this to give a session a more descriptive title.",
    parameters: { type: "object", properties: { sessionId: { type: "string", description: "The session ID to rename" }, title: { type: "string", description: "The new title (3-6 words recommended)" } }, required: ["sessionId", "title"] },
    handler: async (args: any) => {
      ctx.sessionTitles.setTitle(args.sessionId, args.title);
      return { success: true, message: `Session renamed to "${args.title}"` };
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
        ? ` ${otherBusy} other session(s) are active — the launcher will wait for them to finish before rebuilding (up to 5 min).`
        : "";
      return {
        success: true,
        message: `Restart signal sent.${waitNote} Do NOT make any more tool calls — this session is considered active and will block the restart until it is idle.`,
      };
    },
  }),
  defineTool("self_update", {
    description:
      "Pull the latest code from the remote repository, sync dependencies, and restart the server. " +
      "Use this to update the Copilot Bridge to the latest version without the full staging workflow. " +
      "Saves a rollback checkpoint before pulling so the launcher can revert if the build or health check fails. " +
      "IMPORTANT: Do not make further tool calls after invoking this — the server will restart. " +
      "RESTRICTED: Only the primary session agent may call this tool. Sub-agents spawned via the task tool must NEVER call this.",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      if (existsSync(SIGNAL_FILE)) {
        return { success: false, error: "A restart is already pending. Wait for it to complete before updating." };
      }

      const dataDir = join(REPO_ROOT, "data");
      if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

      // Determine current branch
      const branchResult = run("git rev-parse --abbrev-ref HEAD");
      const branch = branchResult.ok ? branchResult.output.trim() : "main";

      // Save pre-update checkpoint so the launcher can roll back
      const headResult = run("git rev-parse HEAD");
      const preUpdateSha = headResult.ok ? headResult.output.trim() : "";
      if (preUpdateSha) {
        writeFileSync(PRE_DEPLOY_SHA_FILE, preUpdateSha);
      }

      // Pull latest
      const pullResult = run(`git pull --rebase origin ${branch}`);
      if (!pullResult.ok) {
        // Abort rebase if it left us in a conflicted state
        run("git rebase --abort");
        try { if (preUpdateSha) writeFileSync(PRE_DEPLOY_SHA_FILE, preUpdateSha); } catch {}
        return {
          success: false,
          error:
            `Git pull failed — likely due to merge conflicts or network issues. ` +
            `The working tree has been restored to its previous state.\n\n` +
            pullResult.output.slice(-500),
        };
      }

      const newHead = run("git rev-parse --short HEAD");
      const newSha = newHead.ok ? newHead.output.trim() : "unknown";
      const changed = preUpdateSha !== (run("git rev-parse HEAD").ok ? run("git rev-parse HEAD").output.trim() : "");

      if (!changed) {
        // Clean up checkpoint — nothing changed
        try { const { unlinkSync } = await import("node:fs"); unlinkSync(PRE_DEPLOY_SHA_FILE); } catch {}
        return { success: true, message: "Already up to date — no restart needed." };
      }

      // Sync deps if package files changed
      const depsChanged = run(`git diff "${preUpdateSha}" HEAD --name-only -- package.json package-lock.json`);
      if (depsChanged.ok && depsChanged.output.trim()) {
        const npmResult = run("npm install --no-audit --no-fund");
        if (!npmResult.ok) {
          return {
            success: false,
            error: `Pulled to ${newSha} but npm install failed. The launcher will retry on restart.\n\n` + npmResult.output.slice(-300),
          };
        }
        // Update deps hash so launcher doesn't re-install
        try {
          const { createHash } = await import("node:crypto");
          const parts: string[] = [];
          for (const f of ["package.json", "package-lock.json"]) {
            const p = join(REPO_ROOT, f);
            parts.push(existsSync(p) ? readFileSync(p, "utf-8") : "");
          }
          const hash = createHash("sha256").update(parts.join("\0")).digest("hex");
          writeFileSync(join(dataDir, "deps-hash"), hash);
        } catch {}
      }

      // Signal restart — launcher will build, health-check, and rollback if needed
      writeFileSync(SIGNAL_FILE, new Date().toISOString());
      const otherBusy = triggerRestartPending();
      const waitNote = otherBusy > 0
        ? ` ${otherBusy} other session(s) are active — the launcher will wait for them to finish.`
        : "";

      return {
        success: true,
        previousSha: preUpdateSha.slice(0, 8),
        newSha,
        message:
          `Updated ${preUpdateSha.slice(0, 8)} → ${newSha}. Restart signal sent.${waitNote} ` +
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
        cron: { type: "string", description: "Cron expression (e.g. '0 8 * * 1-5' for weekdays at 8am). Required for type=cron" },
        runAt: { type: "string", description: "ISO timestamp for one-shot runs (e.g. '2026-03-21T18:00:00Z'). Required for type=once" },
        reuseSession: { type: "boolean", description: "If true, reuse the last session instead of creating a new one each run. Default: false" },
        maxRuns: { type: "number", description: "Auto-disable after N runs (optional)" },
      },
      required: ["taskId", "name", "prompt", "type"],
    },
    handler: async (args: any) => {
      if (args.type === "cron" && !args.cron) return { error: "cron expression is required for cron schedules" };
      if (args.type === "once" && !args.runAt) return { error: "runAt is required for one-shot schedules" };
      if (!ctx.taskStore.getTask(args.taskId)) return { error: "Task not found" };

      const schedule = ctx.scheduleStore.createSchedule({
        taskId: args.taskId,
        name: args.name,
        prompt: args.prompt,
        type: args.type,
        cron: args.cron,
        runAt: args.runAt,
        reuseSession: args.reuseSession,
        maxRuns: args.maxRuns,
      });

      if (schedule.type === "cron") {
        schedulerModule.registerSchedule(schedule.id);
      } else if (schedule.type === "once" && schedule.runAt) {
        const delay = new Date(schedule.runAt).getTime() - Date.now();
        if (delay > 0) {
          setTimeout(() => {
            schedulerModule.triggerSchedule(schedule.id).catch(() => {});
          }, delay);
        }
      }

      ctx.globalBus.emit({ type: "schedule:changed", taskId: schedule.taskId, scheduleId: schedule.id });
      return { success: true, message: `Schedule "${schedule.name}" created (${schedule.type})`, scheduleId: schedule.id, nextRunAt: schedule.nextRunAt };
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
        enabled: { type: "boolean", description: "Enable or disable the schedule" },
        reuseSession: { type: "boolean", description: "Change session reuse strategy" },
      },
      required: ["scheduleId"],
    },
    handler: async (args: any) => {
      const { scheduleId, ...updates } = args;
      if (Object.keys(updates).length === 0) return { error: "No fields to update" };
      const schedule = ctx.scheduleStore.updateSchedule(scheduleId, updates);

      if (schedule.type === "cron") {
        if (schedule.enabled) schedulerModule.registerSchedule(schedule.id);
        else schedulerModule.unregisterSchedule(schedule.id);
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
          enabled: s.enabled,
          reuseSession: s.reuseSession,
          lastRunAt: s.lastRunAt,
          nextRunAt: s.nextRunAt,
          runCount: s.runCount,
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
        const page = ctx.docsStore!.readPage(args.path);
        if (!page) return { error: `Page not found: ${args.path}` };
        return { path: page.path, title: page.title, tags: page.tags, frontmatter: page.frontmatter, body: page.body };
      },
    }),
    defineTool("docs_write", {
      description: "Create or update a knowledge base page. Provide raw markdown content (with optional YAML frontmatter). Supports [[wikilinks]] — use [[page-path]] or [[page-path|Display Text]] to link between pages (resolved by path, title, or slug). Rejects writes to database collection folders — use docs_db_add for those.",
      parameters: { type: "object", properties: { path: { type: "string", description: "Page path relative to docs root (e.g., 'notes/my-page')" }, content: { type: "string", description: "Raw markdown content (may include YAML frontmatter)" } }, required: ["path", "content"] },
      handler: async (args: any) => {
        try {
          const page = ctx.docsStore!.writePage(args.path, args.content);
          ctx.docsIndex!.indexPage(page);
          return { path: page.path, success: true };
        } catch (err: any) {
          return { error: err.message };
        }
      },
    }),
    defineTool("docs_edit", {
      description: "Make a surgical string replacement in a knowledge base page. Finds exactly one occurrence of old_str in the raw markdown (frontmatter + body) and replaces it with new_str. Supports [[wikilinks]] — use [[page-path]] or [[page-path|Display Text]] to link between pages. Errors if old_str is not found or matches multiple times — include more surrounding context to disambiguate.",
      parameters: { type: "object", properties: { path: { type: "string", description: "Page path relative to docs root (e.g., 'notes/my-page')" }, old_str: { type: "string", description: "The exact string to find in the raw page content" }, new_str: { type: "string", description: "The replacement string" } }, required: ["path", "old_str", "new_str"] },
      handler: async (args: any) => {
        try {
          const page = ctx.docsStore!.editPage(args.path, args.old_str, args.new_str);
          ctx.docsIndex!.indexPage(page);
          return { path: page.path, success: true };
        } catch (err: any) {
          return { error: err.message };
        }
      },
    }),
    defineTool("docs_list", {
      description: "List pages and folders in the knowledge base. Returns a tree structure with file/folder types and database folder indicators.",
      parameters: { type: "object", properties: { folder: { type: "string", description: "Folder path to list (omit for root)" } }, required: [] },
      handler: async (args: any) => ({ tree: ctx.docsStore!.listTree(args.folder) }),
    }),
    defineTool("docs_db_schema", {
      description: "Get the schema for a database collection folder. Returns field names, types, options, and entry count. Call this before docs_db_add to discover valid fields.",
      parameters: { type: "object", properties: { folder: { type: "string", description: "Database folder name (e.g., 'incidents')" } }, required: ["folder"] },
      handler: async (args: any) => {
        const schema = ctx.docsStore!.readSchema(args.folder);
        if (!schema) return { error: `No schema found for folder "${args.folder}"` };
        const entries = ctx.docsStore!.listDbEntries(args.folder);
        return { ...schema, entryCount: entries.length };
      },
    }),
    defineTool("docs_db_add", {
      description: "Create a new entry in a database collection. Pass structured field values — the server validates against the schema and generates the markdown file. Always include a 'title' field.",
      parameters: { type: "object", properties: { folder: { type: "string", description: "Database folder name (e.g., 'incidents')" }, fields: { type: "object", description: "Field values as key-value pairs. Must include 'title'. Other fields are validated against the folder's schema." }, body: { type: "string", description: "Optional markdown body content for the entry" } }, required: ["folder", "fields"] },
      handler: async (args: any) => {
        try {
          const entry = ctx.docsStore!.addDbEntry(args.folder, args.fields, args.body);
          const page = ctx.docsStore!.readPage(entry.path);
          if (page) ctx.docsIndex!.indexPage(page);
          return { path: entry.path, slug: entry.slug, success: true };
        } catch (err: any) {
          return { error: err.message };
        }
      },
    }),
    defineTool("docs_db_update", {
      description: "Update an existing database entry. Only the provided fields are changed — other fields are preserved. The server validates against the schema.",
      parameters: { type: "object", properties: { folder: { type: "string", description: "Database folder name (e.g., 'incidents')" }, slug: { type: "string", description: "Entry slug (filename without .md, returned by docs_db_add or docs_db_query)" }, fields: { type: "object", description: "Field values to update (only changed fields needed)" }, body: { type: "string", description: "Optional new markdown body content" } }, required: ["folder", "slug", "fields"] },
      handler: async (args: any) => {
        try {
          const entry = ctx.docsStore!.updateDbEntry(args.folder, args.slug, args.fields, args.body);
          const page = ctx.docsStore!.readPage(entry.path);
          if (page) ctx.docsIndex!.indexPage(page);
          return { path: entry.path, success: true };
        } catch (err: any) {
          return { error: err.message };
        }
      },
    }),
    defineTool("docs_db_query", {
      description: "Query entries in a database collection by field values. Supports equality filters, multi-value OR (pass array), pagination, and sorting.",
      parameters: { type: "object", properties: { folder: { type: "string", description: "Database folder name (e.g., 'incidents')" }, filters: { type: "object", description: "Field filters as key-value pairs. Arrays match any value (OR). Example: { severity: 'sev1' } or { severity: ['sev1', 'sev2'] }" }, _sort: { type: "string", description: "Field to sort by (default: 'modified')" }, _order: { type: "string", enum: ["asc", "desc"], description: "Sort order (default: 'desc')" }, _limit: { type: "number", description: "Max results (default 50)" }, _offset: { type: "number", description: "Offset for pagination (default 0)" } }, required: ["folder"] },
      handler: async (args: any) => {
        return ctx.docsIndex!.queryByFolder(
          args.folder,
          args.filters,
          args._sort ? { field: args._sort, order: args._order ?? "desc" } : undefined,
          args._limit ?? 50,
          args._offset ?? 0,
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
        } catch (err: any) {
          return { error: err.message };
        }
      },
    }),
  ] : []),

    ...STAGING_TOOLS,

    ...createWebSearchTools(ctx),

    ...createBrowserFetchTools(ctx),
  ];
}

export interface SessionActivity {
  id: string;
  startedAt: number;
  lastEventAt: number;
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
  todoStore?: TodoStore;
  settingsStore?: SettingsStore;
  tagStore?: TagStore;
  docsIndex?: DocsIndex;
  docsStore?: DocsStore;
  config: { sessionMcpServers: Record<string, any>; model?: string };
  telemetryStore?: TelemetryStore;
  /** Custom env for CopilotClient — use to set COPILOT_HOME for session isolation */
  clientEnv?: Record<string, string | undefined>;
  /** Root of .copilot directory — defaults to homedir()/.copilot */
  copilotHome?: string;
}

/** Options that don't come from AppContext — caller provides these directly. */
export interface CreateSessionManagerOpts {
  tools: ReturnType<typeof defineTool>[];
  config: SessionManagerDeps["config"];
  clientEnv?: SessionManagerDeps["clientEnv"];
  copilotHome?: string;
}

/**
 * Factory that maps AppContext → SessionManagerDeps.
 *
 * Staging preview dynamically imports this from the worktree, so new deps are
 * picked up automatically without touching staging-tools.ts.
 */
export function createSessionManager(ctx: AppContext, opts: CreateSessionManagerOpts): SessionManager {
  return new SessionManager({
    tools: opts.tools,
    globalBus: ctx.globalBus,
    eventBusRegistry: ctx.eventBusRegistry,
    sessionTitles: ctx.sessionTitles,
    taskStore: ctx.taskStore,
    taskGroupStore: ctx.taskGroupStore,
    todoStore: ctx.todoStore,
    settingsStore: ctx.settingsStore,
    tagStore: ctx.tagStore,
    docsIndex: ctx.docsIndex,
    docsStore: ctx.docsStore,
    telemetryStore: ctx.telemetryStore,
    config: opts.config,
    clientEnv: opts.clientEnv,
    copilotHome: opts.copilotHome,
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
  private activeSessions = new Set<string>();
  private sessionObjects = new Map<string, any>(); // cached CopilotSession objects
  private titleGenerationInFlight = new Set<string>(); // prevent duplicate title generation
  private disposableSessionIds = new Set<string>(); // temporary sessions (title gen) to hide from listings
  private sessionActivity = new Map<string, { startedAt: number; lastEventAt: number }>();
  private mcpStatus = new Map<string, McpServerStatus[]>(); // per-session MCP server status

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

  private lookupGroupNotes(groupId?: string): { groupName: string; notes: string } | null {
    if (!groupId || !this.deps.taskGroupStore) return null;
    const group = this.deps.taskGroupStore.getGroup(groupId);
    if (!group?.notes?.trim()) return null;
    return { groupName: group.name, notes: group.notes };
  }

  private buildSessionConfig(opts: SessionConfigOptions = {}) {
    const { task, isNewTask, prDescriptions, scheduleContext, groupNotes } = opts;

    const cfg: any = {
      onPermissionRequest: approveAll,
      tools: this.deps.tools,
      mcpServers: this.deps.settingsStore?.getMcpServers() ?? this.deps.config.sessionMcpServers,
      skillDirectories: [
        join(REPO_ROOT, "skills"),                                          // built-in (ships with bridge)
        join(this.deps.copilotHome ?? join(homedir(), ".copilot"), "skills"), // user-level
      ],
    };

    // Model priority: settings store > deps.config > SDK default
    const model = this.deps.settingsStore?.getSettings().model ?? this.deps.config.model;
    if (model) cfg.model = model;

    if (task?.cwd) {
      cfg.workingDirectory = task.cwd;
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
      const todos = this.deps.todoStore?.listTodos(task.id) ?? [];
      if (todos.length > 0) {
        const today = new Date().toISOString().slice(0, 10);
        const todoLines = todos.map((t: any) => {
          let line = `- [${t.done ? "x" : " "}] ${t.text}`;
          if (t.deadline) {
            const overdue = !t.done && t.deadline < today;
            line += ` (due ${t.deadline}${overdue ? " ⚠️ OVERDUE" : ""})`;
          }
          return line;
        }).join("\n");
        contextParts.push(`Task checklist:\n${todoLines}`);
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

    // Staging rules — only when working on the bridge repo itself
    const isSelfRepo = !task?.cwd || resolve(task.cwd) === resolve(REPO_ROOT);
    const sections: Partial<Record<string, SectionOverride>> = {};
    if (isSelfRepo) {
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
          const manifest = relatedDocs.map((d) => `- ${d.title} (${d.path})`).join("\n");
          contextParts.push(
            `\n<related_docs>\nThese knowledge base docs are related to your current task's tags (${tagNames.join(", ")}). Use docs_read to access them when relevant:\n${manifest}\n</related_docs>`,
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
      }
    }

    // Inject server-local time into environment context (dynamic per turn via transform)
    const serverTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    sections.environment_context = {
      action: ((current: string) =>
        `${current}\n* Server local time: ${new Date().toLocaleString("en-US", { timeZone: serverTz })} (${serverTz})`
      ) as SectionOverrideAction,
    };

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
      return this.sessionListCache.data.filter((s: any) => !this.disposableSessionIds.has(s.sessionId));
    }

    const t0 = Date.now();
    const sessions = await this.client.listSessions();
    this.recordSpan("session.listSessions", Date.now() - t0);
    this.sessionListCache = { data: sessions, timestamp: Date.now() };
    return sessions.filter((s: any) => !this.disposableSessionIds.has(s.sessionId));
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
      if (this.disposableSessionIds.has(dirName)) return null;
      const yamlPath = join(sessionStateDir, dirName, "workspace.yaml");
      try {
        const content = await readFile(yamlPath, "utf-8");
        const session: any = { sessionId: dirName };
        let inSummary = false;
        const summaryLines: string[] = [];

        for (const line of content.split("\n")) {
          if (inSummary) {
            if (line.startsWith("  ")) {
              summaryLines.push(line.slice(2));
              continue;
            }
            inSummary = false;
          }
          if (line.startsWith("created_at:")) session.startTime = line.slice(12).trim();
          else if (line.startsWith("cwd:")) {
            const cwd = line.slice(5).trim();
            if (cwd) session.context = { cwd };
          } else if (line.startsWith("summary: |-")) {
            inSummary = true;
          } else if (line.startsWith("summary:")) {
            session.summary = line.slice(9).trim();
          }
        }
        if (summaryLines.length > 0 && !session.summary) {
          session.summary = summaryLines.join("\n");
        }
        // Use events.jsonl mtime for modifiedTime — workspace.yaml updated_at is stale
        const eventsPath = join(sessionStateDir, dirName, "events.jsonl");
        try {
          const st = await stat(eventsPath);
          session.modifiedTime = st.mtime.toISOString();
        } catch {
          try {
            const st = await stat(yamlPath);
            session.modifiedTime = st.mtime.toISOString();
          } catch {}
        }
        return session;
      } catch { return null; }
    });

    const results = await Promise.all(sessionPromises);
    const sessions = results.filter((s): s is any => s !== null);

    // Sort by most recently modified first
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
    if (this.disposableSessionIds.has(sessionId)) return undefined;
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
    if (!this.activeSessions.has(sessionId)) return false;

    const session = this.sessionObjects.get(sessionId);
    if (!session) return false;

    const sid = sessionId.slice(0, 8);
    console.log(`[sdk] [${sid}] 🛑 Aborting session...`);
    try {
      await session.abort();
      console.log(`[sdk] [${sid}] 🛑 Abort sent`);
    } catch (err) {
      console.error(`[sdk] [${sid}] 🛑 Abort failed:`, err);
      // Even if abort throws, emit aborted to unblock the UI
      const bus = this.deps.eventBusRegistry.getBus(sessionId);
      if (bus) bus.emit({ type: "aborted", content: "" });
    }
    return true;
  }

  // Fire and forget — starts work and emits events to the session's EventBus
  startWork(sessionId: string, prompt: string, attachments?: Array<{ type: "blob"; data: string; mimeType: string; displayName?: string }>): void {
    if (!this.client) throw new Error("SessionManager not initialized");
    if (isRestartPending()) {
      throw new Error(RESTART_PENDING_MESSAGE);
    }

    if (this.activeSessions.has(sessionId)) {
      throw new Error("Session is busy processing another message");
    }

    const bus = this.deps.eventBusRegistry.getOrCreateBus(sessionId);
    bus.reset(); // Ensure clean state even if bus was reused
    bus.setPendingPrompt(prompt);
    this.activeSessions.add(sessionId);
    const now = Date.now();
    this.sessionActivity.set(sessionId, { startedAt: now, lastEventAt: now });
    this.deps.globalBus.emit({ type: "session:busy", sessionId });
    if (_restartPending) {
      this.deps.globalBus.emit({ type: "server:restart-pending", waitingSessions: this.activeSessions.size });
    }

    // Run in background — not awaited
    this._doWork(sessionId, prompt, bus, attachments).catch((err) => {
      console.error(`[sdk] Unhandled error in session ${sessionId}:`, err);
      bus.emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
    }).finally(() => {
      this.activeSessions.delete(sessionId);
      this.sessionActivity.delete(sessionId);
      this.deps.globalBus.emit({ type: "session:idle", sessionId });
      if (_restartPending) {
        this.deps.globalBus.emit({ type: "server:restart-pending", waitingSessions: this.activeSessions.size });
      }
    });
  }

  private async _doWork(sessionId: string, prompt: string, bus: ReturnType<typeof getOrCreateBus>, attachments?: Array<{ type: "blob"; data: string; mimeType: string; displayName?: string }>): Promise<void> {
    const sid = sessionId.slice(0, 8);

    // Build resume config with optional task context
    const linkedTask = this.deps.taskStore.findTaskBySessionId(sessionId);
    const resumeConfig = this.buildSessionConfig({ task: linkedTask, groupNotes: this.lookupGroupNotes(linkedTask?.groupId) });

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
        this.recordSpan("session.resume", resumeDuration, sessionId, { context: "doWork" });
        console.log(`[sdk] [${sid}] Session resumed (${resumeDuration}ms)`);
      }
      return s;
    };

    let session = await resumeSession();

    // Track tool names by toolCallId — completion events don't include the tool name
    const toolNameMap = new Map<string, string>();
    // Track tool start times for telemetry
    const toolStartTimes = new Map<string, number>();
    // Track sub-agent parent tool call IDs → display name
    const subAgentMap = new Map<string, string>();
    // Capture sub-agent response text: parentToolCallId → last response content
    const subAgentResponseMap = new Map<string, string>();

    // Event handler extracted so it can be re-registered on session retry
    const handleEvent = (event: any) => {
      const data = (event as any).data;
      switch (event.type) {
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
          bus.emit({ type: "tool_progress", name: data?.toolCallId, message: data?.progressMessage ?? "" });
          break;
        case "tool.execution_partial_result":
          bus.emit({ type: "tool_output", name: data?.toolCallId, content: data?.partialOutput ?? "" });
          break;
        case "tool.execution_complete": {
          const completedToolName = toolNameMap.get(data?.toolCallId) ?? "unknown";
          const ok = data?.success !== false;
          const isAgent = subAgentMap.has(data?.toolCallId);
          const agentDisplayName = subAgentMap.get(data?.toolCallId);
          // Use captured sub-agent response text if available, fall back to raw tool result.
          // On failure, surface the error message so the UI can display it.
          const result = !ok && data?.error?.message
            ? data.error.message
            : isAgent
              ? (subAgentResponseMap.get(data?.toolCallId) ?? data?.result?.content)
              : data?.result?.content;
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
          bus.emit({ type: "error", message: data?.message ?? "unknown" });
          resolveWork();
          break;
        case "abort": {
          const reason = data?.reason ?? "user initiated";
          console.log(`[sdk] [${sid}] 🛑 Aborted: ${reason}`);
          const partialContent = lastAssistantContent ?? bus.getSnapshot().accumulatedContent ?? "";
          bus.emit({ type: "aborted", content: partialContent });
          resolveWork();
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
          this.recordSpan("session.sendToIdle", Date.now() - sendStart, sessionId, { chars: content.length });
          bus.emit({ type: "done", content });

          // Fire-and-forget title generation for sessions without a title
          if (!this.deps.sessionTitles.hasTitle(sessionId) && lastAssistantContent) {
            this.generateSessionTitle(sessionId, prompt, lastAssistantContent).catch(() => {});
          }

          resolveWork();
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

    let unsub = session.on(handleEvent);

    // Emit cached MCP status to the bus — the mcp_servers_loaded event fires during
    // create/resume before our handler is attached, so replay from the stored map
    const cachedMcp = this.mcpStatus.get(sessionId);
    if (cachedMcp?.length) {
      bus.emit({ type: "mcp_status", servers: cachedMcp });
    }

    // Periodic heartbeat log so silence = genuinely hung
    const sendStart = Date.now();
    const heartbeatLog = setInterval(() => {
      const elapsed = ((Date.now() - sendStart) / 1000).toFixed(0);
      console.log(`[sdk] [${sid}] ⏳ Still working... (${elapsed}s)`);
    }, 30_000);

    // Watchdog — if no events for 5 minutes, assume hung and clean up
    const WATCHDOG_TIMEOUT = 300_000;
    let lastEventTime = Date.now();
    const watchdog = setInterval(() => {
      if (Date.now() - lastEventTime > WATCHDOG_TIMEOUT) {
        const elapsed = ((Date.now() - sendStart) / 1000).toFixed(0);
        console.error(`[sdk] [${sid}] ⚠️ Watchdog: no events for ${WATCHDOG_TIMEOUT / 1000}s — aborting (${elapsed}s total)`);
        bus.emit({ type: "error", message: "Session timed out — no activity for 5 minutes" });
        resolveWork();
      }
    }, 30_000);

    // Tap into bus emissions to track last event time for watchdog + activity
    const originalEmit = bus.emit.bind(bus);
    bus.emit = (event) => {
      lastEventTime = Date.now();
      const activity = this.sessionActivity.get(sessionId);
      if (activity) activity.lastEventAt = lastEventTime;
      return originalEmit(event);
    };

    let resolveWork: () => void;
    let lastAssistantContent: string | undefined;

    try {
      const attachCount = attachments?.length ?? 0;
      console.log(`[sdk] [${sid}] Sending prompt (${prompt.length} chars${attachCount ? `, ${attachCount} attachment${attachCount > 1 ? "s" : ""}` : ""})...`);

      try {
        await session.send({ prompt, ...(attachments?.length ? { attachments } : {}) });
      } catch (sendErr) {
        // If the agent evicted this session, the cached object is stale — re-resume and retry once
        if (sendErr instanceof Error && sendErr.message.includes("Session not found") && usedCache) {
          console.warn(`[sdk] [${sid}] Stale cached session — evicting and re-resuming...`);
          unsub();
          this.sessionObjects.delete(sessionId);
          session = await resumeSession();
          unsub = session.on(handleEvent);
          await session.send({ prompt, ...(attachments?.length ? { attachments } : {}) });
        } else {
          throw sendErr;
        }
      }

      // Wait for session.idle or session.error (resolved from event handler)
      await new Promise<void>((resolve) => {
        resolveWork = resolve;
      });
    } finally {
      clearInterval(heartbeatLog);
      clearInterval(watchdog);
      unsub();
    }
  }

  async getSessionMessages(sessionId: string, opts?: { limit?: number; before?: number }): Promise<{ messages: TransformedEntry[]; total: number; hasMore: boolean }> {
    if (!this.client) throw new Error("SessionManager not initialized");

    const t0 = Date.now();
    const sid = sessionId.slice(0, 8);
    const linkedTask = this.deps.taskStore.findTaskBySessionId(sessionId);
    const msgResumeConfig = this.buildSessionConfig({ task: linkedTask, groupNotes: this.lookupGroupNotes(linkedTask?.groupId) });
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
    const messages = transformEventsToMessages(events);

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
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch { /* skip malformed lines */ }
    }

    const messages = transformEventsToMessages(events);
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

    const sid = sessionId.slice(0, 8);
    const t0 = Date.now();
    console.log(`[sdk] [${sid}] Warming session...`);

    const linkedTask = this.deps.taskStore.findTaskBySessionId(sessionId);
    const resumeConfig = this.buildSessionConfig({ task: linkedTask, groupNotes: this.lookupGroupNotes(linkedTask?.groupId) });

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
  }

  /** Check if a session object is cached and ready for interaction */
  isSessionWarm(sessionId: string): boolean {
    return this.sessionObjects.has(sessionId);
  }

  // Generate a concise session title via a lightweight LLM call
  private async generateSessionTitle(sessionId: string, userMessage: string, assistantResponse: string): Promise<void> {
    if (!this.client || this.deps.sessionTitles.hasTitle(sessionId) || this.titleGenerationInFlight.has(sessionId)) return;
    this.titleGenerationInFlight.add(sessionId);

    const sid = sessionId.slice(0, 8);
    console.log(`[titles] [${sid}] Generating session title...`);

    let titleSessionId: string | undefined;
    try {
      const titleSession = await this.client.createSession({ onPermissionRequest: approveAll });
      titleSessionId = titleSession.sessionId;
      this.disposableSessionIds.add(titleSessionId);
      const truncatedUser = userMessage.slice(0, 500);
      const truncatedAssistant = assistantResponse.slice(0, 500);

      const prompt = [
        "Generate a concise 3-6 word title for this conversation.",
        "Reply with ONLY the title text — no quotes, no punctuation unless it's part of a name.",
        "",
        `User: ${truncatedUser}`,
        `Assistant: ${truncatedAssistant}`,
      ].join("\n");

      const result = await titleSession.sendAndWait({ prompt }, 15_000);
      const title = result?.data?.content?.trim().replace(/^["']|["']$/g, "");

      // Reject titles that look like the prompt was echoed back
      const looksLikePrompt = title && /generate|concise|3-6 word|title for this/i.test(title);

      if (title && title.length > 0 && title.length <= 80 && !looksLikePrompt) {
        this.deps.sessionTitles.setTitle(sessionId, title);
        const bus = this.deps.eventBusRegistry.getOrCreateBus(sessionId);
        bus.emit({ type: "title_changed", title });
        this.deps.globalBus.emit({ type: "session:title", sessionId, title });
        console.log(`[titles] [${sid}] Title: "${title}"`);
      } else {
        console.log(`[titles] [${sid}] Title generation returned invalid result: "${title}"`);
      }
    } catch (err) {
      console.error(`[titles] [${sid}] Title generation failed:`, err);
    } finally {
      this.titleGenerationInFlight.delete(sessionId);
      // Always clean up the disposable title session
      if (titleSessionId) {
        this.client!.deleteSession(titleSessionId).catch((err) =>
          console.error(`[titles] [${sid}] Failed to delete title session:`, err),
        );
      }
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    if (!this.client) throw new Error("SessionManager not initialized");
    if (this.activeSessions.has(sessionId)) {
      throw new Error("Cannot delete a busy session");
    }
    this.sessionObjects.delete(sessionId);
    await this.client.deleteSession(sessionId);
    this.invalidateSessionListCache();
    console.log(`[sdk] Deleted session ${sessionId}`);
  }

  isSessionBusy(sessionId: string): boolean {
    return this.activeSessions.has(sessionId);
  }

  hasActiveTurns(): boolean {
    return this.activeSessions.size > 0;
  }

  getActiveSessions(): string[] {
    return Array.from(this.activeSessions);
  }

  /** Evict all cached session objects so the next turn forces a re-resume with fresh config */
  evictAllCachedSessions(): void {
    const busy = new Set(this.activeSessions);
    let evicted = 0;
    for (const [id, session] of this.sessionObjects) {
      if (busy.has(id)) continue; // don't disrupt active turns
      try { session.disconnect(); } catch { /* best-effort */ }
      this.sessionObjects.delete(id);
      evicted++;
    }
    console.log(`[sdk] Evicted ${evicted} cached session(s) (${busy.size} busy, skipped)`);
  }

  getSessionActivity(): SessionActivity[] {
    const now = Date.now();
    return Array.from(this.sessionActivity.entries()).map(([id, a]) => ({
      id,
      startedAt: a.startedAt,
      lastEventAt: a.lastEventAt,
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
            const session = this.sessionObjects.get(sessionId);
            if (session) {
              await session.abort();
              console.log(`[sdk] [${sid}] Aborted for shutdown`);
            }
          } catch (err) {
            console.error(`[sdk] [${sid}] Abort failed during shutdown:`, err);
          }
        }),
      );

      // Wait up to 10s for sessions to drain (they clean up in their .finally())
      const deadline = Date.now() + 10_000;
      while (this.activeSessions.size > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 250));
      }
      if (this.activeSessions.size > 0) {
        console.log(`[sdk] ${this.activeSessions.size} session(s) did not drain in time`);
      } else {
        console.log("[sdk] All sessions drained cleanly");
      }
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
