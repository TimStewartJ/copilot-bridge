// Copilot SDK session manager
// Universal tools — taskId is a parameter, same tools for every session

import { CopilotClient, approveAll, defineTool } from "@github/copilot-sdk";
import type { SectionOverride } from "@github/copilot-sdk";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import * as taskStore from "./task-store.js";
import type { WorkItemRef } from "./task-store.js";
import type { Task } from "./task-store.js";
import * as taskGroupStore from "./task-group-store.js";
import * as scheduleStore from "./schedule-store.js";
import * as schedulerModule from "./scheduler.js";
import { getOrCreateBus, getBus } from "./event-bus.js";
import * as sessionTitles from "./session-titles.js";
import * as globalBus from "./global-bus.js";
import { STAGING_TOOLS } from "./staging-tools.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const SIGNAL_FILE = join(REPO_ROOT, "data", "restart.signal");

const STAGING_INSTRUCTIONS = `
<staging_workflow>
When modifying code in this repository (the Copilot Bridge):
1. Call staging_init to create a fresh, isolated worktree
2. Make ALL code edits in the returned staging directory — never in the production directory
3. Run quality checks in the staging directory:
   - npx tsc --noEmit (type checking)
   - npx vite build (client build)
4. When all checks pass, call staging_deploy with a descriptive commit message
5. Do NOT make further tool calls after staging_deploy — the server will restart

IMPORTANT: Never edit source files directly in the production directory.
Always use the staging workflow for any code changes to this codebase.
For non-code restarts (config, env), use self_restart instead.
</staging_workflow>
`.trim();

// ── Session config builder ───────────────────────────────────────

interface SessionConfigOptions {
  task?: Task | null;
  isNewTask?: boolean;
  prDescriptions?: string[];
}

function buildSessionConfig(opts: SessionConfigOptions = {}) {
  const { task, isNewTask, prDescriptions } = opts;

  const cfg: any = {
    onPermissionRequest: approveAll,
    tools: BRIDGE_TOOLS,
    mcpServers: config.sessionMcpServers,
  };

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
  }

  // Staging rules — only when working on the bridge repo itself
  const isSelfRepo = !task?.cwd || resolve(task.cwd) === resolve(REPO_ROOT);
  const sections: Partial<Record<string, SectionOverride>> = {};
  if (isSelfRepo) {
    sections.code_change_rules = { action: "append", content: STAGING_INSTRUCTIONS };
  }

  const hasContent = contextParts.length > 0;
  const hasSections = Object.keys(sections).length > 0;

  if (hasContent || hasSections) {
    cfg.systemMessage = {
      mode: "customize" as const,
      sections: hasSections ? sections : undefined,
      content: hasContent ? contextParts.join("\n") : undefined,
    };
  }

  return cfg;
}

// Module-level ref so universal tools can query session state
let _instance: SessionManager | null = null;
let _restartPending = false;
let _restartPendingSince = 0;
const RESTART_TIMEOUT = 10 * 60 * 1000; // 10 min — if server is still alive, restart failed

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

// Universal tools — same instance for every session
const BRIDGE_TOOLS = [
  defineTool("task_link_work_item", {
    description: "Link a work item to a task by its ID",
    parameters: { type: "object", properties: { taskId: { type: "string", description: "The task ID" }, workItemId: { type: "number", description: "The work item ID" }, provider: { type: "string", enum: ["ado", "github"], description: "The provider (ado or github). Defaults to ado." } }, required: ["taskId", "workItemId"] },
    handler: async (args: any) => {
      taskStore.linkWorkItem(args.taskId, args.workItemId, args.provider ?? "ado");
      return { success: true, message: `Work item #${args.workItemId} (${args.provider ?? "ado"}) linked to task` };
    },
  }),
  defineTool("task_unlink_work_item", {
    description: "Remove a work item from a task",
    parameters: { type: "object", properties: { taskId: { type: "string", description: "The task ID" }, workItemId: { type: "number", description: "The work item ID" }, provider: { type: "string", enum: ["ado", "github"], description: "The provider (ado or github)" } }, required: ["taskId", "workItemId"] },
    handler: async (args: any) => {
      taskStore.unlinkWorkItem(args.taskId, args.workItemId, args.provider);
      return { success: true, message: `Work item #${args.workItemId} unlinked from task` };
    },
  }),
  defineTool("task_link_pr", {
    description: "Link a pull request to a task",
    parameters: { type: "object", properties: { taskId: { type: "string", description: "The task ID" }, repoName: { type: "string", description: "Repository name" }, prId: { type: "number", description: "PR number" }, provider: { type: "string", enum: ["ado", "github"], description: "The provider (ado or github). Defaults to ado." } }, required: ["taskId", "repoName", "prId"] },
    handler: async (args: any) => {
      taskStore.linkPR(args.taskId, { repoId: args.repoName, repoName: args.repoName, prId: args.prId, provider: args.provider ?? "ado" });
      return { success: true, message: `PR #${args.prId} from ${args.repoName} linked to task` };
    },
  }),
  defineTool("task_unlink_pr", {
    description: "Remove a pull request from a task",
    parameters: { type: "object", properties: { taskId: { type: "string", description: "The task ID" }, repoName: { type: "string", description: "Repository name" }, prId: { type: "number", description: "PR number" }, provider: { type: "string", enum: ["ado", "github"], description: "The provider (ado or github)" } }, required: ["taskId", "repoName", "prId"] },
    handler: async (args: any) => {
      taskStore.unlinkPR(args.taskId, args.repoName, args.prId, args.provider);
      return { success: true, message: `PR #${args.prId} from ${args.repoName} unlinked from task` };
    },
  }),
  defineTool("task_update", {
    description: "Update a task's title, notes, working directory, and/or group. Only provided fields are changed.",
    parameters: { type: "object", properties: { taskId: { type: "string", description: "The task ID" }, title: { type: "string", description: "New title" }, notes: { type: "string", description: "New notes content (markdown). Overwrites existing notes." }, cwd: { type: "string", description: "Working directory path for the task" }, groupId: { type: "string", description: "Task group ID to assign to (use empty string to ungroup)" } }, required: ["taskId"] },
    handler: async (args: any) => {
      const updates: Record<string, string> = {};
      if (args.title !== undefined) updates.title = args.title;
      if (args.notes !== undefined) updates.notes = args.notes;
      if (args.cwd !== undefined) updates.cwd = args.cwd;
      if (args.groupId !== undefined) updates.groupId = args.groupId || "";
      if (Object.keys(updates).length === 0) return { error: "No fields to update. Provide at least one of: title, notes, cwd, groupId" };
      taskStore.updateTask(args.taskId, updates);
      const fields = Object.keys(updates).join(", ");
      return { success: true, message: `Task updated (${fields})` };
    },
  }),
  defineTool("task_get_info", {
    description: "Get task details including title, status, linked work items, PRs, and notes",
    parameters: { type: "object", properties: { taskId: { type: "string", description: "The task ID" } }, required: ["taskId"] },
    handler: async (args: any) => {
      return taskStore.getTask(args.taskId) ?? { error: "Task not found" };
    },
  }),
  defineTool("task_list", {
    description: "List all tasks with their IDs, titles, statuses, and group IDs",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      return { tasks: taskStore.listTasks().map((t) => ({ id: t.id, title: t.title, status: t.status, groupId: t.groupId })) };
    },
  }),
  defineTool("task_create", {
    description: "Create a new task",
    parameters: { type: "object", properties: { title: { type: "string", description: "The task title" } }, required: ["title"] },
    handler: async (args: any) => {
      const task = taskStore.createTask(args.title);
      return { success: true, message: `Task "${task.title}" created`, taskId: task.id };
    },
  }),
  defineTool("task_group_create", {
    description: "Create a new task group for organizing related tasks",
    parameters: { type: "object", properties: { name: { type: "string", description: "Group name (e.g., 'Frontend App', 'Bootstrap')" }, color: { type: "string", description: "Optional color: blue, purple, green, amber, rose, cyan, orange, slate" } }, required: ["name"] },
    handler: async (args: any) => {
      const group = taskGroupStore.createGroup(args.name, args.color);
      return { success: true, message: `Group "${group.name}" created`, groupId: group.id };
    },
  }),
  defineTool("task_group_list", {
    description: "List all task groups with their IDs and names",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      return { groups: taskGroupStore.listGroups().map((g) => ({ id: g.id, name: g.name, color: g.color })) };
    },
  }),
  defineTool("task_group_delete", {
    description: "Delete a task group. Tasks in the group become ungrouped.",
    parameters: { type: "object", properties: { groupId: { type: "string", description: "The group ID to delete" } }, required: ["groupId"] },
    handler: async (args: any) => {
      const tasks = taskStore.listTasks().filter((t) => t.groupId === args.groupId);
      for (const t of tasks) taskStore.updateTask(t.id, { groupId: undefined });
      taskGroupStore.deleteGroup(args.groupId);
      return { success: true, message: `Group deleted, ${tasks.length} task(s) ungrouped` };
    },
  }),
  defineTool("session_rename", {
    description: "Rename a chat session. Use this to give a session a more descriptive title.",
    parameters: { type: "object", properties: { sessionId: { type: "string", description: "The session ID to rename" }, title: { type: "string", description: "The new title (3-6 words recommended)" } }, required: ["sessionId", "title"] },
    handler: async (args: any) => {
      sessionTitles.setTitle(args.sessionId, args.title);
      return { success: true, message: `Session renamed to "${args.title}"` };
    },
  }),
  defineTool("self_restart", {
    description: "Restart the Copilot Bridge server WITHOUT code changes (config reload, env changes, emergency restart). For deploying code changes, use staging_init → make changes → staging_deploy instead. The launcher will auto-checkpoint, rebuild, and swap processes. IMPORTANT: This session counts as active — do not make further tool calls after invoking this, or you will block the restart.",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      const dataDir = join(REPO_ROOT, "data");
      if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
      writeFileSync(SIGNAL_FILE, new Date().toISOString());
      _restartPending = true;
      _restartPendingSince = Date.now();

      // Watchdog: if the launcher consumes the signal file but this process
      // survives (restart failed / rolled back), auto-clear the pending state.
      // The launcher deletes the signal file immediately, then spends time
      // waiting for sessions + building, so we wait 90s after the file disappears.
      const watchdog = setInterval(() => {
        if (!_restartPending) { clearInterval(watchdog); return; }
        if (!existsSync(SIGNAL_FILE)) {
          // Signal consumed — give the restart time to kill us, then clear
          setTimeout(() => {
            if (_restartPending) clearRestartPending();
          }, 90_000);
          clearInterval(watchdog);
        }
      }, 5_000);

      const otherBusy = _instance ? Math.max(0, _instance.getActiveSessions().length - 1) : 0;
      globalBus.emit({ type: "server:restart-pending", waitingSessions: otherBusy });
      const waitNote = otherBusy > 0
        ? ` ${otherBusy} other session(s) are active — the launcher will wait for them to finish before rebuilding (up to 5 min).`
        : "";
      return {
        success: true,
        message: `Restart signal sent.${waitNote} Do NOT make any more tool calls — this session is considered active and will block the restart until it is idle.`,
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
      if (!taskStore.getTask(args.taskId)) return { error: "Task not found" };

      const schedule = scheduleStore.createSchedule({
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
      const schedule = scheduleStore.updateSchedule(scheduleId, updates);

      if (schedule.type === "cron") {
        if (schedule.enabled) schedulerModule.registerSchedule(schedule.id);
        else schedulerModule.unregisterSchedule(schedule.id);
      }

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
      schedulerModule.unregisterSchedule(args.scheduleId);
      scheduleStore.deleteSchedule(args.scheduleId);
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
      const schedules = scheduleStore.listSchedules(args.taskId);
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
  ...STAGING_TOOLS,
];

export class SessionManager {
  private client: CopilotClient | null = null;
  private activeSessions = new Set<string>();
  private sessionObjects = new Map<string, any>(); // cached CopilotSession objects
  private titleGenerationInFlight = new Set<string>(); // prevent duplicate title generation
  private disposableSessionIds = new Set<string>(); // temporary sessions (title gen) to hide from listings

  async initialize(): Promise<void> {
    console.log("[sdk] Initializing Copilot SDK client...");
    _instance = this;
    this.client = new CopilotClient();
    await this.client.start();
    sessionTitles.loadTitles();
    console.log("[sdk] Copilot SDK client ready");
  }

  async listSessions() {
    if (!this.client) throw new Error("SessionManager not initialized");
    const sessions = await this.client.listSessions();
    // Filter out temporary sessions (e.g., title generation) that may not have been deleted yet
    return sessions.filter((s: any) => !this.disposableSessionIds.has(s.sessionId));
  }

  async createSession(): Promise<{ sessionId: string }> {
    if (!this.client) throw new Error("SessionManager not initialized");

    const session = await this.client.createSession(buildSessionConfig());

    this.sessionObjects.set(session.sessionId, session);
    console.log(`[sdk] Created session ${session.sessionId}`);
    return { sessionId: session.sessionId };
  }

  async createTaskSession(taskId: string, taskTitle: string, workItems: WorkItemRef[], prDescriptions: string[], notes: string, cwd?: string): Promise<{ sessionId: string }> {
    if (!this.client) throw new Error("SessionManager not initialized");

    const isPlaceholder = taskTitle === "New Task";

    const task = {
      id: taskId,
      title: taskTitle,
      status: "active" as const,
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

    const session = await this.client.createSession(
      buildSessionConfig({ task, isNewTask: isPlaceholder, prDescriptions }),
    );

    this.sessionObjects.set(session.sessionId, session);
    console.log(`[sdk] Created task session ${session.sessionId} for "${taskTitle}"`);
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
      const bus = getBus(sessionId);
      if (bus) bus.emit({ type: "aborted", content: "" });
    }
    return true;
  }

  // Fire and forget — starts work and emits events to the session's EventBus
  startWork(sessionId: string, prompt: string): void {
    if (!this.client) throw new Error("SessionManager not initialized");

    if (this.activeSessions.has(sessionId)) {
      throw new Error("Session is busy processing another message");
    }

    const bus = getOrCreateBus(sessionId);
    bus.reset(); // Ensure clean state even if bus was reused
    this.activeSessions.add(sessionId);
    globalBus.emit({ type: "session:busy", sessionId });

    // Run in background — not awaited
    this._doWork(sessionId, prompt, bus).catch((err) => {
      console.error(`[sdk] Unhandled error in session ${sessionId}:`, err);
      bus.emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
    }).finally(() => {
      this.activeSessions.delete(sessionId);
      globalBus.emit({ type: "session:idle", sessionId });
      if (_restartPending) {
        globalBus.emit({ type: "server:restart-pending", waitingSessions: this.activeSessions.size });
      }
    });
  }

  private async _doWork(sessionId: string, prompt: string, bus: ReturnType<typeof getOrCreateBus>): Promise<void> {
    const sid = sessionId.slice(0, 8);

    // Build resume config with optional task context
    const linkedTask = taskStore.findTaskBySessionId(sessionId);
    const resumeConfig = buildSessionConfig({ task: linkedTask });

    if (linkedTask) {
      console.log(`[sdk] [${sid}] Injecting task context for "${linkedTask.title}"`);
    }

    // Get or resume session — reuse cached object if available
    const resumeStart = Date.now();
    let session = this.sessionObjects.get(sessionId);

    if (session) {
      console.log(`[sdk] [${sid}] Reusing cached session object`);
    } else {
      console.log(`[sdk] [${sid}] Resuming session...`);
      session = await Promise.race([
        this.client!.resumeSession(sessionId, resumeConfig),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("resumeSession timed out after 60s")), 60_000),
        ),
      ]);
      this.sessionObjects.set(sessionId, session);
      console.log(`[sdk] [${sid}] Session resumed (${Date.now() - resumeStart}ms)`);
    }

    // Track tool names by toolCallId — completion events don't include the tool name
    const toolNameMap = new Map<string, string>();

    const unsub = session.on((event: any) => {
      const data = (event as any).data;
      switch (event.type) {
        case "assistant.turn_start":
          console.log(`[sdk] [${sid}] ⏳ Turn started`);
          bus.emit({ type: "thinking" });
          break;
        case "assistant.message_delta":
          if (data?.deltaContent) {
            bus.emit({ type: "delta", content: data.deltaContent });
          }
          break;
        case "assistant.streaming_delta":
          if (data?.content) {
            bus.emit({ type: "delta", content: data.content });
          }
          break;
        case "assistant.intent":
          console.log(`[sdk] [${sid}] 🎯 Intent: ${data?.intent}`);
          bus.emit({ type: "intent", intent: data?.intent ?? "" });
          globalBus.emit({ type: "session:intent", sessionId, intent: data?.intent ?? "" });
          break;
        case "assistant.message":
          if (data?.content) {
            console.log(`[sdk] [${sid}] ✅ Response (${data.content.length} chars)`);
            lastAssistantContent = data.content;
            if (data.toolRequests?.length) {
              bus.emit({ type: "assistant_partial", content: data.content });
            }
          }
          break;
        case "tool.execution_start": {
          const toolName = data?.toolName ?? data?.name ?? "unknown";
          if (data?.toolCallId) toolNameMap.set(data.toolCallId, toolName);
          console.log(`[sdk] [${sid}] 🔧 Tool: ${toolName}${data?.parentToolCallId ? ` (sub-agent)` : ""}`);
          bus.emit({
            type: "tool_start",
            toolCallId: data?.toolCallId,
            name: toolName,
            args: data?.arguments,
            parentToolCallId: data?.parentToolCallId,
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
          console.log(`[sdk] [${sid}] 🔧 Tool complete: ${completedToolName} (${ok ? "ok" : "failed"})`);
          bus.emit({
            type: "tool_done",
            toolCallId: data?.toolCallId,
            name: completedToolName,
            result: data?.result?.content,
            success: data?.success,
          });
          break;
        }
        case "subagent.started":
          console.log(`[sdk] [${sid}] 🤖 Sub-agent: ${data?.agentDisplayName ?? data?.agentName ?? "agent"}`);
          bus.emit({
            type: "tool_start",
            toolCallId: data?.toolCallId,
            name: `🤖 ${data?.agentDisplayName ?? data?.agentName ?? "agent"}`,
            isSubAgent: true,
          });
          break;
        case "subagent.completed":
        case "subagent.failed":
          bus.emit({
            type: "tool_done",
            toolCallId: data?.toolCallId,
            name: `🤖 ${data?.agentDisplayName ?? data?.agentName ?? "agent"}`,
            success: event.type === "subagent.completed",
            isSubAgent: true,
          });
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
          globalBus.emit({ type: "session:title", sessionId, title: data?.title ?? "" });
          break;
        case "session.idle": {
          const elapsed = ((Date.now() - sendStart) / 1000).toFixed(1);
          const content = lastAssistantContent ?? "(no response)";
          console.log(`[sdk] [${sid}] 💤 Session idle — done: ${content.length} chars (${elapsed}s)`);
          bus.emit({ type: "done", content });

          // Fire-and-forget title generation for sessions without a title
          if (!sessionTitles.hasTitle(sessionId) && lastAssistantContent) {
            this.generateSessionTitle(sessionId, prompt, lastAssistantContent).catch(() => {});
          }

          resolveWork();
          break;
        }
        default:
          break;
      }
    });

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

    // Tap into bus emissions to track last event time for watchdog
    const originalEmit = bus.emit.bind(bus);
    bus.emit = (event) => {
      lastEventTime = Date.now();
      return originalEmit(event);
    };

    let resolveWork: () => void;
    let lastAssistantContent: string | undefined;

    try {
      console.log(`[sdk] [${sid}] Sending prompt (${prompt.length} chars)...`);
      await session.send({ prompt });

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

  async getSessionMessages(sessionId: string): Promise<Array<{ role: string; content: string; timestamp?: string; toolCalls?: Array<{ toolCallId: string; name: string; args?: Record<string, unknown>; result?: string; success?: boolean }> }>> {
    if (!this.client) throw new Error("SessionManager not initialized");

    const sid = sessionId.slice(0, 8);
    const linkedTask = taskStore.findTaskBySessionId(sessionId);
    const msgResumeConfig = buildSessionConfig({ task: linkedTask });

    // Reuse cached session object — avoids overwriting the active one in the SDK
    let session = this.sessionObjects.get(sessionId);
    let events: any[];

    if (session) {
      console.log(`[sdk] [${sid}] Loading messages (cached session)...`);
      try {
        events = await session.getMessages();
        console.log(`[sdk] [${sid}] Loaded ${events.length} events from cached session`);
      } catch (err) {
        // Stale cache — CLI may have restarted. Evict and re-resume.
        console.log(`[sdk] [${sid}] Cached session stale (${err instanceof Error ? err.message : String(err)}), re-resuming...`);
        this.sessionObjects.delete(sessionId);
        session = await Promise.race([
          this.client.resumeSession(sessionId, msgResumeConfig),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("resumeSession timed out after 60s")), 60_000),
          ),
        ]);
        this.sessionObjects.set(sessionId, session);
        events = await session.getMessages();
        console.log(`[sdk] [${sid}] Loaded ${events.length} events after re-resume`);
      }
    } else {
      console.log(`[sdk] [${sid}] Loading messages (resuming session)...`);
      session = await Promise.race([
        this.client.resumeSession(sessionId, msgResumeConfig),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("resumeSession timed out after 60s")), 60_000),
        ),
      ]);
      this.sessionObjects.set(sessionId, session);
      events = await session.getMessages();
      console.log(`[sdk] [${sid}] Loaded ${events.length} events after fresh resume`);
    }

    const messages: Array<{ role: string; content: string; timestamp?: string; toolCalls?: Array<{ toolCallId: string; name: string; args?: Record<string, unknown>; result?: string; success?: boolean }> }> = [];

    // Index tool events by toolCallId for fast lookup
    const toolStarts = new Map<string, { toolName: string; arguments?: Record<string, unknown>; parentToolCallId?: string }>();
    const toolCompletes = new Map<string, { success: boolean; content?: string }>();
    // Track sub-agent lifecycle: toolCallId → agent info
    const subAgentStarts = new Map<string, { agentName: string; agentDisplayName: string }>();
    const subAgentEnds = new Map<string, { success: boolean }>();
    for (const event of events) {
      const data = (event as any).data;
      if (event.type === "tool.execution_start" && data?.toolCallId) {
        toolStarts.set(data.toolCallId, { toolName: data.toolName, arguments: data.arguments, parentToolCallId: data.parentToolCallId });
      } else if (event.type === "tool.execution_complete" && data?.toolCallId) {
        toolCompletes.set(data.toolCallId, { success: data.success, content: data.result?.content });
      } else if (event.type === "subagent.started" && data?.toolCallId) {
        subAgentStarts.set(data.toolCallId, { agentName: data.agentName, agentDisplayName: data.agentDisplayName });
      } else if ((event.type === "subagent.completed" || event.type === "subagent.failed") && data?.toolCallId) {
        subAgentEnds.set(data.toolCallId, { success: event.type === "subagent.completed" });
      }
    }
    console.log(`[sdk] Indexed ${toolStarts.size} tool starts, ${toolCompletes.size} tool completes, ${subAgentStarts.size} sub-agents`);

    for (const event of events) {
      if (event.type === "user.message") {
        const data = event.data as any;
        const content = data.content ?? data.prompt ?? "";
        if (content.trim()) {
          messages.push({ role: "user", content, timestamp: data.timestamp ?? (event as any).timestamp });
        }
      } else if (event.type === "assistant.message") {
        const data = (event as any).data;
        const content = data.content ?? "";

        // Build tool calls from toolRequests
        let toolCalls: Array<{ toolCallId: string; name: string; args?: Record<string, unknown>; result?: string; success?: boolean; parentToolCallId?: string; isSubAgent?: boolean; childToolCalls?: Array<{ toolCallId: string; name: string; args?: Record<string, unknown>; result?: string; success?: boolean; parentToolCallId?: string }> }> | undefined;
        if (data.toolRequests?.length) {
          toolCalls = data.toolRequests
            .filter((tr: any) => tr.name !== "report_intent")
            .map((tr: any) => {
              const start = toolStarts.get(tr.toolCallId);
              const complete = toolCompletes.get(tr.toolCallId);
              const subAgent = subAgentStarts.get(tr.toolCallId);
              const subEnd = subAgentEnds.get(tr.toolCallId);
              if (subAgent) {
                // This is a sub-agent parent tool call — collect its children
                const children = [...toolStarts.entries()]
                  .filter(([, s]) => s.parentToolCallId === tr.toolCallId)
                  .map(([childId, s]) => {
                    const childComplete = toolCompletes.get(childId);
                    return {
                      toolCallId: childId,
                      name: s.toolName,
                      args: s.arguments,
                      result: childComplete?.content,
                      success: childComplete?.success,
                      parentToolCallId: tr.toolCallId,
                    };
                  })
                  .filter((c) => c.name !== "report_intent");
                return {
                  toolCallId: tr.toolCallId,
                  name: `🤖 ${subAgent.agentDisplayName ?? subAgent.agentName ?? "agent"}`,
                  isSubAgent: true,
                  success: subEnd?.success,
                  childToolCalls: children.length > 0 ? children : undefined,
                };
              }
              return {
                toolCallId: tr.toolCallId,
                name: tr.name,
                args: start?.arguments ?? tr.arguments,
                result: complete?.content,
                success: complete?.success,
                parentToolCallId: start?.parentToolCallId,
              };
            })
            // Filter out child tool calls that already appear nested under their sub-agent parent
            .filter((tc: any) => !tc.parentToolCallId || !subAgentStarts.has(tc.parentToolCallId));
          if (toolCalls!.length === 0) toolCalls = undefined;
        }

        // Include message if it has content or tool calls
        if (content.trim() || toolCalls) {
          messages.push({
            role: "assistant",
            content,
            timestamp: data.timestamp ?? (event as any).timestamp,
            toolCalls,
          });
        }
      }
    }

    console.log(`[sdk] Loaded ${messages.length} messages for session ${sessionId}`);
    return messages;
  }

  // Generate a concise session title via a lightweight LLM call
  private async generateSessionTitle(sessionId: string, userMessage: string, assistantResponse: string): Promise<void> {
    if (!this.client || sessionTitles.hasTitle(sessionId) || this.titleGenerationInFlight.has(sessionId)) return;
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
        sessionTitles.setTitle(sessionId, title);
        const bus = getOrCreateBus(sessionId);
        bus.emit({ type: "title_changed", title });
        globalBus.emit({ type: "session:title", sessionId, title });
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

  async shutdown(): Promise<void> {
    if (this.client) {
      console.log("[sdk] Shutting down Copilot SDK client...");
      await this.client.stop();
      this.client = null;
    }
  }
}
