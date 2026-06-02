import type { QueryClient } from "@tanstack/react-query";
import type { Attachment, ChatCompletionEntry, ChatEntry, ChatMessage, ToolCall } from "./api";
import { queryKeys } from "./queryClient";

const MAX_CACHED_SESSIONS = 5;
const recentSessionIds: string[] = [];
const CLIENT_GENERATED_ID_PREFIXES = ["stream-", "local-", "err-", "draft-"] as const;

export interface ChatHistorySnapshot {
  sessionId: string;
  entries: ChatEntry[];
  firstItemIndex: number;
  total: number;
  hasMore: boolean;
  fetchedAt: number;
  isCanonical: boolean;
  lastVisibleActivityAt?: string;
}

function cloneAttachment(attachment: Attachment): Attachment {
  return { ...attachment };
}

function cloneToolCall(toolCall: ToolCall): ToolCall {
  return {
    ...toolCall,
    childToolCalls: toolCall.childToolCalls?.map((child) => cloneToolCall(child)),
  };
}

function cloneChatEntry(entry: ChatEntry): ChatEntry {
  if (entry.type === "tool") {
    return {
      ...entry,
      toolCall: entry.toolCall ? cloneToolCall(entry.toolCall) : entry.toolCall,
    };
  }

  if (entry.type === "visual") {
    return { ...entry };
  }

  if (entry.type === "completion") {
    return {
      ...entry,
      completion: { ...entry.completion },
    };
  }

  return {
    ...entry,
    attachments: entry.attachments?.map((attachment) => cloneAttachment(attachment)),
    toolCalls: entry.toolCalls?.map((toolCall) => cloneToolCall(toolCall)),
  };
}

function cloneSnapshot(snapshot: ChatHistorySnapshot): ChatHistorySnapshot {
  return {
    ...snapshot,
    entries: snapshot.entries.map((entry) => cloneChatEntry(entry)),
  };
}

function forgetSession(sessionId: string): void {
  const index = recentSessionIds.indexOf(sessionId);
  if (index >= 0) recentSessionIds.splice(index, 1);
}

function touchSession(sessionId: string): void {
  forgetSession(sessionId);
  recentSessionIds.push(sessionId);
}

function pruneSessions(queryClient: QueryClient): void {
  while (recentSessionIds.length > MAX_CACHED_SESSIONS) {
    const evictedSessionId = recentSessionIds.shift();
    if (!evictedSessionId) break;
    queryClient.removeQueries({ queryKey: queryKeys.chatMessages(evictedSessionId), exact: true });
  }
}

export function resetCachedChatSnapshotState(): void {
  recentSessionIds.splice(0, recentSessionIds.length);
}

export function getCachedChatSnapshot(queryClient: QueryClient, sessionId: string): ChatHistorySnapshot | undefined {
  const snapshot = queryClient.getQueryData<ChatHistorySnapshot>(queryKeys.chatMessages(sessionId));
  if (!snapshot) {
    forgetSession(sessionId);
    return undefined;
  }
  touchSession(sessionId);
  return cloneSnapshot(snapshot);
}

export function setCachedChatSnapshot(queryClient: QueryClient, snapshot: ChatHistorySnapshot): void {
  if (!snapshot.isCanonical) return;
  queryClient.setQueryData(queryKeys.chatMessages(snapshot.sessionId), cloneSnapshot(snapshot));
  touchSession(snapshot.sessionId);
  pruneSessions(queryClient);
}

export function hasOptimisticTail(currentFirstItemIndex: number, entryCount: number, total: number): boolean {
  return currentFirstItemIndex + entryCount > total;
}

export function isClientGeneratedEntry(entry: ChatEntry): boolean {
  const { id } = entry;
  return typeof id === "string" && CLIENT_GENERATED_ID_PREFIXES.some((prefix) => id.startsWith(prefix));
}

export function hasClientGeneratedEntries(entries: ChatEntry[]): boolean {
  return entries.some((entry) => isClientGeneratedEntry(entry));
}

function isUnsafeCommittedClientEntry(entry: ChatEntry): boolean {
  if (!isClientGeneratedEntry(entry)) return false;
  if (entry.type === "tool") return false;
  if (entry.type === "visual") return false;
  if (entry.type === "completion") return false;
  if (entry.role === "user") return false;
  if (typeof entry.content !== "string") return false;
  return entry.content.startsWith("⚠️ Error:")
    || entry.content.includes("*(stopped)*")
    || entry.content.includes("*(interrupted)*");
}

export function normalizeCommittedClientEntries(
  entries: ChatEntry[],
  firstItemIndex: number,
  total: number,
): ChatEntry[] {
  return entries.map((entry, index) => {
    if (firstItemIndex + index >= total) return entry;
    if (!isClientGeneratedEntry(entry) || isUnsafeCommittedClientEntry(entry)) return entry;
    return { ...entry, id: undefined };
  });
}

function findLastMessage(entries: ChatEntry[]): ChatMessage | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type === "visual" || entry?.type === "tool" || entry?.type === "completion") continue;
    return entry;
  }
  return undefined;
}

function findLastCompletion(entries: ChatEntry[]): ChatCompletionEntry | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type === "completion") return entry;
  }
  return undefined;
}

function findLastToolEntryIndex(entries: ChatEntry[], toolCallId: string): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type === "tool" && entry.toolCall?.toolCallId === toolCallId) {
      return index;
    }
  }
  return -1;
}

function hasMessageAfterIndex(entries: ChatEntry[], index: number): boolean {
  for (let currentIndex = index + 1; currentIndex < entries.length; currentIndex += 1) {
    const entry = entries[currentIndex];
    if (entry?.type === "visual") continue;
    if (entry?.type !== "tool") return true;
  }
  return false;
}

function mergeLiveToolEntry(existingEntry: Extract<ChatEntry, { type: "tool" }>, incomingEntry: Extract<ChatEntry, { type: "tool" }>): Extract<ChatEntry, { type: "tool" }> {
  return {
    ...existingEntry,
    ...incomingEntry,
    id: existingEntry.id ?? incomingEntry.id,
    toolCall: {
      ...existingEntry.toolCall,
      ...incomingEntry.toolCall,
      toolCallId: incomingEntry.toolCall.toolCallId,
      name: incomingEntry.toolCall.name ?? existingEntry.toolCall.name,
      args: incomingEntry.toolCall.args ?? existingEntry.toolCall.args,
      result: incomingEntry.toolCall.result ?? existingEntry.toolCall.result,
      progressText: incomingEntry.toolCall.progressText ?? existingEntry.toolCall.progressText,
      success: incomingEntry.toolCall.success ?? existingEntry.toolCall.success,
      parentToolCallId: incomingEntry.toolCall.parentToolCallId ?? existingEntry.toolCall.parentToolCallId,
      isSubAgent: incomingEntry.toolCall.isSubAgent ?? existingEntry.toolCall.isSubAgent,
      childToolCalls: incomingEntry.toolCall.childToolCalls ?? existingEntry.toolCall.childToolCalls,
      startedAt: incomingEntry.toolCall.startedAt ?? existingEntry.toolCall.startedAt,
      completedAt: incomingEntry.toolCall.completedAt ?? existingEntry.toolCall.completedAt,
    },
  };
}

function isDuplicateLiveMessageEntry(previousEntries: ChatEntry[], incomingEntry: ChatEntry): boolean {
  if (incomingEntry.type === "tool" || incomingEntry.type === "visual" || incomingEntry.type === "completion") return false;
  const lastMessage = findLastMessage(previousEntries);
  return lastMessage?.role === incomingEntry.role && lastMessage?.content === incomingEntry.content;
}

function isDuplicateLiveCompletionEntry(previousEntries: ChatEntry[], incomingEntry: ChatCompletionEntry): boolean {
  const lastCompletion = findLastCompletion(previousEntries);
  return lastCompletion?.content === incomingEntry.content
    && lastCompletion.completion.sourceEventType === incomingEntry.completion.sourceEventType;
}

export function appendLiveEntries(previousEntries: ChatEntry[], incomingEntries: ChatEntry[]): ChatEntry[] {
  let nextEntries = previousEntries;

  for (const incomingEntry of incomingEntries) {
    if (incomingEntry.type === "tool") {
      const toolCallId = incomingEntry.toolCall?.toolCallId;
      if (toolCallId) {
        const existingToolIndex = findLastToolEntryIndex(nextEntries, toolCallId);
        const shouldMergeIntoExistingEntry = existingToolIndex >= 0
          && (incomingEntry.liveSource === "snapshot" || !hasMessageAfterIndex(nextEntries, existingToolIndex));
        if (shouldMergeIntoExistingEntry) {
          if (nextEntries === previousEntries) nextEntries = [...previousEntries];
          const existingToolEntry = nextEntries[existingToolIndex] as Extract<ChatEntry, { type: "tool" }>;
          nextEntries[existingToolIndex] = mergeLiveToolEntry(existingToolEntry, incomingEntry);
          continue;
        }
      }
    }
    if (incomingEntry.type === "visual") {
      const artifactId = incomingEntry.visual?.artifactId;
      if (artifactId) {
        const alreadyPresent = nextEntries.some(
          (e) => e.type === "visual" && e.visual?.artifactId === artifactId,
        );
        if (alreadyPresent) continue;
      }
    }
    if (incomingEntry.type === "completion" && isDuplicateLiveCompletionEntry(nextEntries, incomingEntry)) continue;
    if (isDuplicateLiveMessageEntry(nextEntries, incomingEntry)) continue;
    if (nextEntries === previousEntries) nextEntries = [...previousEntries];
    nextEntries.push(incomingEntry);
  }

  return nextEntries;
}

export function mergeTailMessages(
  previousEntries: ChatEntry[],
  currentFirstItemIndex: number,
  total: number,
  nextWindow: ChatEntry[],
): { entries: ChatEntry[]; firstItemIndex: number; total: number; hasOptimisticTail: boolean; hasClientGeneratedEntries: boolean } {
  const latestWindowStart = Math.max(0, total - nextWindow.length);
  const currentLoadedEnd = currentFirstItemIndex + previousEntries.length;
  const preserveCount = latestWindowStart <= currentLoadedEnd
    ? Math.max(0, Math.min(previousEntries.length, latestWindowStart - currentFirstItemIndex))
    : 0;
  const optimisticTailCount = hasOptimisticTail(currentFirstItemIndex, previousEntries.length, total)
    ? currentLoadedEnd - total
    : 0;
  const optimisticTail = optimisticTailCount > 0
    ? previousEntries.slice(previousEntries.length - optimisticTailCount)
    : [];
  const firstItemIndex = preserveCount > 0 ? currentFirstItemIndex : latestWindowStart;
  const entries = preserveCount > 0
    ? [...previousEntries.slice(0, preserveCount), ...nextWindow, ...optimisticTail]
    : [...nextWindow, ...optimisticTail];
  const normalizedEntries = normalizeCommittedClientEntries(entries, firstItemIndex, total);

  return {
    firstItemIndex,
    entries: normalizedEntries,
    total: Math.max(total, firstItemIndex + normalizedEntries.length),
    hasOptimisticTail: optimisticTailCount > 0,
    hasClientGeneratedEntries: hasClientGeneratedEntries(normalizedEntries),
  };
}
