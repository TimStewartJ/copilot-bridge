import type { Attachment, ChatEntry, ChatMessage, ChatMessageDelivery } from "../../api";
import type { UnsentMessageView } from "../../../shared/unsent-message.js";
import { getLatestEntryActivityTimestamp } from "../../chat-cache";
import type { LivePendingUserMessage } from "../../useSessionStream";

/**
 * A message this page sent, from the moment Send is pressed until loaded history holds it.
 * `delivery` undefined means the server accepted it.
 */
export interface PendingSend {
  /** The browser's clientMessageId for this send. */
  id: string;
  content: string;
  attachments?: Attachment[];
  delivery?: ChatMessageDelivery;
  /**
   * Copied from the send's live copy, so the send can still be matched to history after the live
   * list has been replaced.
   */
  messageId?: string;
  sourceEventId?: string;
  timestamp?: string;
  /** This send is a not-sent message sent again; that message stays hidden while this one is around. */
  resendOf?: string;
}

/** What loaded history knows about saved user messages. */
export interface UserMessageHistory {
  clientMessageIds: ReadonlySet<string>;
  messageIds: ReadonlySet<string>;
  sourceEventIds: ReadonlySet<string>;
  /**
   * Newest activity in loaded history (NaN when there is none). Loaded history is a suffix of the
   * saved transcript, so anything at or before this time is saved even when it is not loaded.
   */
  watermarkMs: number;
}

export type UserMessageEntry = ChatMessage & { type: "message"; role: "user" };

export interface UserMessageMerge {
  /** Live copies history does not hold yet. They open the live overlay. */
  liveEntries: UserMessageEntry[];
  /** Sends with neither a saved nor a live copy, and failed sends. They close the live overlay. */
  placeholderEntries: UserMessageEntry[];
  /** Sends history already holds, which can be dropped. */
  settledIds: ReadonlySet<string>;
}

/**
 * True when `timestamp` is at or before the newest committed entry, meaning disk already carries
 * this item even if the loaded window does not reach it. Items with no timestamp are treated as
 * uncommitted, since an accepted-but-unpersisted prompt has none yet.
 */
export function isAtOrBeforeWatermark(timestamp: string | undefined, watermarkMs: number): boolean {
  if (!timestamp || !Number.isFinite(watermarkMs)) return false;
  const itemMs = Date.parse(timestamp);
  return Number.isFinite(itemMs) && itemMs <= watermarkMs;
}

function isUserMessageEntry(entry: ChatEntry): entry is ChatMessage & { type?: "message" } {
  return (!entry.type || entry.type === "message") && entry.role === "user";
}

/**
 * `unsent` are messages the agent never got that the chat keeps: they settle their live copies and
 * this page's sends like saved ones, but say nothing about how far saved history reaches.
 */
export function indexUserMessageHistory(
  entries: ChatEntry[],
  unsent: readonly UnsentMessageView[] = [],
): UserMessageHistory {
  const clientMessageIds = new Set<string>(unsent.map((message) => message.id));
  const messageIds = new Set<string>();
  const sourceEventIds = new Set<string>();
  for (const entry of entries) {
    if (!isUserMessageEntry(entry)) continue;
    if (entry.clientMessageId) clientMessageIds.add(entry.clientMessageId);
    if (entry.messageId) messageIds.add(entry.messageId);
    if (entry.sourceEventId) sourceEventIds.add(entry.sourceEventId);
  }
  const latest = getLatestEntryActivityTimestamp(entries);
  return {
    clientMessageIds,
    messageIds,
    sourceEventIds,
    watermarkMs: latest ? Date.parse(latest) : Number.NaN,
  };
}

function isSavedLiveCopy(message: LivePendingUserMessage, history: UserMessageHistory): boolean {
  return history.clientMessageIds.has(message.id)
    || (message.messageId !== undefined && history.messageIds.has(message.messageId))
    || (message.sourceEventId !== undefined && history.sourceEventIds.has(message.sourceEventId))
    || isAtOrBeforeWatermark(message.timestamp, history.watermarkMs);
}

function isSavedSend(send: PendingSend, history: UserMessageHistory): boolean {
  if (history.clientMessageIds.has(send.id)) return true;
  // A failed send keeps its Retry until history names it by the id it was sent with.
  if (send.delivery?.failed) return false;
  return (send.messageId !== undefined && history.messageIds.has(send.messageId))
    || (send.sourceEventId !== undefined && history.sourceEventIds.has(send.sourceEventId))
    || isAtOrBeforeWatermark(send.timestamp, history.watermarkMs);
}

/**
 * Copies what each send's live copy knows (its saved ids and time) onto the send. Only fills in
 * missing fields, and returns `placeholders` itself when nothing was learned.
 */
export function learnFromLive(
  placeholders: PendingSend[],
  live: readonly LivePendingUserMessage[],
): PendingSend[] {
  if (placeholders.length === 0 || live.length === 0) return placeholders;
  const liveById = new Map(live.map((message) => [message.id, message]));
  let changed = false;
  const next = placeholders.map((send) => {
    const message = liveById.get(send.id);
    if (!message) return send;
    const learned: Partial<PendingSend> = {};
    if (send.messageId === undefined && message.messageId !== undefined) learned.messageId = message.messageId;
    if (send.sourceEventId === undefined && message.sourceEventId !== undefined) {
      learned.sourceEventId = message.sourceEventId;
    }
    if (send.timestamp === undefined && message.timestamp !== undefined) learned.timestamp = message.timestamp;
    if (Object.keys(learned).length === 0) return send;
    changed = true;
    return { ...send, ...learned };
  });
  return changed ? next : placeholders;
}

/**
 * Decides which user-message bubbles the live overlay shows. Each message is matched to history by
 * id: the browser's clientMessageId, the runtime's messageId, or the saved event id, with the
 * history watermark for saved messages above the loaded window. A message history holds renders
 * from history only; otherwise its live copy renders, or else this page's placeholder.
 */
export function mergeUserMessages({ history, live, placeholders }: {
  history: UserMessageHistory;
  live: readonly LivePendingUserMessage[];
  placeholders: PendingSend[];
}): UserMessageMerge {
  const sends = learnFromLive(placeholders, live);
  const sendsById = new Map(sends.map((send) => [send.id, send]));
  const settledIds = new Set(sends.filter((send) => isSavedSend(send, history)).map((send) => send.id));
  const liveIds = new Set<string>();
  const liveEntries: UserMessageEntry[] = [];
  for (const message of live) {
    liveIds.add(message.id);
    if (isSavedLiveCopy(message, history)) continue;
    const send = sendsById.get(message.id);
    // The failed bubble, with its Retry, stands for this message.
    if (send?.delivery?.failed) continue;
    // A live copy means the server is running the message, so it is no longer queued.
    const delivery = send?.delivery?.queued || message.undelivered ? undefined : send?.delivery;
    liveEntries.push({
      id: `live-user-${message.id}`,
      type: "message",
      role: "user",
      content: message.content,
      ...(delivery ? { delivery } : {}),
      ...(message.undelivered ? { unsent: message.undelivered, clientMessageId: message.id } : {}),
      ...(message.attachments?.length ? { attachments: message.attachments } : {}),
      ...(message.timestamp ? { timestamp: message.timestamp } : {}),
    });
  }
  const placeholderEntries: UserMessageEntry[] = [];
  for (const send of sends) {
    if (settledIds.has(send.id)) continue;
    if (!send.delivery?.failed && liveIds.has(send.id)) continue;
    placeholderEntries.push({
      id: send.id,
      type: "message",
      role: "user",
      content: send.content,
      delivery: send.delivery,
      ...(send.attachments?.length ? { attachments: send.attachments } : {}),
      ...(send.timestamp ? { timestamp: send.timestamp } : {}),
    });
  }
  return { liveEntries, placeholderEntries, settledIds };
}

/** Returns the sends with what they learned from their live copies, minus those history holds. */
export function settlePendingSends(
  placeholders: PendingSend[],
  live: readonly LivePendingUserMessage[],
  history: UserMessageHistory,
): PendingSend[] {
  const learned = learnFromLive(placeholders, live);
  const { settledIds } = mergeUserMessages({ history, live, placeholders: learned });
  return settledIds.size === 0 ? learned : learned.filter((send) => !settledIds.has(send.id));
}

/** When an entry happened, for placing a not-sent message among them; undefined when it has no time. */
function entryStartTimestamp(entry: ChatEntry): number {
  const at = entry.type === "tool"
    ? entry.toolCall.startedAt ?? entry.toolCall.completedAt
    : "timestamp" in entry ? entry.timestamp : undefined;
  return at ? Date.parse(at) : Number.NaN;
}

/** A message the agent never got, as the chat shows it. */
export function unsentMessageEntry(message: UnsentMessageView): UserMessageEntry {
  return {
    id: `unsent-${message.id}`,
    type: "message",
    role: "user",
    content: message.content,
    clientMessageId: message.id,
    timestamp: message.createdAt,
    unsent: { state: message.state, ...(message.error ? { error: message.error } : {}) },
    ...(message.attachments?.length ? { attachments: message.attachments.map((attachment) => ({ ...attachment, size: attachment.size ?? 0 })) } : {}),
    ...(message.mode === "autopilot" ? { agentMode: "autopilot" as const } : {}),
  };
}

/**
 * Puts the messages the agent never got where they were sent: before the first saved entry that
 * happened after them, or after all of saved history. One older than everything loaded is left for
 * the older page it belongs to (`hasOlder`). `hidden` are ids being resent or discarded.
 */
export function placeUnsentMessages(
  entries: ChatEntry[],
  unsent: readonly UnsentMessageView[],
  { hasOlder, hidden }: { hasOlder: boolean; hidden?: ReadonlySet<string> },
): ChatEntry[] {
  const shown = unsent.filter((message) => !hidden?.has(message.id));
  if (shown.length === 0) return entries;
  const result = [...entries];
  // Newest first, so each insert leaves the positions of the older ones untouched.
  const ordered = [...shown].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  for (const message of ordered) {
    const at = Date.parse(message.createdAt);
    let index = entries.findIndex((entry) => entryStartTimestamp(entry) > at);
    if (index < 0) index = entries.length;
    if (index === 0 && hasOlder) continue;
    result.splice(index, 0, unsentMessageEntry(message));
  }
  return result;
}

/** Whether two reads returned the same not-sent messages, so a re-read keeps the old list. */
export function sameUnsentMessages(a: readonly UnsentMessageView[], b: readonly UnsentMessageView[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((message, index) => {
    const other = b[index]!;
    return message.id === other.id && message.state === other.state && message.error === other.error
      && message.content === other.content;
  });
}
