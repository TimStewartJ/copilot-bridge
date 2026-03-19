// Copilot SDK session manager
// Creates/resumes named sessions with full tool access

import { CopilotClient, approveAll } from "@github/copilot-sdk";
import type { AssistantMessageEvent } from "@github/copilot-sdk";
import { config } from "./config.js";

export interface SessionInfo {
  id: string;
  copilotSessionId: string;
  name: string;
  createdAt: string;
  lastUsed: string;
  messageCount: number;
}

export class SessionManager {
  private client: CopilotClient | null = null;
  // Maps our session ID → { copilotSessionId, metadata }
  private sessions = new Map<string, SessionInfo>();
  private activeSessions = new Map<string, boolean>(); // track if session is busy

  async initialize(): Promise<void> {
    console.log("[sdk] Initializing Copilot SDK client...");
    this.client = new CopilotClient();
    await this.client.start();
    console.log("[sdk] Copilot SDK client ready");
  }

  async createSession(name?: string): Promise<SessionInfo> {
    if (!this.client) throw new Error("SessionManager not initialized");

    const id = crypto.randomUUID();
    const sessionName = name || `Session ${this.sessions.size + 1}`;

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

    const info: SessionInfo = {
      id,
      copilotSessionId: session.sessionId,
      name: sessionName,
      createdAt: new Date().toISOString(),
      lastUsed: new Date().toISOString(),
      messageCount: 0,
    };

    this.sessions.set(id, info);
    console.log(`[sdk] Created session "${sessionName}" (${id})`);
    return info;
  }

  async sendMessage(
    sessionId: string,
    prompt: string,
  ): Promise<string> {
    if (!this.client) throw new Error("SessionManager not initialized");

    const info = this.sessions.get(sessionId);
    if (!info) throw new Error(`Session ${sessionId} not found`);

    if (this.activeSessions.get(sessionId)) {
      throw new Error("Session is busy processing another message");
    }

    this.activeSessions.set(sessionId, true);

    try {
      console.log(`[sdk] Resuming session ${info.copilotSessionId}...`);
      const session = await this.client.resumeSession(info.copilotSessionId, {
        onPermissionRequest: approveAll,
      });
      console.log(`[sdk] Session resumed, sending prompt (${prompt.length} chars)...`);

      // Log events for visibility
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
            // Log other event types at debug level
            if (!["assistant.message_delta", "assistant.streaming_delta", "assistant.reasoning_delta"].includes(event.type)) {
              console.log(`[sdk] 📡 Event: ${event.type}`);
            }
        }
      });

      const response = await session.sendAndWait(
        { prompt },
        600_000, // 10 min timeout
      );

      unsub();

      info.lastUsed = new Date().toISOString();
      info.messageCount++;

      return response?.data.content ?? "(no response)";
    } finally {
      this.activeSessions.set(sessionId, false);
    }
  }

  listSessions(): SessionInfo[] {
    return Array.from(this.sessions.values()).sort(
      (a, b) => new Date(b.lastUsed).getTime() - new Date(a.lastUsed).getTime(),
    );
  }

  getSession(sessionId: string): SessionInfo | undefined {
    return this.sessions.get(sessionId);
  }

  isSessionBusy(sessionId: string): boolean {
    return this.activeSessions.get(sessionId) ?? false;
  }

  async shutdown(): Promise<void> {
    if (this.client) {
      console.log("[sdk] Shutting down Copilot SDK client...");
      await this.client.stop();
      this.client = null;
    }
  }
}
