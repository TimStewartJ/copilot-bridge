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
// Track content fingerprints of messages we've sent to detect echoes
const sentContentFingerprints = new Set<string>();

function normalizeContent(content: string): string {
  return content.replace(/\s+/g, " ").trim().toLowerCase();
}

function extractMessageId(responseText: string): string | null {
  try {
    const jsonStart = responseText.indexOf("{");
    if (jsonStart < 0) return null;
    let depth = 0;
    let jsonEnd = -1;
    for (let i = jsonStart; i < responseText.length; i++) {
      if (responseText[i] === "{") depth++;
      else if (responseText[i] === "}") {
        depth--;
        if (depth === 0) {
          jsonEnd = i + 1;
          break;
        }
      }
    }
    if (jsonEnd <= 0) return null;
    const data = JSON.parse(responseText.slice(jsonStart, jsonEnd));
    return data.id ?? data.message?.id ?? null;
  } catch {
    return null;
  }
}

function trackSentContent(content: string): void {
  sentContentFingerprints.add(normalizeContent(content));
  // Prevent memory leak — cap at 200 entries
  if (sentContentFingerprints.size > 200) {
    const oldest = sentContentFingerprints.values().next().value;
    if (oldest) sentContentFingerprints.delete(oldest);
  }
}

async function handleNewMessage(message: ParsedMessage): Promise<void> {
  // Skip our own messages (by tracked message ID)
  if (ourMessageIds.has(message.id)) return;

  // Skip echoes of our own messages (by content fingerprint)
  const fingerprint = normalizeContent(message.content);
  if (sentContentFingerprints.has(fingerprint)) {
    console.log(
      `[bridge] Skipping echo: "${message.content.slice(0, 60)}..."`,
    );
    sentContentFingerprints.delete(fingerprint);
    return;
  }

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
      // Track the content so we recognize it as ours when polled back
      trackSentContent(response);

      const replyResult = await postChannelMessage(
        teamId,
        channelId,
        response,
      );

      // Try to extract the posted message ID for ID-based dedup
      const postedId = extractMessageId(replyResult);
      if (postedId) ourMessageIds.add(postedId);

      console.log(`[bridge] Reply posted`);
    } else {
      console.log(`[bridge] No response from Copilot`);
    }
  } catch (err) {
    console.error(`[bridge] Error:`, err);
    try {
      const errMsg = `⚠️ Bridge error: ${err instanceof Error ? err.message : String(err)}`;
      trackSentContent(errMsg);
      await postChannelMessage(teamId, channelId, errMsg);
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
