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
function parseMessages(raw: string): ParsedMessage[] {
  // The MCP tool returns structured data as text.
  // We'll parse what we can and adapt as we learn the actual format.
  // For now, return the raw text and refine after first real response.
  const messages: ParsedMessage[] = [];

  try {
    // Attempt JSON parse first — some MCP tools return JSON in text content
    const data = JSON.parse(raw);
    if (Array.isArray(data)) {
      for (const msg of data) {
        messages.push({
          id: msg.id ?? "",
          threadId: msg.id ?? "", // top-level messages are their own thread
          content: msg.body?.content ?? msg.content ?? "",
          senderName:
            msg.from?.user?.displayName ?? msg.from?.displayName ?? "unknown",
          createdDateTime: msg.createdDateTime ?? "",
        });
      }
      return messages;
    }
  } catch {
    // Not JSON — parse as structured text
  }

  // Fallback: treat the whole response as a single message description
  // This will be refined once we see actual MCP output format
  if (raw.trim()) {
    console.log(
      `[poller] Raw MCP response (first 500 chars): ${raw.slice(0, 500)}`,
    );
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
