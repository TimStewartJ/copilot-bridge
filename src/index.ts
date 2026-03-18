// Main entrypoint — wires together MCP client, poller, and Copilot SDK

import { config } from "./config.js";
import {
  startTeamsMcp,
  stopTeamsMcp,
  listChannelMessages,
  replyToChannelMessage,
  postChannelMessage,
} from "./mcp-client.js";
import { startPolling, stopPolling, setWatermark } from "./poller.js";
import { SessionManager } from "./session-manager.js";
import type { ParsedMessage } from "./poller.js";

const sessionManager = new SessionManager();

// Track our own messages so we don't reply to ourselves
const ourMessageIds = new Set<string>();

async function handleNewMessage(message: ParsedMessage): Promise<void> {
  // Skip our own messages
  if (ourMessageIds.has(message.id)) return;

  // Optional prefix filter
  if (config.messagePrefix) {
    if (!message.content.startsWith(config.messagePrefix)) return;
  }

  const { teamId, channelId } = config.teams;

  // Post a "thinking" indicator
  console.log(`[bridge] Processing: "${message.content.slice(0, 80)}"`);

  try {
    // Route to Copilot SDK — this is the only LLM call
    const response = await sessionManager.processMessage(
      message.threadId,
      message.content,
    );

    if (response) {
      // Reply in the thread (or as a new message if no thread)
      const replyResult = await replyToChannelMessage(
        teamId,
        channelId,
        message.id,
        response,
      );
      console.log(`[bridge] Reply posted`);
    } else {
      console.log(`[bridge] No response from Copilot`);
    }
  } catch (err) {
    console.error(`[bridge] Error:`, err);
    try {
      await replyToChannelMessage(
        teamId,
        channelId,
        message.id,
        `⚠️ Bridge error: ${err instanceof Error ? err.message : String(err)}`,
      );
    } catch {
      // Swallow reply errors
    }
  }
}

async function main(): Promise<void> {
  console.log("╔════════════════════════════════════════╗");
  console.log("║     Copilot Teams Bridge — PoC        ║");
  console.log("╚════════════════════════════════════════╝");
  console.log();

  // 1. Start Teams MCP server
  await startTeamsMcp();

  // 2. Initialize Copilot SDK
  await sessionManager.initialize();

  // 3. Set watermark to "now" so we don't process old messages
  //    Do an initial fetch to catch up, then set watermark to latest
  const { teamId, channelId } = config.teams;
  try {
    const raw = await listChannelMessages(teamId, channelId);
    // Set watermark to current time so we only process NEW messages
    setWatermark(new Date().toISOString());
    console.log("[bridge] Initial catch-up complete — watching for new messages only");
  } catch (err) {
    console.log("[bridge] No existing messages or error fetching — starting fresh");
    setWatermark(new Date().toISOString());
  }

  // 4. Start polling
  startPolling(
    teamId,
    channelId,
    config.polling.intervalMs,
    handleNewMessage,
  );

  console.log();
  console.log("[bridge] 🟢 Bridge is running. Post a message in Teams to test.");
  console.log("[bridge] Press Ctrl+C to stop.");
}

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\n[bridge] Shutting down...");
  stopPolling();
  await sessionManager.shutdown();
  stopTeamsMcp();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  stopPolling();
  await sessionManager.shutdown();
  stopTeamsMcp();
  process.exit(0);
});

main().catch((err) => {
  console.error("[bridge] Fatal error:", err);
  process.exit(1);
});
