import type { FeedCard as FeedCardData, FeedCardStatus } from "../api";
import { DEFAULT_FEED_ACTION_LABEL } from "../feed-action-helpers";
import { UI } from "./shared/design-system";
import VisualArtifactCard from "./VisualArtifactCard";
import {
  CheckCircle2,
  ExternalLink,
  Link as LinkIcon,
  MessageSquare,
  Pin,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";

interface FeedCardProps {
  card: FeedCardData;
  onSelectTask: (taskId: string) => void;
  onSelectSession: (sessionId: string, taskId?: string) => void;
  onAction: (card: FeedCardData) => void;
  onStatusChange: (card: FeedCardData, status: FeedCardStatus) => void | Promise<void>;
  onDelete: (card: FeedCardData) => void | Promise<void>;
}

const KIND_LABELS: Record<string, string> = {
  note: "Note",
  status: "Status",
  todo: "Todo",
  decision: "Decision",
  artifact: "Artifact",
  link: "Link",
};

const PRIORITY_CLASS: Record<FeedCardData["priority"], string> = {
  low: UI.chip.muted,
  normal: UI.chip.info,
  high: UI.chip.warning,
};

const STATUS_CLASS: Record<FeedCardStatus, string> = {
  active: UI.chip.info,
  done: UI.chip.success,
  dismissed: UI.chip.faint,
};

const CARD_STATUS_CLASS: Record<FeedCardStatus, string> = {
  active: "",
  done: "border-success/25 bg-success/5 shadow-none",
  dismissed: "border-border/60 bg-bg-secondary/55 shadow-none",
};

const CARD_RAIL_CLASS: Record<FeedCardStatus, string> = {
  active: "hidden",
  done: "bg-success/70",
  dismissed: "bg-text-faint/50",
};

const TITLE_STATUS_CLASS: Record<FeedCardStatus, string> = {
  active: "text-text-primary",
  done: "text-text-secondary",
  dismissed: "text-text-muted",
};

const BODY_STATUS_CLASS: Record<FeedCardStatus, string> = {
  active: "text-text-secondary",
  done: "text-text-muted",
  dismissed: "text-text-muted",
};

function labelForKind(kind: string): string {
  return KIND_LABELS[kind] ?? kind.replace(/[-_]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function statusLabel(status: FeedCardStatus): string {
  switch (status) {
    case "active":
      return "Active";
    case "done":
      return "Done";
    case "dismissed":
      return "Dismissed";
    default:
      return status;
  }
}

export default function FeedCard({
  card,
  onSelectTask,
  onSelectSession,
  onAction,
  onStatusChange,
  onDelete,
}: FeedCardProps) {
  const relatedLinks = [
    ...(card.url ? [{ label: "Open", url: card.url }] : []),
    ...card.links,
  ];
  const hasPromptAction = card.status === "active" && Boolean(card.action);
  const handleStatusClick = (status: FeedCardStatus) => {
    void onStatusChange(card, status);
  };
  const handleDeleteClick = () => {
    void onDelete(card);
  };
  const highPriorityClass = card.status === "active" && card.priority === "high" ? "border-warning/50" : "";

  return (
    <article className={`${UI.surface.card} relative overflow-hidden p-4 pl-5 space-y-3 transition-colors ${CARD_STATUS_CLASS[card.status]} ${highPriorityClass}`}>
      <div aria-hidden="true" className={`absolute inset-y-0 left-0 w-1 ${CARD_RAIL_CLASS[card.status]}`} />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            {card.pinned && (
              <span className="inline-flex items-center gap-1 rounded-full bg-accent-surface px-2 py-0.5 text-[11px] font-medium text-accent">
                <Pin size={11} />
                Pinned
              </span>
            )}
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_CLASS[card.status]}`}>
              {statusLabel(card.status)}
            </span>
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${PRIORITY_CLASS[card.priority]}`}>
              {card.priority}
            </span>
            <span className="rounded-full bg-bg-hover px-2 py-0.5 text-[11px] font-medium text-text-muted">
              {labelForKind(card.kind)}
            </span>
          </div>
          <h3 className={`text-sm font-semibold leading-snug ${TITLE_STATUS_CLASS[card.status]}`}>{card.title}</h3>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {card.status === "active" ? (
            <>
              <button
                type="button"
                onClick={() => handleStatusClick("done")}
                className="rounded-md p-1.5 text-text-muted transition-colors hover:bg-success/10 hover:text-success"
                title="Mark done"
                aria-label="Mark done"
              >
                <CheckCircle2 size={15} />
              </button>
              <button
                type="button"
                onClick={() => handleStatusClick("dismissed")}
                className="rounded-md p-1.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
                title="Dismiss"
                aria-label="Dismiss"
              >
                <X size={15} />
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => handleStatusClick("active")}
              className="rounded-md p-1.5 text-text-muted transition-colors hover:bg-accent-surface hover:text-accent"
              title="Reactivate"
              aria-label="Reactivate"
            >
              <RotateCcw size={15} />
            </button>
          )}
          <button
            type="button"
            onClick={handleDeleteClick}
            className="rounded-md p-1.5 text-text-muted transition-colors hover:bg-error/10 hover:text-error"
            title="Delete"
            aria-label="Delete"
          >
            <Trash2 size={15} />
          </button>
        </div>
      </div>

      {card.body && (
        <p className={`whitespace-pre-wrap text-sm leading-relaxed ${BODY_STATUS_CLASS[card.status]}`}>{card.body}</p>
      )}

      {card.visual && (
        <div className="overflow-hidden rounded-lg border border-border bg-bg-primary p-3">
          <VisualArtifactCard visual={card.visual} />
        </div>
      )}

      {(hasPromptAction || card.taskId || card.sessionId || relatedLinks.length > 0) && (
        <div className="flex flex-wrap items-center gap-2">
          {hasPromptAction && (
            <button
              type="button"
              onClick={() => onAction(card)}
              className={`${UI.button.primary} inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs`}
            >
              <MessageSquare size={13} />
              {card.action?.label ?? DEFAULT_FEED_ACTION_LABEL}
            </button>
          )}
          {card.taskId && (
            <button
              type="button"
              onClick={() => onSelectTask(card.taskId!)}
              className={UI.button.secondary}
            >
              Open task
            </button>
          )}
          {card.sessionId && (
            <button
              type="button"
              onClick={() => onSelectSession(card.sessionId!, card.taskId ?? undefined)}
              className={`${UI.button.secondary} inline-flex items-center gap-1.5`}
            >
              <MessageSquare size={13} />
              Open session
            </button>
          )}
          {relatedLinks.map((link, index) => (
            <a
              key={`${link.url}-${index}`}
              href={link.url}
              target="_blank"
              rel="noreferrer"
              className={`${UI.button.secondary} inline-flex items-center gap-1.5`}
            >
              {index === 0 && card.url ? <ExternalLink size={13} /> : <LinkIcon size={13} />}
              {link.label}
            </a>
          ))}
        </div>
      )}
    </article>
  );
}
