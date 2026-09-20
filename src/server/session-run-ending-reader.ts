import { open, stat } from "node:fs/promises";
import { getSdkAgentId, getSdkEventId } from "./sdk-event-identity.js";

const MAX_TAIL_BYTES = 8 * 1024 * 1024;

/** After one of these the main agent cannot continue the run, whatever else is happening. */
const CONCLUSIVE_ENDING_TYPES = new Set(["session.error", "abort", "session.shutdown"]);

/**
 * How events.jsonl says a run ended. It never says *whether* the run ended: that is the
 * runtime's call (`AgentSession.getActivity`).
 */
export interface PersistedRunEnding {
  /** The main agent's ending event since the run started, when the log has one. */
  event?: any;
  /**
   * An error, abort or shutdown ends the run by itself. A turn end does not, because the runtime
   * may start the next turn on its own (autopilot, or a background task that just finished).
   */
  conclusive: boolean;
  /** The main agent's last reply since the run started. */
  assistantContent?: string;
  assistantSourceEventId?: string;
}

function getEventTimestampMs(event: any): number | undefined {
  const rawTimestamp = event?.data?.timestamp ?? event?.timestamp;
  if (typeof rawTimestamp !== "string") return undefined;
  const eventTime = Date.parse(rawTimestamp);
  return Number.isFinite(eventTime) ? eventTime : undefined;
}

async function readBoundedTail(eventsPath: string): Promise<string> {
  const fileStat = await stat(eventsPath);
  if (fileStat.size === 0) return "";
  const bytesToRead = Math.min(fileStat.size, MAX_TAIL_BYTES);
  const position = fileStat.size - bytesToRead;
  const buffer = Buffer.alloc(bytesToRead);
  const file = await open(eventsPath, "r");
  try {
    const { bytesRead } = await file.read(buffer, 0, bytesToRead, position);
    let content = buffer.subarray(0, bytesRead).toString("utf-8");
    if (position > 0) {
      const firstNewline = content.indexOf("\n");
      content = firstNewline >= 0 ? content.slice(firstNewline + 1) : "";
    }
    return content;
  } finally {
    await file.close();
  }
}

/**
 * Reads how the main agent's run ended. Sub-agents write to the same log, and their turns and
 * errors end nothing but themselves, so every event that carries an `agentId` is skipped. The
 * first conclusive ending wins; otherwise the ending is the main agent's last turn end.
 */
export async function readPersistedRunEnding(
  eventsPath: string,
  runStartedAt: number,
): Promise<PersistedRunEnding> {
  const ending: PersistedRunEnding = { conclusive: false };
  let raw: string;
  try {
    raw = await readBoundedTail(eventsPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return ending;
    throw error;
  }

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof event?.type !== "string" || getSdkAgentId(event)) continue;
    const eventTime = getEventTimestampMs(event);
    if (eventTime === undefined || eventTime < runStartedAt) continue;

    if (event.type === "assistant.message") {
      // Runtimes that predate `agentId` mark a sub-agent's reply with its parent tool call.
      if (event.data?.parentToolCallId || typeof event.data?.content !== "string") continue;
      ending.assistantContent = event.data.content;
      ending.assistantSourceEventId = getSdkEventId(event);
    } else if (ending.conclusive) {
      continue;
    } else if (CONCLUSIVE_ENDING_TYPES.has(event.type)) {
      ending.event = event;
      ending.conclusive = true;
    } else if (event.type === "assistant.turn_end") {
      ending.event = event;
    }
  }
  return ending;
}
