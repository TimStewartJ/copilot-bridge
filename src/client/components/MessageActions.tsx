import { Check, Clock, Copy, GitFork, Loader2, MoreHorizontal } from "lucide-react";
import type { ChatMessage } from "../api";
import { timeAgo } from "../time";
import ContextMenu, { CtxDivider, CtxItem, type ContextMenuPosition } from "./ContextMenu";

export interface MessageActionMenuTarget {
  key: string;
  message: ChatMessage;
}

function formatMessageTimestamp(timestamp?: string): { primary: string; detail?: string } {
  if (!timestamp) return { primary: "Timestamp unavailable" };
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return { primary: timestamp };
  return {
    primary: date.toLocaleString(),
    detail: timeAgo(timestamp),
  };
}

export async function writeClipboardText(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textArea = document.createElement("textarea");
  textArea.value = text;
  textArea.setAttribute("readonly", "");
  textArea.style.position = "fixed";
  textArea.style.left = "-9999px";
  textArea.style.top = "0";
  document.body.appendChild(textArea);
  textArea.select();
  try {
    const copied = document.execCommand("copy");
    if (!copied) throw new Error("Browser copy command returned false");
  } finally {
    document.body.removeChild(textArea);
  }
}

interface MessageActionToolbarProps {
  messageKey: string;
  message: ChatMessage;
  copied: boolean;
  onCopy: (key: string, message: ChatMessage) => void;
  onOpenMenu: (x: number, y: number, key: string, message: ChatMessage) => void;
}

const actionButtonClass = "inline-flex h-7 w-7 items-center justify-center transition-colors hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-wait disabled:opacity-50";

export function MessageActionToolbar({
  messageKey,
  message,
  copied,
  onCopy,
  onOpenMenu,
}: MessageActionToolbarProps) {
  return (
    <>
      <button
        type="button"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onCopy(messageKey, message);
        }}
        className={actionButtonClass}
        aria-label={copied ? "Copied message" : "Copy message"}
        title={copied ? "Copied" : "Copy message"}
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </button>
      <button
        type="button"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          const rect = event.currentTarget.getBoundingClientRect();
          onOpenMenu(rect.left, rect.bottom + 4, messageKey, message);
        }}
        className={`${actionButtonClass} border-l border-border/70`}
        aria-label="Open message actions"
        title="Message actions"
      >
        <MoreHorizontal size={14} />
      </button>
    </>
  );
}

interface MessageActionsMenuProps {
  position: ContextMenuPosition;
  target: MessageActionMenuTarget;
  copied: boolean;
  forkLoading: boolean;
  forkDisabled: boolean;
  onClose: () => void;
  onCopy: () => void;
  onFork: () => void;
}

export function MessageActionsMenu({
  position,
  target,
  copied,
  forkLoading,
  forkDisabled,
  onClose,
  onCopy,
  onFork,
}: MessageActionsMenuProps) {
  const timestamp = formatMessageTimestamp(target.message.timestamp);
  const forkBoundaryEventId = target.message.role === "assistant"
    ? target.message.forkBoundaryEventId
    : undefined;

  return (
    <ContextMenu position={position} onClose={onClose}>
      <div className="flex min-w-[230px] items-start gap-2 px-3 py-2 text-xs text-text-muted">
        <Clock size={14} className="mt-0.5 shrink-0" />
        <div className="min-w-0">
          <div className="font-medium text-text-secondary">Timestamp</div>
          <div className="truncate text-text-primary">{timestamp.primary}</div>
          {timestamp.detail && (
            <div className="text-text-muted">{timestamp.detail}</div>
          )}
        </div>
      </div>
      <CtxDivider />
      <CtxItem
        icon={copied ? <Check size={14} /> : <Copy size={14} />}
        label={copied ? "Copied" : "Copy message"}
        onClick={onCopy}
        title="Copy the message text"
      />
      {forkBoundaryEventId && (
        <CtxItem
          icon={forkLoading ? <Loader2 size={14} className="animate-spin" /> : <GitFork size={14} />}
          label={forkLoading ? "Forking..." : "Fork from here"}
          onClick={onFork}
          disabled={forkDisabled || forkLoading}
          title={forkDisabled ? "Wait until this session is idle" : "Fork a new session through this response"}
        />
      )}
    </ContextMenu>
  );
}
