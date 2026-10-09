import { memo, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { CircleAlert, Clock, RotateCcw, TextSelect } from "lucide-react";
import type { ChatMessage } from "../api";
import { buildToolCallForest } from "../lib/tool-call-tree";
import remarkWikilink from "../lib/remark-wikilink";
import ToolCallTree from "./ToolCallTree";
import { bridgeUrlTransform } from "./BridgeReference";
import { MessageAttachments } from "./ChatAttachments";
import { MESSAGE_MARKDOWN_COMPONENTS } from "./chat-markdown";
import { APP_PROSE } from "./shared/prose-classes";
import { MessageActionToolbar } from "./MessageActions";
import { DS, cx } from "../design/tokens";
import { AutopilotBadge } from "../design/primitives";

interface MessageBubbleProps {
  message: ChatMessage;
  /**
   * Copy and menu actions. They arrive as plain values and stable callbacks, never as a rendered
   * element: this component is memoized, and re-parsing every loaded reply's markdown each time
   * the transcript renders is what it exists to avoid.
   */
  actions?: {
    onCopy: (key: string, message: ChatMessage) => void;
    onOpenMenu: (x: number, y: number, key: string, message: ChatMessage) => void;
  };
  /** The message's key in the transcript; required for `actions`. */
  messageKey?: string;
  copied?: boolean;
  isStreaming?: boolean;
  onRetry?: () => void;
  selectingText?: boolean;
  onFinishSelectingText?: () => void;
  /** Lets sent images and files in history load from the session's copy on the server. */
  sessionId?: string;
}

/**
 * Copy / more actions, shown while the message is hovered or focused. They float where they can
 * never cover the content that follows: a reply in a long agentic run is usually followed at once
 * by the next step, so anything hung below the message lands on top of it.
 *
 * A prompt's actions sit beside its bubble, in the space a right-aligned bubble always leaves
 * empty. A reply's actions hang in the margin beside its first line when the chat column is wide
 * enough to have one (`.chat-ui[data-action-gutter]`, see index.css); in a narrow column they fall
 * back to the reply's top-right corner.
 */
function BubbleActions({ side, children }: { side: "left" | "right"; children?: ReactNode }) {
  if (!children) return null;
  return (
    <div
      className={`pointer-events-none absolute z-10 opacity-0 transition-opacity duration-150 group-hover/message-bubble:opacity-100 group-focus-within/message-bubble:opacity-100 ${
        side === "right" ? "right-full top-1 mr-1" : "chat-reply-actions -top-3 right-0"
      }`}
    >
      <div className={cx("pointer-events-auto inline-flex gap-0.5 rounded-lg border border-border bg-bg-elevated p-0.5 text-text-muted", DS.surface.lift)}>
        {children}
      </div>
    </div>
  );
}

function TextSelectionControls({
  side,
  onDone,
}: {
  side: "left" | "right";
  onDone: () => void;
}) {
  return (
    <div
      data-message-selection-controls="true"
      className={`mb-1 flex items-center gap-2 text-[11px] text-text-muted ${
        side === "right" ? "justify-end" : "justify-start"
      }`}
    >
      <span role="status" className="inline-flex items-center gap-1">
        <TextSelect size={12} aria-hidden="true" />
        Press and hold or drag to select
      </span>
      <button
        type="button"
        onClick={onDone}
        className={cx(DS.button.base, DS.button.size.sm, DS.button.variant.secondary)}
        aria-label="Finish selecting message text"
      >
        Done
      </button>
    </div>
  );
}

function renderToolCalls(toolCalls: NonNullable<ChatMessage["toolCalls"]>) {
  const { roots } = buildToolCallForest(toolCalls);
  return roots.map((node) => (
    <ToolCallTree key={node.toolCall.toolCallId} node={node} />
  ));
}

export default memo(function MessageBubble({
  message,
  actions,
  messageKey,
  copied = false,
  isStreaming = false,
  onRetry,
  selectingText = false,
  onFinishSelectingText,
  sessionId,
}: MessageBubbleProps) {
  const isUser = message.role === "user";
  const actionSlot = actions && messageKey !== undefined && (
    <MessageActionToolbar
      messageKey={messageKey}
      message={message}
      copied={copied}
      onCopy={actions.onCopy}
      onOpenMenu={actions.onOpenMenu}
    />
  );

  if (isUser) {
    const hasAttachments = message.attachments && message.attachments.length > 0;
    const hasText = message.content !== "(image)" && message.content !== "(attachment)" && message.content.length > 0;
    const isFailed = message.delivery?.failed === true;
    const isQueued = !isFailed && message.delivery?.queued === true;
    const isPending = Boolean(message.delivery) && !isFailed;
    const deliveryState = isFailed ? "failed" : isQueued ? "queued" : isPending ? "sending" : "sent";
    const sentWithAutopilot = message.agentMode === "autopilot" || message.delivery?.mode === "autopilot";
    return (
      <div className="flex justify-end">
        <div
          className={`group/message-bubble relative max-w-[85%] transition-[opacity,filter] duration-150 sm:max-w-[78%] md:max-w-[72%] ${
            isPending ? "opacity-60 grayscale" : ""
          }`}
          aria-busy={isPending || undefined}
          aria-invalid={isFailed || undefined}
          data-delivery-state={deliveryState}
          title={isQueued
            ? "Bridge will send this once the session is free"
            : isPending
              ? "Sending to server..."
              : isFailed
                ? `Failed to send${message.delivery?.error ? `: ${message.delivery.error}` : ""}`
                : undefined}
        >
          {selectingText && onFinishSelectingText && (
            <TextSelectionControls side="right" onDone={onFinishSelectingText} />
          )}
          <BubbleActions side="right">{actionSlot}</BubbleActions>
          <div className="flex flex-col items-end gap-1.5">
            {hasAttachments && <MessageAttachments attachments={message.attachments!} align="end" sessionId={sessionId} />}
            {hasText && (
              // The bubble sizes to its text, so a long word must be able to shrink it (anywhere),
              // not just break after the width is fixed (break-words). Keep this off replies:
              // it is inherited and would squeeze markdown tables instead of letting them scroll.
              <div className={`rounded-3xl px-4 py-2.5 text-sm leading-relaxed text-text-primary whitespace-pre-wrap [overflow-wrap:anywhere] ${
                isFailed ? "border border-error/40 bg-bg-elevated" : "bg-bg-elevated"
              }`}>
                {message.content}
              </div>
            )}
            {sentWithAutopilot && (
              <AutopilotBadge title="Sent with Autopilot: Copilot keeps going on its own until the task is done" />
            )}
          </div>
          {isQueued && (
            <div className="mt-1.5 flex items-center justify-end gap-1.5 text-xs text-text-muted" role="status">
              <Clock size={12} aria-hidden="true" />
              <span>Waiting to send</span>
            </div>
          )}
          {isFailed && (
            <div
              className="mt-1.5 flex items-center justify-end gap-2 text-xs text-error"
              role="alert"
            >
              <CircleAlert size={13} aria-hidden="true" />
              <span title={message.delivery?.error}>Failed to send</span>
              {onRetry && (
                <button
                  type="button"
                  className={cx(DS.button.base, DS.button.size.sm, DS.button.variant.danger)}
                  aria-label="Retry sending message"
                  onClick={(event) => {
                    event.stopPropagation();
                    onRetry();
                  }}
                >
                  <RotateCcw size={12} aria-hidden="true" />
                  Retry
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  const hasContent = message.content.trim().length > 0;
  const hasTools = message.toolCalls && message.toolCalls.length > 0;

  // Tool-only message (no text) — render compact tool blocks
  if (!hasContent && hasTools) {
    return (
      <div className="flex justify-start min-w-0">
        <div className="group/message-bubble relative w-full max-w-full min-w-0 space-y-1">
          <BubbleActions side="left">{actionSlot}</BubbleActions>
          {renderToolCalls(message.toolCalls!)}
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start min-w-0">
      <div className="group/message-bubble relative w-full max-w-full min-w-0 break-words space-y-2">
        {selectingText && onFinishSelectingText && (
          <TextSelectionControls side="left" onDone={onFinishSelectingText} />
        )}
        <BubbleActions side="left">{actionSlot}</BubbleActions>
        {hasContent && (
          <div
            className={`ds-prose max-w-none py-0.5 text-sm leading-[1.7] text-text-primary ${APP_PROSE} prose-pre:bg-bg-surface prose-th:bg-bg-surface`}
            aria-busy={isStreaming || undefined}
          >
            <div className={isStreaming ? "streaming-text-fade" : undefined}>
              <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks, remarkWikilink]} components={MESSAGE_MARKDOWN_COMPONENTS} urlTransform={bridgeUrlTransform}>
                {message.content}
              </ReactMarkdown>
            </div>
          </div>
        )}
        {hasTools && (
          <div className="space-y-1">
            {renderToolCalls(message.toolCalls!)}
          </div>
        )}
      </div>
    </div>
  );
});
