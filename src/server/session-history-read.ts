import type { TransformedEntry } from "./event-transform.js";
import type { ReadMessagesFromDiskResult } from "./session-disk-reader.js";
import { isRecord } from "../shared/is-record.js";

export const SESSION_HISTORY_DEFAULT_LIMIT = 10;
export const SESSION_HISTORY_MAX_LIMIT = 40;
const SESSION_HISTORY_MAX_CHARS = 4_000;
/** Transcript entries a latest-page read scans for items before it reads the whole log. */
const SESSION_HISTORY_TAIL_ENTRIES = 400;

export interface SessionHistoryItem {
  offset: number;
  role: "user" | "assistant" | "agent";
  agent?: string;
  timestamp?: string;
  content: string;
  truncated?: boolean;
}

export interface SessionHistoryPage {
  items: SessionHistoryItem[];
  /** Items matching the query; set only when a query was given. */
  matches?: number;
  /** Pass as `before` to read the items just older than this page. */
  nextBefore?: number;
}

export interface SessionHistoryOptions {
  query?: string;
  before?: number;
  limit?: number;
}

type ReadTranscript = (
  sessionId: string,
  opts?: { limit?: number },
) => Promise<Pick<ReadMessagesFromDiskResult, "messages" | "total">>;

function readableItem(entry: TransformedEntry, offset: number): SessionHistoryItem | undefined {
  if (entry.type === "message" && (entry.role === "user" || entry.role === "assistant")
    && typeof entry.content === "string" && entry.content.trim() && !entry.progressUpdate) {
    return { offset, role: entry.role, timestamp: entry.timestamp, content: entry.content };
  }
  const call = entry.toolCall;
  if (entry.type === "tool" && call?.isSubAgent && !call.parentToolCallId
    && typeof call.result === "string" && call.result.trim()) {
    const args = isRecord(call.args) ? call.args : {};
    const name = [args.name, args.description, call.name].find((value) => typeof value === "string" && value.trim());
    return { offset, role: "agent", agent: name as string, timestamp: call.completedAt ?? entry.timestamp, content: call.result };
  }
  return undefined;
}

function clipContent(item: SessionHistoryItem, matchAt = 0): SessionHistoryItem {
  if (item.content.length <= SESSION_HISTORY_MAX_CHARS) return item;
  const start = Math.max(0, Math.min(matchAt - 500, item.content.length - SESSION_HISTORY_MAX_CHARS));
  const clipped = item.content.slice(start, start + SESSION_HISTORY_MAX_CHARS);
  return { ...item, content: `${start > 0 ? "…" : ""}${clipped}…`, truncated: true };
}

/** Messages and sub-agent results, oldest first, through the Bridge's transcript reader. */
export async function readSessionHistory(
  readTranscript: ReadTranscript,
  sessionId: string,
  options: SessionHistoryOptions = {},
): Promise<SessionHistoryPage> {
  const limit = Math.min(SESSION_HISTORY_MAX_LIMIT, Math.max(1, Math.floor(options.limit ?? SESSION_HISTORY_DEFAULT_LIMIT)));
  const tokens = (options.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const readable = (entries: TransformedEntry[], firstOffset: number) => entries
    .map((entry, index) => readableItem(entry, firstOffset + index))
    .filter((item): item is SessionHistoryItem => item !== undefined);

  let items: SessionHistoryItem[] | undefined;
  let windowStart = 0;
  if (options.before === undefined && tokens.length === 0) {
    const tail = await readTranscript(sessionId, { limit: SESSION_HISTORY_TAIL_ENTRIES });
    windowStart = Math.max(0, tail.total - tail.messages.length);
    const tailItems = readable(tail.messages, windowStart);
    if (tailItems.length >= limit || windowStart === 0) items = tailItems;
  }
  if (!items) {
    const all = await readTranscript(sessionId);
    windowStart = 0;
    items = readable(all.messages, 0).filter((item) => options.before === undefined || item.offset < options.before);
  }
  const matched = tokens.length === 0
    ? items.map((item) => ({ item, at: 0 }))
    : items.flatMap((item) => {
      const lower = item.content.toLowerCase();
      return tokens.every((token) => lower.includes(token)) ? [{ item, at: lower.indexOf(tokens[0]!) }] : [];
    });
  const page = matched.slice(-limit);
  const hasEarlier = page.length > 0 && (matched.length > page.length || windowStart > 0);
  return {
    items: page.map(({ item, at }) => clipContent(item, at)),
    ...(tokens.length > 0 ? { matches: matched.length } : {}),
    ...(hasEarlier ? { nextBefore: page[0]!.item.offset } : {}),
  };
}
