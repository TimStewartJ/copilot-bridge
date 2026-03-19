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
import { marked } from "marked";
import type { ParsedMessage } from "./poller.js";

const sessionManager = new SessionManager();

// Marker prefix for all bridge replies — used to detect and skip our own messages
const BRIDGE_MARKER = "🤖 ";

async function handleNewMessage(message: ParsedMessage): Promise<void> {
  // Skip our own messages (by marker prefix)
  if (message.content.startsWith(BRIDGE_MARKER) || message.content.startsWith("🤖")) return;

  // Optional prefix filter
  if (config.messagePrefix) {
    if (!message.content.startsWith(config.messagePrefix)) return;
  }

  const { teamId, channelId } = config.teams;

  console.log(`[bridge] Processing: "${message.content.slice(0, 80)}"`);

  try {
    // Use a single session for the whole channel (flat mode — no threads)
    const response = await sessionManager.processMessage(
      "copilot-bridge-channel",
      message.content,
    );

    if (response) {
      const html = await marked.parse(response);
      await replyToChannelMessage(
        teamId,
        channelId,
        message.id,
        `🤖 ${html}`,
        "html",
      );
      console.log(`[bridge] Reply posted in thread ${message.id}`);
    }else {
      console.log(`[bridge] No response from Copilot`);
    }
  } catch (err) {
    console.error(`[bridge] Error:`, err);
    try {
      const errHtml = `🤖 ⚠️ Bridge error: ${err instanceof Error ? err.message : String(err)}`;
      await replyToChannelMessage(
        teamId,
        channelId,
        message.id,
        errHtml,
        "html",
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
