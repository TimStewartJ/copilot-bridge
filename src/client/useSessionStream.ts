import { useState, useEffect, useRef, useCallback } from "react";
import type { ChatMessage } from "./api";

export interface StreamState {
  streamingContent: string;
  activeTools: string[];
  intentText: string;
  toolProgress: string;
  isStreaming: boolean;
}

export function useSessionStream(
  sessionId: string | null,
  onMessagesUpdated: (msgs: ChatMessage[]) => void,
  onTitleChanged: () => void,
) {
  const [streamState, setStreamState] = useState<StreamState>({
    streamingContent: "",
    activeTools: [],
    intentText: "",
    toolProgress: "",
    isStreaming: false,
  });

  const abortRef = useRef<AbortController | null>(null);
  const sessionRef = useRef<string | null>(null);

  // Connect to the SSE stream for the current session
  const connectStream = useCallback((sid: string) => {
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;

    setStreamState({
      streamingContent: "",
      activeTools: [],
      intentText: "",
      toolProgress: "",
      isStreaming: true,
    });

    fetch(`/api/sessions/${sid}/stream`, { signal: abort.signal })
      .then(async (res) => {
        if (!res.ok || !res.body) {
          setStreamState((s) => ({ ...s, isStreaming: false }));
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let accumulatedContent = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              const event = JSON.parse(line.slice(6));
              if (sid !== sessionRef.current) return; // stale

              switch (event.type) {
                case "thinking":
                  break;
                case "intent":
                  setStreamState((s) => ({ ...s, intentText: event.intent ?? "" }));
                  break;
                case "delta":
                  accumulatedContent += event.content ?? "";
                  setStreamState((s) => ({
                    ...s,
                    streamingContent: accumulatedContent,
                  }));
                  break;
                case "assistant_partial":
                  if (event.content) {
                    onMessagesUpdated([{ role: "assistant", content: event.content }]);
                  }
                  break;
                case "tool_start":
                  setStreamState((s) => ({
                    ...s,
                    activeTools: [...s.activeTools, event.name ?? "unknown"],
                    toolProgress: "",
                  }));
                  break;
                case "tool_progress":
                  setStreamState((s) => ({ ...s, toolProgress: event.message ?? "" }));
                  break;
                case "tool_output":
                  setStreamState((s) => ({ ...s, toolProgress: event.content ?? "" }));
                  break;
                case "tool_done":
                  setStreamState((s) => ({
                    ...s,
                    activeTools: s.activeTools.filter((t) => t !== (event.name ?? "unknown")),
                    toolProgress: "",
                  }));
                  break;
                case "title_changed":
                  onTitleChanged();
                  break;
                case "done":
                  onMessagesUpdated([{ role: "assistant", content: event.content ?? "" }]);
                  setStreamState({
                    streamingContent: "",
                    activeTools: [],
                    intentText: "",
                    toolProgress: "",
                    isStreaming: false,
                  });
                  onTitleChanged();
                  accumulatedContent = "";
                  break;
                case "error":
                  onMessagesUpdated([{ role: "assistant", content: `⚠️ Error: ${event.message}` }]);
                  setStreamState({
                    streamingContent: "",
                    activeTools: [],
                    intentText: "",
                    toolProgress: "",
                    isStreaming: false,
                  });
                  break;
                case "idle":
                  setStreamState((s) => ({ ...s, isStreaming: false }));
                  break;
              }
            } catch { /* skip malformed */ }
          }
        }
      })
      .catch((err) => {
        if (err.name === "AbortError") return;
        console.error("[stream] Error:", err);
        setStreamState((s) => ({ ...s, isStreaming: false }));
      });
  }, [onMessagesUpdated, onTitleChanged]);

  // Clean up on session change
  useEffect(() => {
    sessionRef.current = sessionId;
    setStreamState({
      streamingContent: "",
      activeTools: [],
      intentText: "",
      toolProgress: "",
      isStreaming: false,
    });
    abortRef.current?.abort();
    return () => {
      abortRef.current?.abort();
    };
  }, [sessionId]);

  // Send a message — POST then connect to stream
  const sendMessage = useCallback(async (prompt: string) => {
    if (!sessionId) return;

    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, prompt }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Failed" }));
      throw new Error(err.error);
    }

    // Connect to stream to watch the work
    connectStream(sessionId);
  }, [sessionId, connectStream]);

  // Reconnect to an in-progress stream (e.g., navigating back)
  const reconnect = useCallback((sid: string) => {
    connectStream(sid);
  }, [connectStream]);

  return {
    ...streamState,
    sendMessage,
    reconnect,
  };
}
