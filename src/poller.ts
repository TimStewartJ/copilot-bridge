// Polling loop — watches Teams channel for new messages via direct MCP calls
// Zero LLM cost — just JSON-RPC to the Teams MCP server

import { listChannelMessages } from "./mcp-client.js";

export interface ParsedMessage {
  id: string;
  threadId: string; // root message ID (for threading replies)
  content: string;
  senderName: string;
  createdDateTime: string;
}

type OnNewMessage = (message: ParsedMessage) => void | Promise<void>;

let lastSeenTimestamp: string | null = null;
let pollingTimer: ReturnType<typeof setInterval> | null = null;
let isPolling = false;

/**
 * Parse the raw text response from the Teams MCP tool into structured messages.
 * The MCP returns a text blob — we parse out individual messages.
 */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function parseMessages(raw: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  try {
    // The MCP tool may append metadata lines (e.g., CorrelationId) after the JSON
    // Extract the JSON portion by finding the first { and matching to its closing }
    let jsonStr = raw;
    const jsonStart = raw.indexOf("{");
    if (jsonStart >= 0) {
      // Find the matching closing brace by tracking depth
      let depth = 0;
      let jsonEnd = -1;
      for (let i = jsonStart; i < raw.length; i++) {
        if (raw[i] === "{") depth++;
        else if (raw[i] === "}") {
          depth--;
          if (depth === 0) {
            jsonEnd = i + 1;
            break;
          }
        }
      }
      if (jsonEnd > 0) jsonStr = raw.slice(jsonStart, jsonEnd);
    }
    const data = JSON.parse(jsonStr);

    // Format: {"messages": [...]}
    const msgArray = data.messages ?? (Array.isArray(data) ? data : []);

    for (const msg of msgArray) {
      const bodyContent = msg.body?.content ?? msg.content ?? "";
      const plainText = stripHtml(bodyContent);

      // Skip system events (e.g., <systemEventMessage/>)
      if (!plainText || bodyContent.includes("systemEventMessage")) continue;

      // Skip messages with no sender (system-generated)
      const senderName =
        msg.from?.user?.displayName ?? msg.from?.displayName ?? null;
      if (!senderName) continue;

      messages.push({
        id: msg.id ?? "",
        threadId: msg.id ?? "",
        content: plainText,
        senderName,
        createdDateTime: msg.createdDateTime ?? "",
      });
    }
  } catch {
    if (raw.trim()) {
      console.log(`[poller] Unparseable MCP response: ${raw.slice(0, 200)}`);
    }
  }

  return messages;
}

export function startPolling(
  teamId: string,
  channelId: string,
  intervalMs: number,
  onNewMessage: OnNewMessage,
): void {
  console.log(
    `[poller] Starting polling every ${intervalMs / 1000}s for channel ${channelId.slice(0, 30)}...`,
  );

  async function poll() {
    if (isPolling) return; // skip if previous poll still running
    isPolling = true;

    try {
      const raw = await listChannelMessages(teamId, channelId);
      const messages = parseMessages(raw);

      if (messages.length === 0) {
        isPolling = false;
        return;
      }

      // Sort by time ascending
      messages.sort(
        (a, b) =>
          new Date(a.createdDateTime).getTime() -
          new Date(b.createdDateTime).getTime(),
      );

      for (const msg of messages) {
        // Skip if we've already seen this message (by timestamp)
        if (
          lastSeenTimestamp &&
          msg.createdDateTime &&
          msg.createdDateTime <= lastSeenTimestamp
        ) {
          continue;
        }

        // Skip empty messages and system events
        if (!msg.content.trim()) continue;

        console.log(
          `[poller] New message from ${msg.senderName}: ${msg.content.slice(0, 80)}...`,
        );

        try {
          await onNewMessage(msg);
        } catch (err) {
          console.error(`[poller] Error handling message ${msg.id}:`, err);
        }
      }

      // Update watermark to latest message timestamp
      const latest = messages[messages.length - 1];
      if (latest?.createdDateTime) {
        lastSeenTimestamp = latest.createdDateTime;
      }
    } catch (err) {
      console.error("[poller] Poll error:", err);
    } finally {
      isPolling = false;
    }
  }

  // Run first poll immediately, then on interval
  poll();
  pollingTimer = setInterval(poll, intervalMs);
}

export function stopPolling(): void {
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
    console.log("[poller] Polling stopped");
  }
}

/**
 * Set the initial watermark so we don't process historical messages on startup.
 * Call this after the first listChannelMessages to "catch up" without acting.
 */
export function setWatermark(timestamp: string): void {
  lastSeenTimestamp = timestamp;
  console.log(`[poller] Watermark set to ${timestamp}`);
}
