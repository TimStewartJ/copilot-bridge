import type { FeedCard as FeedCardData, FeedCardStatus } from "../api";
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

export const DEFAULT_FEED_ACTION_LABEL = "Start session";

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

  return (
    <article className={`${UI.surface.card} p-4 space-y-3 ${card.priority === "high" ? "border-warning/50" : ""}`}>
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
          <h3 className="text-sm font-semibold leading-snug text-text-primary">{card.title}</h3>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {card.status === "active" ? (
            <>
              <button
                type="button"
                onClick={() => onStatusChange(card, "done")}
                className="rounded-md p-1.5 text-text-muted transition-colors hover:bg-success/10 hover:text-success"
                title="Mark done"
                aria-label="Mark done"
              >
                <CheckCircle2 size={15} />
              </button>
              <button
                type="button"
                onClick={() => onStatusChange(card, "dismissed")}
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
              onClick={() => onStatusChange(card, "active")}
              className="rounded-md p-1.5 text-text-muted transition-colors hover:bg-accent-surface hover:text-accent"
              title="Reactivate"
              aria-label="Reactivate"
            >
              <RotateCcw size={15} />
            </button>
          )}
          <button
            type="button"
            onClick={() => onDelete(card)}
            className="rounded-md p-1.5 text-text-muted transition-colors hover:bg-error/10 hover:text-error"
            title="Delete"
            aria-label="Delete"
          >
            <Trash2 size={15} />
          </button>
        </div>
      </div>

      {card.body && (
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-text-secondary">{card.body}</p>
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
