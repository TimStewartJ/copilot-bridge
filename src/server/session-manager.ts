// Copilot SDK session manager
// Universal tools — taskId is a parameter, same tools for every session

import { CopilotClient, approveAll, defineTool } from "@github/copilot-sdk";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import * as taskStore from "./task-store.js";
import { getOrCreateBus } from "./event-bus.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SIGNAL_FILE = join(__dirname, "..", "..", "data", "restart.signal");

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
  defineTool("self_restart", {
    description: "Restart the Copilot Bridge server after making code changes. The launcher will auto-checkpoint, rebuild, and swap processes. Auto-rolls back on failure.",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      const dataDir = join(__dirname, "..", "..", "data");
      if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
      writeFileSync(SIGNAL_FILE, new Date().toISOString());
      return { success: true, message: "Restart signal sent. Server will restart in ~15 seconds." };
    },
  }),
];

export class SessionManager {
  private client: CopilotClient | null = null;
  private activeSessions = new Set<string>();

  async initialize(): Promise<void> {
    console.log("[sdk] Initializing Copilot SDK client...");
    this.client = new CopilotClient();
    await this.client.start();
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

    console.log(`[sdk] Created session ${session.sessionId}`);
    return { sessionId: session.sessionId };
  }

  async createTaskSession(taskId: string, taskTitle: string, workItemIds: number[], prDescriptions: string[], notes: string): Promise<{ sessionId: string }> {
    if (!this.client) throw new Error("SessionManager not initialized");

    const contextParts = [
      `You are helping with task "${taskTitle}" (taskId: ${taskId}).`,
      "Use the task tools to manage linked resources when you discover relevant work items or PRs.",
    ];

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
    this.activeSessions.add(sessionId);

    // Run in background — not awaited
    this._doWork(sessionId, prompt, bus).catch((err) => {
      console.error(`[sdk] Unhandled error in session ${sessionId}:`, err);
      bus.emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
    }).finally(() => {
      this.activeSessions.delete(sessionId);
    });
  }

  private async _doWork(sessionId: string, prompt: string, bus: ReturnType<typeof getOrCreateBus>): Promise<void> {
    console.log(`[sdk] Resuming session ${sessionId}...`);

    // Build resume config with optional task context
    const linkedTask = taskStore.findTaskBySessionId(sessionId);
    const resumeConfig: any = {
      onPermissionRequest: approveAll,
      tools: BRIDGE_TOOLS,
    };

    if (linkedTask) {
      const contextParts = [
        `You are helping with task "${linkedTask.title}" (taskId: ${linkedTask.id}).`,
        `Task status: ${linkedTask.status}.`,
        "Use the task tools to manage linked resources when you discover relevant work items or PRs.",
      ];
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
      console.log(`[sdk] Injecting task context for "${linkedTask.title}"`);
    }

    const session = await this.client!.resumeSession(sessionId, resumeConfig);
    console.log(`[sdk] Session resumed, sending prompt (${prompt.length} chars)...`);

    const unsub = session.on((event) => {
      const data = (event as any).data;
      switch (event.type) {
        case "assistant.turn_start":
          console.log(`[sdk] ⏳ Turn started`);
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
          console.log(`[sdk] 🎯 Intent: ${data?.intent}`);
          bus.emit({ type: "intent", intent: data?.intent ?? "" });
          break;
        case "assistant.message":
          if (data?.content) {
            console.log(`[sdk] ✅ Response (${data.content.length} chars)`);
            if (data.toolRequests?.length) {
              bus.emit({ type: "assistant_partial", content: data.content });
            }
          }
          break;
        case "tool.execution_start": {
          const toolName = data?.toolName ?? data?.name ?? "unknown";
          console.log(`[sdk] 🔧 Tool: ${toolName}`);
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
          const completedToolName = data?.toolName ?? data?.name ?? "unknown";
          console.log(`[sdk] 🔧 Tool complete: ${completedToolName}`);
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
          console.error(`[sdk] ❌ Error: ${data?.message ?? "unknown"}`);
          bus.emit({ type: "error", message: data?.message ?? "unknown" });
          break;
        case "session.title_changed":
          bus.emit({ type: "title_changed", title: data?.title ?? "" });
          break;
        case "session.idle":
          console.log(`[sdk] 💤 Session idle`);
          break;
        default:
          break;
      }
    });

    try {
      const response = await session.sendAndWait({ prompt }, 600_000);
      const content = response?.data.content ?? "(no response)";
      console.log(`[sdk] Done: ${content.length} chars`);
      bus.emit({ type: "done", content });
    } finally {
      unsub();
    }
  }

  async getSessionMessages(sessionId: string): Promise<Array<{ role: string; content: string; timestamp?: string; toolCalls?: Array<{ toolCallId: string; name: string; args?: Record<string, unknown>; result?: string; success?: boolean }> }>> {
    if (!this.client) throw new Error("SessionManager not initialized");

    console.log(`[sdk] Loading messages for session ${sessionId}...`);
    const session = await this.client.resumeSession(sessionId, {
      onPermissionRequest: approveAll,
    });

    const events = await session.getMessages();
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
