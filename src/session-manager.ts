// Copilot SDK session manager
// Creates/resumes sessions per Teams thread so follow-ups maintain context

import { CopilotClient, approveAll } from "@github/copilot-sdk";
import type { AssistantMessageEvent } from "@github/copilot-sdk";
import { config } from "./config.js";

export class SessionManager {
  private client: CopilotClient | null = null;
  // Maps Teams thread (root message ID) → Copilot session ID
  private threadSessionMap = new Map<string, string>();

  async initialize(): Promise<void> {
    console.log("[sdk] Initializing Copilot SDK client...");
    this.client = new CopilotClient();
    await this.client.start();
    console.log("[sdk] Copilot SDK client ready");
  }

  async processMessage(
    threadId: string,
    prompt: string,
  ): Promise<string | undefined> {
    if (!this.client) throw new Error("SessionManager not initialized");

    const existingSessionId = this.threadSessionMap.get(threadId);

    try {
      if (existingSessionId) {
        return await this.resumeAndSend(existingSessionId, prompt);
      } else {
        return await this.createAndSend(threadId, prompt);
      }
    } catch (err) {
      console.error(`[sdk] Error processing message:`, err);
      return `⚠️ Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private async createAndSend(
    threadId: string,
    prompt: string,
  ): Promise<string | undefined> {
    console.log(`[sdk] Creating new session for thread ${threadId}`);

    const session = await this.client!.createSession({
      onPermissionRequest: approveAll,
      mcpServers: config.sessionMcpServers as any,
      systemMessage: {
        mode: "append",
        content: [
          "You are a helpful assistant responding to requests from a Microsoft Teams channel.",
          "Be concise — your responses will be posted back into Teams.",
          "If a task requires multiple steps, summarize what you did at the end.",
        ].join("\n"),
      },
    });

    this.threadSessionMap.set(threadId, session.sessionId);
    console.log(
      `[sdk] Session ${session.sessionId} created, mapped to thread ${threadId}`,
    );

    const response = await session.sendAndWait(
      { prompt },
      300_000, // 5 min timeout
    );

    return this.extractResponseText(response);
  }

  private async resumeAndSend(
    sessionId: string,
    prompt: string,
  ): Promise<string | undefined> {
    console.log(`[sdk] Resuming session ${sessionId}`);

    const session = await this.client!.resumeSession(sessionId, {
      onPermissionRequest: approveAll,
    });

    const response = await session.sendAndWait(
      { prompt },
      300_000,
    );

    return this.extractResponseText(response);
  }

  private extractResponseText(
    response: AssistantMessageEvent | undefined,
  ): string | undefined {
    if (!response) return undefined;
    return response.data.content;
  }

  async shutdown(): Promise<void> {
    if (this.client) {
      console.log("[sdk] Shutting down Copilot SDK client...");
      await this.client.stop();
      this.client = null;
    }
  }
}
