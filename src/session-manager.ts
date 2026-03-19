// Copilot SDK session manager
// Thin wrapper around SDK's built-in session management — no in-memory state

import { CopilotClient, approveAll } from "@github/copilot-sdk";
import { config } from "./config.js";

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
