// Copilot SDK session manager
// Universal tools — taskId is a parameter, same tools for every session

import { CopilotClient, approveAll, defineTool } from "@github/copilot-sdk";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import * as taskStore from "./task-store.js";
import { getOrCreateBus } from "./event-bus.js";
import * as sessionTitles from "./session-titles.js";
import * as globalBus from "./global-bus.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SIGNAL_FILE = join(__dirname, "..", "..", "data", "restart.signal");

// Module-level ref so universal tools can query session state
let _instance: SessionManager | null = null;

// Universal tools — same instance for every session
const BRIDGE_TOOLS = [
  defineTool("task_link_work_item", {
    description: "Link an ADO work item to a task by its ID",
    parameters: { type: "object", properties: { taskId: { type: "string", description: "The task ID" }, workItemId: { type: "number", description: "The ADO work item ID" } }, required: ["taskId", "workItemId"] },
    handler: async (args: any) => {
      taskStore.linkWorkItem(args.taskId, args.workItemId);
      return { success: true, message: `Work item #${args.workItemId} linked to task` };
    },
  }),
  defineTool("task_unlink_work_item", {
    description: "Remove an ADO work item from a task",
    parameters: { type: "object", properties: { taskId: { type: "string", description: "The task ID" }, workItemId: { type: "number", description: "The ADO work item ID" } }, required: ["taskId", "workItemId"] },
    handler: async (args: any) => {
      taskStore.unlinkWorkItem(args.taskId, args.workItemId);
      return { success: true, message: `Work item #${args.workItemId} unlinked from task` };
    },
  }),
  defineTool("task_link_pr", {
    description: "Link a pull request to a task",
    parameters: { type: "object", properties: { taskId: { type: "string", description: "The task ID" }, repoName: { type: "string", description: "Repository name" }, prId: { type: "number", description: "PR number" } }, required: ["taskId", "repoName", "prId"] },
    handler: async (args: any) => {
      taskStore.linkPR(args.taskId, { repoId: args.repoName, repoName: args.repoName, prId: args.prId });
      return { success: true, message: `PR #${args.prId} from ${args.repoName} linked to task` };
    },
  }),
  defineTool("task_unlink_pr", {
    description: "Remove a pull request from a task",
    parameters: { type: "object", properties: { taskId: { type: "string", description: "The task ID" }, repoName: { type: "string", description: "Repository name" }, prId: { type: "number", description: "PR number" } }, required: ["taskId", "repoName", "prId"] },
    handler: async (args: any) => {
      taskStore.unlinkPR(args.taskId, args.repoName, args.prId);
      return { success: true, message: `PR #${args.prId} from ${args.repoName} unlinked from task` };
    },
  }),
  defineTool("task_update_notes", {
    description: "Update a task's notes. Overwrites existing notes.",
    parameters: { type: "object", properties: { taskId: { type: "string", description: "The task ID" }, notes: { type: "string", description: "New notes content (markdown)" } }, required: ["taskId", "notes"] },
    handler: async (args: any) => {
      taskStore.updateTask(args.taskId, { notes: args.notes });
      return { success: true, message: "Task notes updated" };
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
    description: "List all tasks with their IDs, titles, and statuses",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      return { tasks: taskStore.listTasks().map((t) => ({ id: t.id, title: t.title, status: t.status })) };
    },
  }),
  defineTool("task_rename", {
    description: "Rename a task",
    parameters: { type: "object", properties: { taskId: { type: "string", description: "The task ID" }, title: { type: "string", description: "The new title" } }, required: ["taskId", "title"] },
    handler: async (args: any) => {
      taskStore.updateTask(args.taskId, { title: args.title });
      return { success: true, message: `Task renamed to "${args.title}"` };
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
  defineTool("session_rename", {
    description: "Rename a chat session. Use this to give a session a more descriptive title.",
    parameters: { type: "object", properties: { sessionId: { type: "string", description: "The session ID to rename" }, title: { type: "string", description: "The new title (3-6 words recommended)" } }, required: ["sessionId", "title"] },
    handler: async (args: any) => {
      sessionTitles.setTitle(args.sessionId, args.title);
      return { success: true, message: `Session renamed to "${args.title}"` };
    },
  }),
  defineTool("self_restart", {
    description: "Restart the Copilot Bridge server after making code changes. The launcher will auto-checkpoint, rebuild, and swap processes. Auto-rolls back on failure. The launcher performs a safe restart: it waits for all active sessions to finish before rebuilding (up to 5 minutes). IMPORTANT: This session counts as active — do not make further tool calls after invoking this, or you will block the restart.",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      const dataDir = join(__dirname, "..", "..", "data");
      if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
      writeFileSync(SIGNAL_FILE, new Date().toISOString());

      const otherBusy = _instance ? Math.max(0, _instance.getActiveSessions().length - 1) : 0;
      const waitNote = otherBusy > 0
        ? ` ${otherBusy} other session(s) are active — the launcher will wait for them to finish before rebuilding (up to 5 min).`
        : "";
      return {
        success: true,
        message: `Restart signal sent.${waitNote} Do NOT make any more tool calls — this session is considered active and will block the restart until it is idle.`,
      };
    },
  }),
];

export class SessionManager {
  private client: CopilotClient | null = null;
  private activeSessions = new Set<string>();
  private sessionObjects = new Map<string, any>(); // cached CopilotSession objects
  private titleGenerationInFlight = new Set<string>(); // prevent duplicate title generation

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
    return this.client.listSessions();
  }

  async createSession(): Promise<{ sessionId: string }> {
    if (!this.client) throw new Error("SessionManager not initialized");

    const session = await this.client.createSession({
      onPermissionRequest: approveAll,
      mcpServers: config.sessionMcpServers as any,
      tools: BRIDGE_TOOLS,
    });

    this.sessionObjects.set(session.sessionId, session);
    console.log(`[sdk] Created session ${session.sessionId}`);
    return { sessionId: session.sessionId };
  }

  async createTaskSession(taskId: string, taskTitle: string, workItemIds: number[], prDescriptions: string[], notes: string, cwd?: string): Promise<{ sessionId: string }> {
    if (!this.client) throw new Error("SessionManager not initialized");

    const isPlaceholder = taskTitle === "New Task";
    const contextParts = [
      `You are helping with task "${taskTitle}" (taskId: ${taskId}).`,
      "Use the task tools to manage linked resources when you discover relevant work items or PRs.",
    ];

    if (isPlaceholder) {
      contextParts.push(
        'This task was just created without a title. After reading the user\'s first message, call `task_rename` to give it a concise, descriptive title (3-6 words). Do this silently without mentioning it to the user.',
      );
    }

    if (cwd) {
      contextParts.push(`Task working directory: ${cwd}`);
    }
    if (workItemIds.length > 0) {
      contextParts.push(`Currently linked work items: ${workItemIds.map((id) => `#${id}`).join(", ")}.`);
    }
    if (prDescriptions.length > 0) {
      contextParts.push(`Currently linked PRs: ${prDescriptions.join(", ")}.`);
    }
    if (notes.trim()) {
      contextParts.push(`Task notes:\n${notes}`);
    }

    const session = await this.client.createSession({
      onPermissionRequest: approveAll,
      mcpServers: config.sessionMcpServers as any,
      tools: BRIDGE_TOOLS,
      systemMessage: {
        mode: "append",
        content: contextParts.join("\n"),
      },
    });

    this.sessionObjects.set(session.sessionId, session);
    console.log(`[sdk] Created task session ${session.sessionId} for "${taskTitle}"`);
    return { sessionId: session.sessionId };
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
    });
  }

  private async _doWork(sessionId: string, prompt: string, bus: ReturnType<typeof getOrCreateBus>): Promise<void> {
    const sid = sessionId.slice(0, 8);

    // Build resume config with optional task context
    const linkedTask = taskStore.findTaskBySessionId(sessionId);
    const resumeConfig: any = {
      onPermissionRequest: approveAll,
      tools: BRIDGE_TOOLS,
      mcpServers: config.sessionMcpServers,
    };

    if (linkedTask) {
      const contextParts = [
        `You are helping with task "${linkedTask.title}" (taskId: ${linkedTask.id}).`,
        `Task status: ${linkedTask.status}.`,
        "Use the task tools to manage linked resources when you discover relevant work items or PRs.",
      ];
      if (linkedTask.cwd) {
        contextParts.push(`Task working directory: ${linkedTask.cwd}`);
      }
      if (linkedTask.workItemIds.length > 0) {
        contextParts.push(`Currently linked work items: ${linkedTask.workItemIds.map((id: number) => `#${id}`).join(", ")}.`);
      }
      if (linkedTask.pullRequests.length > 0) {
        contextParts.push(`Currently linked PRs: ${linkedTask.pullRequests.map((pr: any) => `${pr.repoName || pr.repoId} #${pr.prId}`).join(", ")}.`);
      }
      if (linkedTask.notes.trim()) {
        contextParts.push(`Task notes:\n${linkedTask.notes}`);
      }
      resumeConfig.systemMessage = { mode: "append", content: contextParts.join("\n") };
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
          console.log(`[sdk] [${sid}] 🔧 Tool: ${toolName}`);
          bus.emit({
            type: "tool_start",
            toolCallId: data?.toolCallId,
            name: toolName,
            args: data?.arguments,
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
          bus.emit({ type: "tool_start", name: `🤖 ${data?.agentDisplayName ?? data?.agentName ?? "agent"}` });
          break;
        case "subagent.completed":
        case "subagent.failed":
          bus.emit({ type: "tool_done", name: `🤖 ${data?.agentDisplayName ?? data?.agentName ?? "agent"}` });
          break;
        case "session.error":
          console.error(`[sdk] [${sid}] ❌ Error: ${data?.message ?? "unknown"}`);
          bus.emit({ type: "error", message: data?.message ?? "unknown" });
          resolveWork();
          break;
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
          this.client.resumeSession(sessionId, {
            onPermissionRequest: approveAll,
            mcpServers: config.sessionMcpServers as any,
            tools: BRIDGE_TOOLS,
          }),
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
        this.client.resumeSession(sessionId, {
          onPermissionRequest: approveAll,
          mcpServers: config.sessionMcpServers as any,
          tools: BRIDGE_TOOLS,
        }),
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
    const toolStarts = new Map<string, { toolName: string; arguments?: Record<string, unknown> }>();
    const toolCompletes = new Map<string, { success: boolean; content?: string }>();
    for (const event of events) {
      const data = (event as any).data;
      if (event.type === "tool.execution_start" && data?.toolCallId) {
        toolStarts.set(data.toolCallId, { toolName: data.toolName, arguments: data.arguments });
      } else if (event.type === "tool.execution_complete" && data?.toolCallId) {
        toolCompletes.set(data.toolCallId, { success: data.success, content: data.result?.content });
      }
    }
    console.log(`[sdk] Indexed ${toolStarts.size} tool starts, ${toolCompletes.size} tool completes`);

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
        let toolCalls: Array<{ toolCallId: string; name: string; args?: Record<string, unknown>; result?: string; success?: boolean }> | undefined;
        if (data.toolRequests?.length) {
          toolCalls = data.toolRequests
            .filter((tr: any) => tr.name !== "report_intent")
            .map((tr: any) => {
              const start = toolStarts.get(tr.toolCallId);
              const complete = toolCompletes.get(tr.toolCallId);
              return {
                toolCallId: tr.toolCallId,
                name: tr.name,
                args: start?.arguments ?? tr.arguments,
                result: complete?.content,
                success: complete?.success,
              };
            });
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

    try {
      const titleSession = await this.client.createSession({ onPermissionRequest: approveAll });
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

      if (title && title.length > 0 && title.length <= 80) {
        sessionTitles.setTitle(sessionId, title);
        const bus = getOrCreateBus(sessionId);
        bus.emit({ type: "title_changed", title });
        globalBus.emit({ type: "session:title", sessionId, title });
        console.log(`[titles] [${sid}] Title: "${title}"`);
      } else {
        console.log(`[titles] [${sid}] Title generation returned invalid result: "${title}"`);
      }

      await this.client.deleteSession(titleSession.sessionId);
    } catch (err) {
      console.error(`[titles] [${sid}] Title generation failed:`, err);
    } finally {
      this.titleGenerationInFlight.delete(sessionId);
    }
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
