import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { fetchMessages, fetchMcpStatus, type BlobAttachment, type ChatMessage, type McpServerStatus } from "../api";
import { useSessionStream } from "../useSessionStream";
import { useOverlayParam } from "../hooks/useOverlayParam";
import type { Draft } from "../useDrafts";
import MessageBubble from "./MessageBubble";
import ChatInput from "./ChatInput";
import PlanSheet from "./PlanSheet";
import McpStatusBar from "./McpStatusBar";
import { ClipboardList, Loader2 } from "lucide-react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";

const PAGE_SIZE = 50;

interface ChatViewProps {
  sessionId: string | null;
  hasPlan?: boolean;
  onMessageSent: () => void;
  draft?: Draft | null;
  onDraftChange?: (text: string, attachments?: BlobAttachment[]) => void;
  onDraftClear?: () => void;
  onCreateAndSend?: (prompt: string, attachments?: BlobAttachment[]) => Promise<void>;
}

function formatToolArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, val] of Object.entries(args)) {
    if (key === "intent") continue; // skip noise
    const s = typeof val === "string" ? val : JSON.stringify(val);
    parts.push(s.length > 60 ? s.slice(0, 57) + "..." : s);
  }
  return parts.join(" ");
}

const PENDING_ID = "__pending__";

export default function ChatView({ sessionId, hasPlan, onMessageSent, draft, onDraftChange, onDraftClear, onCreateAndSend }: ChatViewProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const planOverlay = useOverlayParam("sheet");
  const showPlan = planOverlay.isOpen && planOverlay.value === "plan";
  const [creating, setCreating] = useState(false);
  const [mcpStatus, setMcpStatus] = useState<McpServerStatus[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const stickToBottomRef = useRef(true);
  const firstItemIndex = useRef(0);
  const loadingMoreRef = useRef(false);
  // Suppress startReached during initial positioning to prevent cascading loads
  const initialPositioningRef = useRef(true);

  const handleNewMessages = useCallback((newMsgs: ChatMessage[]) => {
    // Assign client-side IDs to streamed messages that don't have server IDs
    const withIds = newMsgs.map((m, i) => ({
      ...m,
      id: m.id ?? `stream-${Date.now()}-${i}`,
    }));
    setMessages((prev) => {
      // Deduplicate user messages that are already present (e.g. pendingPrompt
      // recovery producing a duplicate of the optimistic message or fetched history)
      const filtered = withIds.filter((msg) => {
        if (msg.role !== "user") return true;
        return !prev.some((p) => p.role === "user" && p.content === msg.content);
      });
      return filtered.length > 0 ? [...prev, ...filtered] : prev;
    });
  }, []);

  const {
    streamingContent,
    activeTools,
    intentText,
    toolProgress,
    isStreaming,
    streamStatus,
    mcpServers: streamMcpServers,
    sendMessage,
    abortSession,
    reconnect,
  } = useSessionStream(sessionId, handleNewMessages, onMessageSent);

  // Merge MCP status: prefer live stream updates over fetched status
  const effectiveMcpServers = (streamMcpServers?.length > 0 ? streamMcpServers : mcpStatus) ?? [];

  // Fetch MCP status when session changes
  useEffect(() => {
    if (!sessionId) {
      setMcpStatus([]);
      return;
    }
    fetchMcpStatus(sessionId).then(setMcpStatus).catch(() => {});
  }, [sessionId]);

  // Load history when session changes
  const prevSessionRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const prevSession = prevSessionRef.current;
    const wasDraft = prevSession === null && creating;
    prevSessionRef.current = sessionId;

    if (!sessionId) {
      // Clear messages when entering draft mode from an existing session
      // (but not on initial mount when prevSession is undefined)
      if (prevSession !== undefined || !onCreateAndSend) setMessages([]);
      setCreating(false);
      setHasMore(false);
      firstItemIndex.current = 0;
      return;
    }

    // Transitioning from draft → real session: keep messages, just connect stream
    if (wasDraft) {
      setCreating(false);
      reconnect(sessionId);
      return;
    }

    // Reset stick-to-bottom so the new session starts following output,
    // regardless of scroll position in the previous session.
    stickToBottomRef.current = true;

    const loadAndReconnect = () => {
      setLoading(true);
      initialPositioningRef.current = true;
      fetchMessages(sessionId, { limit: PAGE_SIZE })
        .then(({ messages: msgs, busy, total, hasMore: more }) => {
          setMessages(msgs);
          setHasMore(more);
          // firstItemIndex tracks the virtual index offset for prepending
          firstItemIndex.current = total - msgs.length;
          if (busy) reconnect(sessionId);
          // Allow startReached after Virtuoso has settled at the bottom,
          // then force a scroll correction in case dynamic content (markdown,
          // images, code blocks) caused Virtuoso's initial measurement to
          // land at the wrong offset.
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              initialPositioningRef.current = false;
              virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end", behavior: "auto" });
            });
          });
        })
        .catch((err) =>
          setMessages([
            { role: "assistant", content: `Error loading history: ${err.message}` },
          ]),
        )
        .finally(() => setLoading(false));
    };

    setMessages([]);
    setHasMore(false);
    loadAndReconnect();

    // Close plan sheet when switching sessions (close is a stable callback)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    planOverlay.close();

    // Reconnect when the tab wakes from sleep (mobile screen-off, etc.)
    const onVisible = () => {
      if (document.visibilityState === "visible") loadAndReconnect();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [sessionId, reconnect]);

  // Auto-scroll when streaming state changes, but only if sticking to bottom.
  // Uses Virtuoso's own scrollToIndex which is always available via the handle ref.
  useEffect(() => {
    if (!stickToBottomRef.current) return;
    virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end", behavior: "auto" });
  }, [streamingContent, activeTools, toolProgress, isStreaming, creating]);

  // Load older messages when user scrolls to top
  const loadOlderMessages = useCallback(() => {
    if (!sessionId || !hasMore || initialPositioningRef.current || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    const beforeIndex = firstItemIndex.current;
    fetchMessages(sessionId, { limit: PAGE_SIZE, before: beforeIndex })
      .then(({ messages: older, hasMore: more }) => {
        if (older.length > 0) {
          setMessages((prev) => [...older, ...prev]);
          firstItemIndex.current = beforeIndex - older.length;
        }
        setHasMore(more);
      })
      .catch(() => {})
      .finally(() => {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      });
  }, [sessionId, hasMore]);

  const handleSend = useCallback(async (prompt: string, attachments?: BlobAttachment[]) => {
    if (isStreaming || creating) return;

    // Draft mode: create session on first message
    if (!sessionId && onCreateAndSend) {
      setCreating(true);
      setMessages([{ role: "user", content: prompt, id: `draft-user-0`, ...(attachments?.length ? { attachments } : {}) }]);
      try {
        await onCreateAndSend(prompt, attachments);
      } catch (err: any) {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: `⚠️ Error: ${err.message}`, id: `draft-err-0` },
        ]);
        setCreating(false);
      }
      return;
    }

    if (!sessionId) return;
    onDraftClear?.();
    setMessages((prev) => [...prev, { role: "user", content: prompt, id: `local-${Date.now()}`, ...(attachments?.length ? { attachments } : {}) }]);
    // Force stick-to-bottom so the layoutEffect scrolls on the next render
    stickToBottomRef.current = true;
    try {
      await sendMessage(prompt, attachments);
    } catch (err: any) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: `⚠️ Error: ${err.message}`, id: `err-${Date.now()}` },
      ]);
    }
  }, [sessionId, isStreaming, creating, sendMessage, onDraftClear, onCreateAndSend]);

  // Build pending indicator content (streaming bubble + active tools + status text).
  // This is rendered as a synthetic data item (not a Virtuoso Footer) so that
  // scrollToIndex("LAST") and followOutput naturally scroll it into view.
  const pendingContent = useMemo(() => {
    const parts: React.ReactNode[] = [];

    if (streamingContent) {
      parts.push(
        <div key="streaming" className="px-3 md:px-5">
          <MessageBubble message={{ role: "assistant", content: streamingContent }} />
        </div>,
      );
    }

    if (activeTools.length > 0) {
      parts.push(
        <div key="tools" className="text-xs text-accent/70 px-7 md:px-9 py-1 space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <Loader2 size={12} className="animate-spin" />
            {activeTools
              .filter((t) => !t.parentToolCallId)
              .map((t) => {
                const isAgent = t.isSubAgent || t.name.startsWith("🤖");
                const childCount = t.isSubAgent
                  ? activeTools.filter((c) => c.parentToolCallId === t.toolCallId).length
                  : 0;
                return (
                  <span
                    key={t.toolCallId || t.name}
                    className={`px-2 py-0.5 rounded ${isAgent ? "bg-agent-muted text-agent" : "bg-accent/10"}`}
                  >
                    {t.name}
                    {childCount > 0 && (
                      <span className="text-agent/50 ml-1">({childCount})</span>
                    )}
                    {!isAgent && t.args && Object.keys(t.args).length > 0 && (
                      <span className="text-accent/40 ml-1">{formatToolArgs(t.args)}</span>
                    )}
                  </span>
                );
              })}
          </div>
          {toolProgress && (
            <div className="text-accent/50 pl-6 truncate">{toolProgress}</div>
          )}
        </div>,
      );
    }

    if (isStreaming && !streamingContent && activeTools.length === 0) {
      parts.push(
        <div key="thinking" className="px-3 md:px-5 text-accent italic animate-pulse">
          {streamStatus === "sending"
            ? "Sending..."
            : intentText
              ? `${intentText}...`
              : "Thinking..."}
        </div>,
      );
    }

    if (creating && !isStreaming) {
      parts.push(
        <div key="creating" className="px-3 md:px-5 text-accent italic animate-pulse">Creating session...</div>,
      );
    }

    if (parts.length === 0) return null;
    return <div className="space-y-4 pb-4">{parts}</div>;
  }, [streamingContent, activeTools, toolProgress, isStreaming, streamStatus, intentText, creating]);

  // Build display list: real messages + optional synthetic pending item.
  // Putting the pending indicator in the data array (instead of the Footer)
  // ensures scrollToIndex("LAST") and followOutput include it.
  // Depend on !!pendingContent (not the JSX itself) so the array reference
  // stays stable during streaming — avoids re-spreading on every token.
  const hasPending = !!pendingContent;
  const displayMessages = useMemo(() => {
    if (!hasPending) return messages;
    return [...messages, { role: "assistant" as const, content: "", id: PENDING_ID }];
  }, [messages, hasPending]);

  const isDraft = !sessionId && !!onCreateAndSend;

  if (!sessionId && !isDraft) {
    return (
      <div className="flex-1 flex items-center justify-center text-text-muted text-lg">
        Create or select a session to start
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Plan header bar */}
      {hasPlan && (
        <div className="shrink-0 flex items-center justify-between px-4 py-2 border-b border-border bg-bg-secondary">
          <span className="text-xs text-text-muted flex items-center gap-1.5">
            <ClipboardList size={12} />
            Plan available
          </span>
          <button
            onClick={() => planOverlay.open("plan")}
            className="text-xs text-accent hover:text-accent-hover transition-colors font-medium"
          >
            View
          </button>
        </div>
      )}
      {/* MCP server status */}
      <McpStatusBar servers={effectiveMcpServers} />
      {loading ? (
        <div className="flex-1 flex items-center justify-center text-accent italic">
          Loading history...
        </div>
      ) : messages.length === 0 && !isStreaming && !creating ? (
        <div className="flex-1 flex items-center justify-center text-text-muted text-lg">
          Send a message to get started
        </div>
      ) : (
        <Virtuoso
          ref={virtuosoRef}
          className="flex-1 overflow-x-hidden"
          data={displayMessages}
          firstItemIndex={firstItemIndex.current}
          initialTopMostItemIndex={{ index: "LAST", align: "end" }}
          followOutput={() => stickToBottomRef.current ? "smooth" : false}
          atBottomStateChange={(atBottom) => { stickToBottomRef.current = atBottom; }}
          atTopStateChange={(atTop) => { if (atTop) loadOlderMessages(); }}
          atTopThreshold={100}
          increaseViewportBy={{ top: 200, bottom: 200 }}
          itemContent={(_index, msg) =>
            msg.id === PENDING_ID ? (
              <div className="pt-4">{pendingContent}</div>
            ) : (
              <div className="px-3 md:px-5 pt-4">
                <MessageBubble key={msg.id ?? `${msg.role}-${_index}`} message={msg} />
              </div>
            )
          }
          components={{
            Header: () =>
              loadingMore ? (
                <div className="text-center py-3 text-accent/60 text-xs">
                  <Loader2 size={14} className="inline animate-spin mr-1" />
                  Loading older messages...
                </div>
              ) : hasMore ? (
                <div className="text-center py-2 text-text-muted text-xs">
                  Scroll up for more
                </div>
              ) : null,
            Footer: () => <div className="h-4" />,
          }}
        />
      )}
      <ChatInput onSend={handleSend} onAbort={isStreaming ? abortSession : undefined} sessionId={sessionId} isDraft={isDraft} draft={draft} onDraftChange={onDraftChange} />
      {/* Plan sheet overlay */}
      {showPlan && sessionId && (
        <PlanSheet sessionId={sessionId} onClose={planOverlay.close} />
      )}
    </div>
  );
}
