import { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback } from "react";
import { fetchMessages, fetchMessagesFast, warmSession, fetchMcpStatus, reportTiming, type BlobAttachment, type ChatEntry, type ChatMessage, type McpServerStatus, type ToolCall } from "../api";
import { useSessionStream } from "../useSessionStream";
import { useOverlayParam } from "../hooks/useOverlayParam";
import type { Draft } from "../useDrafts";
import MessageBubble from "./MessageBubble";
import ToolCallBlock from "./ToolCallBlock";
import SubAgentGroup from "./SubAgentGroup";
import ChatInput from "./ChatInput";
import PlanSheet from "./PlanSheet";
import McpStatusBar from "./McpStatusBar";
import { hasToolArgs, summarizeToolArgs } from "../lib/tool-args";
import { ArrowUpCircle, ClipboardList, Loader2 } from "lucide-react";

const PAGE_SIZE = 50;

type PendingStatusTone = "sending" | "thinking" | "creating";

interface ChatViewProps {
  sessionId: string | null;
  hasPlan?: boolean;
  onMessageSent: () => void;
  draft?: Draft | null;
  onDraftChange?: (text: string, attachments?: BlobAttachment[]) => void;
  onDraftClear?: () => void;
  onCreateAndSend?: (prompt: string, attachments?: BlobAttachment[]) => Promise<void>;
}

function renderPendingStatusCard(
  key: string,
  tone: PendingStatusTone,
  title: string,
  detail: string,
) {
  const sending = tone === "sending";
  const creating = tone === "creating";
  const style = sending
    ? {
        backgroundColor: "var(--color-chat-sending-bg)",
        borderColor: "var(--color-chat-sending-border)",
        color: "var(--color-chat-sending-text)",
      }
    : creating
      ? {
          backgroundColor: "var(--color-chat-creating-bg)",
          borderColor: "var(--color-chat-creating-border)",
          color: "var(--color-chat-creating-text)",
        }
      : {
          backgroundColor: "var(--color-chat-thinking-bg)",
          borderColor: "var(--color-chat-thinking-border)",
          color: "var(--color-chat-thinking-text)",
        };

  return (
    <div key={key} className="px-3 md:px-5">
      <div
        className="inline-flex max-w-lg items-start gap-3 rounded-2xl border px-4 py-3 shadow-sm"
        style={style}
      >
        {sending ? (
          <ArrowUpCircle size={18} className="mt-0.5 shrink-0" />
        ) : (
          <Loader2 size={18} className="mt-0.5 shrink-0 animate-spin" />
        )}
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-[0.16em] opacity-80">
            {sending ? "Sending" : creating ? "Creating" : "Thinking"}
          </div>
          <div className="text-sm font-medium">{title}</div>
          <div className="text-xs opacity-80">{detail}</div>
        </div>
      </div>
    </div>
  );
}

export default function ChatView({ sessionId, hasPlan, onMessageSent, draft, onDraftChange, onDraftClear, onCreateAndSend }: ChatViewProps) {
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshingHistory, setRefreshingHistory] = useState(false);
  const [warming, setWarming] = useState(false);
  const planOverlay = useOverlayParam("sheet");
  const showPlan = planOverlay.isOpen && planOverlay.value === "plan";
  const [creating, setCreating] = useState(false);
  const [mcpStatus, setMcpStatus] = useState<McpServerStatus[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const firstItemIndex = useRef(0);
  const sessionIdRef = useRef<string | null>(sessionId);
  const loadingMoreRef = useRef(false);
  const prevScrollHeightRef = useRef<number | null>(null);
  const loadRequestIdRef = useRef(0);
  const refreshingHistoryRef = useRef(false);

  const invalidateHistoryRefresh = useCallback(() => {
    if (!refreshingHistoryRef.current) return;
    loadRequestIdRef.current += 1;
    setRefreshingHistory(false);
  }, []);

  const handleNewEntries = useCallback((newEntries: ChatEntry[]) => {
    invalidateHistoryRefresh();
    const withIds = newEntries.map((e, i) => ({
      ...e,
      id: e.id ?? `stream-${Date.now()}-${i}`,
    }));
    setEntries((prev) => {
      // Deduplicate user messages (e.g. pendingPrompt recovery)
      const filtered = withIds.filter((entry) => {
        if (entry.type === "tool") return true;
        const msg = entry as ChatMessage;
        if (msg.role !== "user") return true;
        return !prev.some((p) => p.type !== "tool" && (p as ChatMessage).role === "user" && (p as ChatMessage).content === msg.content);
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
  } = useSessionStream(sessionId, handleNewEntries, onMessageSent);

  // Merge MCP status: prefer live stream updates over fetched status
  const effectiveMcpServers = (streamMcpServers?.length > 0 ? streamMcpServers : mcpStatus) ?? [];

  // Load history + MCP status when session changes.
  const prevSessionRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const prevSession = prevSessionRef.current;
    const wasDraft = prevSession === null && creating;
    prevSessionRef.current = sessionId;

    if (!sessionId) {
      // Clear messages when entering draft mode from an existing session
      // (but not on initial mount when prevSession is undefined)
      if (prevSession !== undefined || !onCreateAndSend) setEntries([]);
      setCreating(false);
      setLoadingMore(false);
      setHasMore(false);
      setMcpStatus([]);
      firstItemIndex.current = 0;
      loadingMoreRef.current = false;
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

    const controller = new AbortController();

    const loadAndReconnect = ({ background = false }: { background?: boolean } = {}) => {
      const requestId = ++loadRequestIdRef.current;
      if (background) {
        setRefreshingHistory(true);
      } else {
        setLoading(true);
        setRefreshingHistory(false);
        setWarming(false);
      }
      const pageLoadStart = performance.now();

      // Phase 1: Fast load messages from disk — don't wait for MCP status
      fetchMessagesFast(sessionId, { limit: PAGE_SIZE })
        .then(({ messages: msgs, busy, total, warm }) => {
          if (controller.signal.aborted || requestId !== loadRequestIdRef.current) return;
          setEntries((prev) => {
            if (!background) {
              firstItemIndex.current = total - msgs.length;
              return msgs;
            }

            const latestWindowStart = Math.max(0, total - msgs.length);
            const currentFirstIndex = firstItemIndex.current;
            const currentLoadedEnd = currentFirstIndex + prev.length;
            const preserveCount = latestWindowStart <= currentLoadedEnd
              ? Math.max(0, Math.min(prev.length, latestWindowStart - currentFirstIndex))
              : 0;

            firstItemIndex.current = preserveCount > 0 ? currentFirstIndex : latestWindowStart;
            return preserveCount > 0 ? [...prev.slice(0, preserveCount), ...msgs] : msgs;
          });
          setLoading(false);
          setRefreshingHistory(false);

          // Report time from navigation to messages rendered
          const loadDuration = Math.round(performance.now() - pageLoadStart);
          reportTiming("page.sessionLoad", loadDuration, {
            sessionId,
            metadata: { messageCount: msgs.length, warm, busy },
          }).catch(() => {});

          if (busy) {
            reconnect(sessionId);
            return;
          }

          // Phase 2: Warm the session in background if needed
          if (!warm) {
            setWarming(true);
            warmSession(sessionId)
              .then(() => {
                if (!controller.signal.aborted) setWarming(false);
              })
              .catch(() => {
                if (!controller.signal.aborted) setWarming(false);
              });
          }
        })
        .catch((err) => {
          if (controller.signal.aborted || requestId !== loadRequestIdRef.current) return;
          if (!background) {
            setEntries([
              { role: "assistant", content: `Error loading history: ${err.message}` },
            ]);
          }
          setLoading(false);
          setRefreshingHistory(false);
        });

      // MCP status loads independently — doesn't block message rendering
      fetchMcpStatus(sessionId)
        .then((mcpServers) => {
          if (!controller.signal.aborted && requestId === loadRequestIdRef.current) {
            setMcpStatus(mcpServers);
          }
        })
        .catch(() => {});
    };

    firstItemIndex.current = 0;
    loadingMoreRef.current = false;
    setEntries([]);
    setLoadingMore(false);
    setHasMore(false);
    loadAndReconnect();

    // Close plan sheet when switching sessions (close is a stable callback)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    planOverlay.close();

    // Reconnect when the tab wakes from sleep (mobile screen-off, etc.)
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      loadAndReconnect({ background: true });
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      controller.abort();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [sessionId, reconnect]);

  // Detect stick-to-bottom: if user is near the bottom, keep auto-scrolling.
  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }, [invalidateHistoryRefresh]);

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    refreshingHistoryRef.current = refreshingHistory;
  }, [refreshingHistory]);

  useEffect(() => {
    setHasMore(sessionId ? firstItemIndex.current > 0 : false);
  }, [entries, sessionId]);

  // Scroll preservation on prepend + auto-scroll on message changes.
  // useLayoutEffect runs before paint, preventing flash.
  useLayoutEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;

    // If we just prepended older messages, preserve scroll position.
    const prevHeight = prevScrollHeightRef.current;
    if (prevHeight != null) {
      el.scrollTop += el.scrollHeight - prevHeight;
      prevScrollHeightRef.current = null;
      return;
    }

    // Otherwise auto-scroll to bottom (initial load, new messages appended, etc.)
    if (stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [entries]);

  // Auto-scroll during streaming (content grows within the pending block).
  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const el = scrollContainerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [streamingContent, activeTools, toolProgress, isStreaming, creating]);

  // Load older messages when user scrolls to top
  const loadOlderMessages = useCallback(() => {
    if (!sessionId || !hasMore || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    const beforeIndex = firstItemIndex.current;
    const requestSessionId = sessionId;
    fetchMessages(sessionId, { limit: PAGE_SIZE, before: beforeIndex })
      .then(({ messages: older, hasMore: more }) => {
        if (sessionIdRef.current !== requestSessionId || firstItemIndex.current !== beforeIndex) return;
        if (older.length > 0) {
          invalidateHistoryRefresh();
          // Save scroll height before prepending so the layout effect can preserve position.
          prevScrollHeightRef.current = scrollContainerRef.current?.scrollHeight ?? null;
          setEntries((prev) => {
            firstItemIndex.current = beforeIndex - older.length;
            return [...older, ...prev];
          });
        } else if (!more) {
          firstItemIndex.current = 0;
          setHasMore(false);
        }
      })
      .catch(() => {})
      .finally(() => {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      });
  }, [sessionId, hasMore, invalidateHistoryRefresh]);

  // Load older messages when the top sentinel scrolls into view.
  useEffect(() => {
    const sentinel = topSentinelRef.current;
    const container = scrollContainerRef.current;
    if (!sentinel || !container) return;
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) loadOlderMessages(); },
      { root: container, rootMargin: "100px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadOlderMessages]);

  const handleSend = useCallback(async (prompt: string, attachments?: BlobAttachment[]) => {
    if (isStreaming || creating) return;

    // Draft mode: create session on first message
    if (!sessionId && onCreateAndSend) {
      setCreating(true);
      setEntries([{ role: "user", content: prompt, id: `draft-user-0`, ...(attachments?.length ? { attachments } : {}) }]);
      try {
        await onCreateAndSend(prompt, attachments);
      } catch (err: any) {
        setEntries((prev) => [
          ...prev,
          { role: "assistant", content: `⚠️ Error: ${err.message}`, id: `draft-err-0` },
        ]);
        setCreating(false);
      }
      return;
    }

    if (!sessionId) return;
    onDraftClear?.();
    invalidateHistoryRefresh();
    setEntries((prev) => [...prev, { role: "user", content: prompt, id: `local-${Date.now()}`, ...(attachments?.length ? { attachments } : {}) }]);
    // Force stick-to-bottom so auto-scroll kicks in after the next render
    stickToBottomRef.current = true;
    try {
      await sendMessage(prompt, attachments);
    } catch (err: any) {
      setEntries((prev) => [
        ...prev,
        { role: "assistant", content: `⚠️ Error: ${err.message}`, id: `err-${Date.now()}` },
      ]);
    }
  }, [sessionId, isStreaming, creating, sendMessage, onDraftClear, onCreateAndSend, invalidateHistoryRefresh]);

  // Build pending indicator content (streaming bubble + active tools + status text).
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
                    {!isAgent && hasToolArgs(t.args) && (
                      <span className="text-accent/40 ml-1">{summarizeToolArgs(t.args, { maxLength: 60, separator: " " })}</span>
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
      const sending = streamStatus === "sending";
      const title = sending
        ? "Handing off your message"
        : intentText
          ? `${intentText}...`
          : "Waiting for the first response";
      const detail = sending
        ? "The session has your prompt and is opening the response stream."
        : "The assistant is working before any text or tool activity is visible.";

      parts.push(renderPendingStatusCard("thinking", sending ? "sending" : "thinking", title, detail));
    }

    if (creating && !isStreaming) {
      parts.push(renderPendingStatusCard(
        "creating",
        "creating",
        "Starting a new chat session",
        "We're creating the session before the assistant can begin responding.",
      ));
    }

    if (parts.length === 0) return null;
    return <div className="space-y-4 pb-4">{parts}</div>;
  }, [streamingContent, activeTools, toolProgress, isStreaming, streamStatus, intentText, creating]);

  const isDraft = !sessionId && !!onCreateAndSend;

  if (!sessionId && !isDraft) {
    return (
      <div className="flex-1 flex items-center justify-center text-text-muted text-lg">
        Create or select a session to start
      </div>
    );
  }

  /** Render a chronological list of entries, grouping consecutive sub-agent children */
  const renderedEntries = useMemo(() => {
    const result: React.ReactNode[] = [];
    let i = 0;
    while (i < entries.length) {
      const entry = entries[i];
      if (entry.type === "tool") {
        const tc = entry.toolCall!;
        if (tc.isSubAgent) {
          // Collect consecutive child tools belonging to this sub-agent
          const children: ToolCall[] = [];
          let j = i + 1;
          while (j < entries.length && entries[j].type === "tool" && (entries[j] as any).toolCall?.parentToolCallId === tc.toolCallId) {
            children.push((entries[j] as any).toolCall);
            j++;
          }
          result.push(
            <div key={entry.id ?? `tool-${i}`} className="px-3 md:px-5 pt-2">
              <SubAgentGroup agentTool={tc} childTools={children} />
            </div>,
          );
          i = j;
        } else if (!tc.parentToolCallId) {
          // Top-level tool (not a sub-agent child)
          result.push(
            <div key={entry.id ?? `tool-${i}`} className="px-3 md:px-5 pt-2">
              <ToolCallBlock toolCall={tc} />
            </div>,
          );
          i++;
        } else {
          // Orphan child tool (parent already rendered) — skip
          i++;
        }
      } else {
        // Message entry
        const msg = entry as ChatMessage;
        result.push(
          <div key={entry.id ?? `${msg.role}-${i}`} className="px-3 md:px-5 pt-4">
            <MessageBubble message={msg} />
          </div>,
        );
        i++;
      }
    }
    return result;
  }, [entries]);

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
      {loading && entries.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-accent italic">
          Loading history...
        </div>
      ) : entries.length === 0 && !isStreaming && !creating ? (
        <div className="flex-1 flex items-center justify-center text-text-muted text-lg">
          Send a message to get started
        </div>
      ) : (
        <div
          ref={scrollContainerRef}
          className="flex-1 overflow-y-auto overflow-x-hidden"
          onScroll={handleScroll}
        >
          {/* Top sentinel for loading older messages */}
          <div ref={topSentinelRef} className="h-px" />
          {refreshingHistory && (
            <div className="sticky top-0 z-10 flex justify-center px-3 pt-3">
              <div className="inline-flex items-center gap-2 rounded-full border border-border bg-bg-secondary/95 px-3 py-1 text-xs text-text-muted shadow-sm backdrop-blur-sm">
                <Loader2 size={12} className="animate-spin text-accent/70" />
                Refreshing history...
              </div>
            </div>
          )}
          {loadingMore ? (
            <div className="text-center py-3 text-accent/60 text-xs">
              <Loader2 size={14} className="inline animate-spin mr-1" />
              Loading older messages...
            </div>
          ) : hasMore ? (
            <div className="text-center py-2 text-text-muted text-xs">
              Scroll up for more
            </div>
          ) : null}
          {renderedEntries}
          {pendingContent && <div className="pt-4">{pendingContent}</div>}
          <div className="h-4" />
        </div>
      )}
      <ChatInput onSend={handleSend} onAbort={isStreaming ? abortSession : undefined} sessionId={sessionId} isDraft={isDraft} draft={draft} onDraftChange={onDraftChange} disabled={warming} disabledHint="Reconnecting…" />
      {/* Plan sheet overlay */}
      {showPlan && sessionId && (
        <PlanSheet sessionId={sessionId} onClose={planOverlay.close} />
      )}
    </div>
  );
}
