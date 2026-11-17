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
import { AutopilotBadge, StatusIcon } from "../design/primitives";

interface MessageBubbleProps {
  message: ChatMessage;
  /** Plain values and stable callbacks, never JSX: a new element each render breaks the memo. */
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
  /** Resends a message the agent never got (`message.unsent`); Edit and Discard are in its menu. */
  onResendUnsent?: () => void;
  /** Quieter contrast for a progress note beside tools that a later reply superseded. */
  progressNote?: boolean;
}

const UNSENT_REASON: Record<NonNullable<ChatMessage["unsent"]>["state"], { label: string; title: string }> = {
  stopped: { label: "Stopped", title: "Stopped before the agent got it" },
  interrupted: { label: "Bridge restarted", title: "The Bridge restarted before the agent got it" },
  failed: { label: "Failed", title: "The turn could not start" },
};

/** Beside the bubble or in the reply's margin/corner, never below: the next step sits there. */
function BubbleActions({ side, children }: { side: "left" | "right"; children?: ReactNode }) {
  if (!children) return null;
  return (
    <div
      data-message-hover-actions="true"
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
  onResendUnsent,
  progressNote = false,
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
    const unsent = message.unsent;
    const unsentReason = unsent ? UNSENT_REASON[unsent.state] : undefined;
    const deliveryState = unsent ? "unsent" : isFailed ? "failed" : isQueued ? "queued" : isPending ? "sending" : "sent";
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
              // `anywhere` lets long words shrink the bubble; not on replies, it squeezes tables.
              <div className={`rounded-3xl px-4 py-2.5 text-sm leading-relaxed text-text-primary whitespace-pre-wrap [overflow-wrap:anywhere] ${
                isFailed ? "border border-error/40 bg-bg-elevated" : unsent ? "border border-surface-edge bg-bg-elevated" : "bg-bg-elevated"
              }`}>
                {message.content}
              </div>
            )}
            {sentWithAutopilot && (
              <AutopilotBadge title="Sent with Autopilot: Copilot keeps going on its own until the task is done" />
            )}
          </div>
          {unsent && unsentReason && (
            <div className="mt-1.5 flex flex-col items-end gap-1 text-xs text-text-secondary" role="status">
              <div className="flex items-center justify-end gap-2">
                <span className="inline-flex items-center gap-1.5" title={unsentReason.title}>
                  <StatusIcon kind={unsent.state === "failed" ? "danger" : "warning"} decorative />
                  <span>Not sent · {unsentReason.label}</span>
                </span>
                {onResendUnsent && (
                  <button
                    type="button"
                    className={cx(DS.button.base, DS.button.size.sm, DS.button.variant.secondary)}
                    onClick={(event) => {
                      event.stopPropagation();
                      onResendUnsent();
                    }}
                  >
                    <RotateCcw size={12} aria-hidden="true" />
                    Resend
                  </button>
                )}
              </div>
              {unsent.error && (
                // Shown, not hidden in a tooltip: a phone has no hover.
                <span className="line-clamp-2 max-w-full text-right text-text-faint">{unsent.error}</span>
              )}
            </div>
          )}
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
            data-progress-note={progressNote ? "true" : undefined}
            className={`ds-prose max-w-none py-0.5 text-sm leading-[1.7] ${
              progressNote ? "text-text-secondary" : "text-text-primary"
            } ${APP_PROSE} prose-p:my-2.5 prose-ul:my-2 prose-ol:my-2 prose-li:my-1 prose-table:my-3 prose-pre:bg-bg-surface prose-th:bg-bg-surface`}
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
