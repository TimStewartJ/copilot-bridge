// Copilot SDK session manager
// Thin wrapper around SDK's built-in session management — no in-memory state

import { CopilotClient, approveAll, defineTool } from "@github/copilot-sdk";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import * as taskStore from "./task-store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SIGNAL_FILE = join(__dirname, "..", "..", "data", "restart.signal");

export class SessionManager {
  private client: CopilotClient | null = null;
  private activeSessions = new Set<string>(); // track busy sessions

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

  async createSession(name?: string): Promise<{ sessionId: string }> {
    if (!this.client) throw new Error("SessionManager not initialized");

    const session = await this.client.createSession({
      onPermissionRequest: approveAll,
      mcpServers: config.sessionMcpServers as any,
      systemMessage: {
        mode: "append",
        content: [
          "You are a helpful assistant accessible via a web interface.",
          "Be concise but thorough. Use markdown formatting for readability.",
          "You have access to ADO, GitHub, and local tools.",
        ].join("\n"),
      },
    });

    // Rename if a name was provided
    console.log(`[sdk] Created session ${session.sessionId}${name ? ` ("${name}")` : ""}`);
    return { sessionId: session.sessionId };
  }

  async createTaskSession(taskId: string, taskTitle: string, workItemIds: number[], prDescriptions: string[], notes: string): Promise<{ sessionId: string }> {
    if (!this.client) throw new Error("SessionManager not initialized");

    const contextParts = [`You are helping with the task: "${taskTitle}".`];

    if (workItemIds.length > 0) {
      contextParts.push(`Related ADO work items: ${workItemIds.map((id) => `#${id}`).join(", ")}.`);
    }
    if (prDescriptions.length > 0) {
      contextParts.push(`Related PRs: ${prDescriptions.join(", ")}.`);
    }
    if (notes.trim()) {
      contextParts.push(`Task notes:\n${notes}`);
    }

    contextParts.push(
      "You have tools to manage this task: link/unlink work items, PRs, and update task notes. Use them proactively when you discover relevant resources.",
    );

    const taskTools = [
      defineTool("task_link_work_item", {
        description: "Link an ADO work item to the current task by its ID",
        parameters: { type: "object", properties: { workItemId: { type: "number", description: "The ADO work item ID to link" } }, required: ["workItemId"] },
        handler: async (args: any) => {
          taskStore.linkWorkItem(taskId, args.workItemId);
          return { success: true, message: `Work item #${args.workItemId} linked to task` };
        },
      }),
      defineTool("task_unlink_work_item", {
        description: "Remove an ADO work item from the current task",
        parameters: { type: "object", properties: { workItemId: { type: "number", description: "The ADO work item ID to unlink" } }, required: ["workItemId"] },
        handler: async (args: any) => {
          taskStore.unlinkWorkItem(taskId, args.workItemId);
          return { success: true, message: `Work item #${args.workItemId} unlinked from task` };
        },
      }),
      defineTool("task_link_pr", {
        description: "Link a pull request to the current task",
        parameters: { type: "object", properties: { repoName: { type: "string", description: "Repository name" }, prId: { type: "number", description: "Pull request number" } }, required: ["repoName", "prId"] },
        handler: async (args: any) => {
          taskStore.linkPR(taskId, { repoId: args.repoName, repoName: args.repoName, prId: args.prId });
          return { success: true, message: `PR #${args.prId} from ${args.repoName} linked to task` };
        },
      }),
      defineTool("task_unlink_pr", {
        description: "Remove a pull request from the current task",
        parameters: { type: "object", properties: { repoName: { type: "string", description: "Repository name" }, prId: { type: "number", description: "Pull request number" } }, required: ["repoName", "prId"] },
        handler: async (args: any) => {
          taskStore.unlinkPR(taskId, args.repoName, args.prId);
          return { success: true, message: `PR #${args.prId} from ${args.repoName} unlinked from task` };
        },
      }),
      defineTool("task_update_notes", {
        description: "Update the task's notes with new information, decisions, or observations. Overwrites existing notes.",
        parameters: { type: "object", properties: { notes: { type: "string", description: "The new notes content (markdown)" } }, required: ["notes"] },
        handler: async (args: any) => {
          taskStore.updateTask(taskId, { notes: args.notes });
          return { success: true, message: "Task notes updated" };
        },
      }),
      defineTool("task_get_info", {
        description: "Get the current task details including title, status, linked work items, PRs, and notes",
        parameters: { type: "object", properties: {} },
        handler: async () => {
          const task = taskStore.getTask(taskId);
          return task ?? { error: "Task not found" };
        },
      }),
      defineTool("self_restart", {
        description: "Restart the Copilot Bridge server after making code changes. The launcher will auto-checkpoint (git commit), rebuild (vite + tsc), and swap processes. If the build fails or health check fails, it auto-rolls back. Only use after you've finished editing and verified the build passes.",
        parameters: { type: "object", properties: {} },
        handler: async () => {
          const dataDir = join(__dirname, "..", "..", "data");
          if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
          writeFileSync(SIGNAL_FILE, new Date().toISOString());
          return { success: true, message: "Restart signal sent. The launcher will rebuild and restart the server in ~15 seconds. This session will remain available after restart." };
        },
      }),
    ];

    const session = await this.client.createSession({
      onPermissionRequest: approveAll,
      mcpServers: config.sessionMcpServers as any,
      tools: taskTools,
      systemMessage: {
        mode: "append",
        content: contextParts.join("\n"),
      },
    });

    console.log(`[sdk] Created task session ${session.sessionId} for "${taskTitle}" with ${taskTools.length} task tools`);
    return { sessionId: session.sessionId };
  }

  async sendMessage(sessionId: string, prompt: string): Promise<string> {
    if (!this.client) throw new Error("SessionManager not initialized");

    if (this.activeSessions.has(sessionId)) {
      throw new Error("Session is busy processing another message");
    }

    this.activeSessions.add(sessionId);

    try {
      console.log(`[sdk] Resuming session ${sessionId}...`);
      const session = await this.client.resumeSession(sessionId, {
        onPermissionRequest: approveAll,
      });
      console.log(`[sdk] Session resumed, sending prompt (${prompt.length} chars)...`);

      const unsub = session.on((event) => {
        switch (event.type) {
          case "assistant.turn_start":
            console.log(`[sdk] ⏳ Turn started`);
            break;
          case "assistant.message":
            console.log(`[sdk] ✅ Response received (${(event as any).data?.content?.length ?? 0} chars)`);
            break;
          case "tool.execution_start":
            console.log(`[sdk] 🔧 Tool: ${(event as any).data?.name ?? "unknown"}`);
            break;
          case "tool.execution_complete":
            console.log(`[sdk] 🔧 Tool complete: ${(event as any).data?.name ?? "unknown"}`);
            break;
          case "session.error":
            console.error(`[sdk] ❌ Error: ${(event as any).data?.message ?? "unknown"}`);
            break;
          case "session.idle":
            console.log(`[sdk] 💤 Session idle`);
            break;
          default:
            if (!["assistant.message_delta", "assistant.streaming_delta", "assistant.reasoning_delta"].includes(event.type)) {
              console.log(`[sdk] 📡 Event: ${event.type}`);
            }
        }
      });

      const response = await session.sendAndWait(
        { prompt },
        600_000,
      );

      unsub();
      return response?.data.content ?? "(no response)";
    } finally {
      this.activeSessions.delete(sessionId);
    }
  }

  async getSessionMessages(sessionId: string): Promise<Array<{ role: string; content: string; timestamp?: string }>> {
    if (!this.client) throw new Error("SessionManager not initialized");

    console.log(`[sdk] Loading messages for session ${sessionId}...`);
    const session = await this.client.resumeSession(sessionId, {
      onPermissionRequest: approveAll,
    });

    const events = await session.getMessages();
    const messages: Array<{ role: string; content: string; timestamp?: string }> = [];

    for (const event of events) {
      if (event.type === "user.message") {
        const data = event.data as any;
        const content = data.content ?? data.prompt ?? "";
        if (content.trim()) {
          messages.push({
            role: "user",
            content,
            timestamp: data.timestamp ?? (event as any).timestamp,
          });
        }
      } else if (event.type === "assistant.message") {
        const data = event.data as any;
        const content = data.content ?? "";
        if (content.trim()) {
          messages.push({
            role: "assistant",
            content,
            timestamp: data.timestamp ?? (event as any).timestamp,
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

  async shutdown(): Promise<void> {
    if (this.client) {
      console.log("[sdk] Shutting down Copilot SDK client...");
      await this.client.stop();
      this.client = null;
    }
  }
}
