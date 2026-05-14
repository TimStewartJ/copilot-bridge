import { useState, type MouseEvent as ReactMouseEvent } from "react";
import type { FeedCard as FeedCardData, FeedCardStatus } from "../api";
import { DEFAULT_FEED_ACTION_LABEL } from "../feed-action-helpers";
import { UI } from "./shared/design-system";
import ContextMenu, { CtxDivider, CtxItem, type ContextMenuPosition } from "./ContextMenu";
import VisualArtifactCard from "./VisualArtifactCard";
import {
  Bell,
  CheckCircle2,
  ClipboardCheck,
  FileText,
  ExternalLink,
  HelpCircle,
  Link as LinkIcon,
  Lightbulb,
  MessageSquare,
  MoreHorizontal,
  Pin,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";

interface FeedCardProps {
  card: FeedCardData;
  pending?: boolean;
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

const AVATAR_CLASS: Record<string, string> = {
  note: "border-info-border bg-info-surface text-info",
  status: "border-accent-border bg-accent-surface text-accent",
  todo: "border-success/20 bg-success/10 text-success",
  decision: "border-warning/25 bg-warning/15 text-warning",
  artifact: "border-border bg-bg-hover text-text-secondary",
  link: "border-info-border bg-info-surface text-info",
};

const MOBILE_ACTION_BUTTON_BASE =
  "inline-flex min-h-11 min-w-0 items-center justify-center gap-1 rounded-full px-2 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60";
const MOBILE_MORE_BUTTON_CLASS =
  "inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-bg-hover text-text-primary transition-colors hover:bg-border disabled:cursor-not-allowed disabled:opacity-60";
const DESKTOP_ACTION_BUTTON_BASE =
  "inline-flex h-8 w-8 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-60";
const LINK_BUTTON_CLASS = `${UI.button.secondary} inline-flex min-h-11 items-center gap-1.5 px-3 text-sm sm:min-h-8 sm:px-2.5 sm:text-xs`;
const METADATA_SOURCE_MAX_LENGTH = 32;
const CONTEXT_MENU_ESTIMATED_WIDTH = 180;

function labelForKind(kind: string): string {
  return kind in KIND_LABELS
    ? KIND_LABELS[kind]
    : kind.replace(/[-_]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
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

function sanitizeMetadataSource(metadata: Record<string, unknown> | null): string | null {
  const source = metadata?.source;
  if (typeof source !== "string") return null;
  const normalized = source.trim().replace(/\s+/g, " ");
  if (!normalized) return null;
  return normalized.length > METADATA_SOURCE_MAX_LENGTH
    ? `${normalized.slice(0, METADATA_SOURCE_MAX_LENGTH - 3).trimEnd()}...`
    : normalized;
}

function initialsForSource(source: string): string {
  const words = source
    .replace(/^@/, "")
    .split(/\s+/)
    .filter(Boolean);
  const initials = words.length > 1
    ? `${words[0][0] ?? ""}${words[1][0] ?? ""}`
    : source.slice(0, 2);
  return initials.toUpperCase();
}

function timestampForCard(card: FeedCardData): { verb: string; iso: string } {
  if (card.status === "done") {
    return { verb: "Done", iso: card.statusChangedAt };
  }
  if (card.status === "dismissed") {
    return { verb: "Dismissed", iso: card.statusChangedAt };
  }

  return {
    verb: "Posted",
    iso: card.createdAt,
  };
}

function formatRelativeTime(iso: string): string {
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return "recently";
  const elapsedMs = Math.max(0, Date.now() - timestamp);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;
  const month = 30 * day;
  const year = 365 * day;

  if (elapsedMs < minute) return "just now";
  if (elapsedMs < hour) return `${Math.floor(elapsedMs / minute)}m ago`;
  if (elapsedMs < day) return `${Math.floor(elapsedMs / hour)}h ago`;
  if (elapsedMs < week) return `${Math.floor(elapsedMs / day)}d ago`;
  if (elapsedMs < month) return `${Math.floor(elapsedMs / week)}w ago`;
  if (elapsedMs < year) return `${Math.floor(elapsedMs / month)}mo ago`;
  return `${Math.floor(elapsedMs / year)}y ago`;
}

function formatAbsoluteTime(iso: string): string {
  const timestamp = Date.parse(iso);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : iso;
}

function renderKindAvatarIcon(kind: string) {
  switch (kind) {
    case "note":
      return <FileText size={16} />;
    case "status":
      return <Bell size={16} />;
    case "todo":
      return <ClipboardCheck size={16} />;
    case "decision":
      return <Lightbulb size={16} />;
    case "link":
      return <LinkIcon size={16} />;
    default:
      return <HelpCircle size={16} />;
  }
}

export default function FeedCard({
  card,
  pending = false,
  onSelectTask,
  onSelectSession,
  onAction,
  onStatusChange,
  onDelete,
}: FeedCardProps) {
  const [menuPosition, setMenuPosition] = useState<ContextMenuPosition | null>(null);
  const relatedLinks = [
    ...(card.url ? [{ label: "Open", url: card.url }] : []),
    ...card.links,
  ];
  const hasPromptAction = card.status === "active" && Boolean(card.action);
  const hasSecondaryActions = hasPromptAction || Boolean(card.taskId) || Boolean(card.sessionId) || relatedLinks.length > 0;
  const highPriorityClass = card.status === "active" && card.priority === "high" ? "border-warning/50" : "";
  const metadataSource = sanitizeMetadataSource(card.metadata);
  const kindLabel = labelForKind(card.kind);
  const timestamp = timestampForCard(card);
  const actionSectionClass = `space-y-2 border-t border-border/60 pt-2 ${hasSecondaryActions ? "" : "sm:hidden"}`;
  const avatarClass = AVATAR_CLASS[card.kind] ?? "border-border bg-bg-hover text-text-secondary";
  const moreOpen = Boolean(menuPosition);

  const handlePromptActionClick = () => {
    if (pending || !card.action) return;
    setMenuPosition(null);
    onAction(card);
  };

  const handleStatusClick = (status: FeedCardStatus) => {
    if (pending) return;
    setMenuPosition(null);
    void onStatusChange(card, status);
  };

  const handleDeleteClick = () => {
    if (pending) return;
    setMenuPosition(null);
    void onDelete(card);
  };

  const handleMoreClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setMenuPosition((current) => (
      current
        ? null
        : {
            x: Math.max(8, rect.right - CONTEXT_MENU_ESTIMATED_WIDTH),
            y: rect.bottom + 6,
          }
    ));
  };

  const renderStatusActions = (layout: "mobile" | "desktop") => {
    const desktop = layout === "desktop";
    const buttonBase = desktop ? DESKTOP_ACTION_BUTTON_BASE : MOBILE_ACTION_BUTTON_BASE;
    const moreButtonBase = desktop ? DESKTOP_ACTION_BUTTON_BASE : MOBILE_MORE_BUTTON_CLASS;
    const iconSize = desktop ? 15 : 18;
    const labelClass = desktop ? "sr-only" : "truncate";
    const moreLabelClass = "sr-only";

    return (
      <>
        {card.status === "active" ? (
          <>
            {!desktop && hasPromptAction ? (
              <button
                type="button"
                onClick={handlePromptActionClick}
                disabled={pending}
                className={`${buttonBase} bg-accent text-white hover:bg-accent-hover`}
              >
                <MessageSquare size={iconSize} />
                <span className={labelClass}>{card.action?.label ?? DEFAULT_FEED_ACTION_LABEL}</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => handleStatusClick("done")}
                disabled={pending}
                className={`${buttonBase} ${desktop ? "hover:bg-success/10 hover:text-success" : "bg-success/10 text-success hover:bg-success/15"}`}
                title="Mark done"
                aria-label="Mark done"
              >
                <CheckCircle2 size={iconSize} />
                <span className={labelClass}>Mark done</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => handleStatusClick("dismissed")}
              disabled={pending}
              className={`${buttonBase} ${desktop ? "" : "bg-bg-hover text-text-primary hover:bg-border"}`}
              title="Dismiss"
              aria-label="Dismiss"
            >
              <X size={iconSize} />
              <span className={labelClass}>Dismiss</span>
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => handleStatusClick("active")}
            disabled={pending}
            className={`${buttonBase} ${desktop ? "hover:bg-accent-surface hover:text-accent" : "bg-accent-surface text-accent hover:bg-accent-border/30"}`}
            title="Reactivate"
            aria-label="Reactivate"
          >
            <RotateCcw size={iconSize} />
            <span className={labelClass}>Reactivate</span>
          </button>
        )}
        <button
          type="button"
          onClick={handleMoreClick}
          disabled={pending}
          className={moreButtonBase}
          aria-expanded={moreOpen}
          aria-controls={`feed-card-${card.id}-more-actions`}
          aria-label="More actions"
          title="More actions"
        >
          <MoreHorizontal size={iconSize} />
          <span className={moreLabelClass}>More</span>
        </button>
      </>
    );
  };

  const renderMoreMenu = () => (
    menuPosition && (
      <ContextMenu position={menuPosition} onClose={() => setMenuPosition(null)}>
        <div id={`feed-card-${card.id}-more-actions`}>
        {card.status === "active" && hasPromptAction && (
          <CtxItem
            icon={<CheckCircle2 size={16} />}
            label="Mark done"
            onClick={() => handleStatusClick("done")}
            disabled={pending}
            className="text-success"
          />
        )}
        {card.taskId && (
          <CtxItem
            label="Open task"
            onClick={() => {
              setMenuPosition(null);
              onSelectTask(card.taskId!);
            }}
          />
        )}
        {card.sessionId && (
          <CtxItem
            icon={<MessageSquare size={16} />}
            label="Open session"
            onClick={() => {
              setMenuPosition(null);
              onSelectSession(card.sessionId!, card.taskId ?? undefined);
            }}
          />
        )}
        {relatedLinks.map((link, index) => (
          <CtxItem
            key={`${link.url}-${index}`}
            icon={index === 0 && card.url ? <ExternalLink size={16} /> : <LinkIcon size={16} />}
            label={link.label}
            onClick={() => {
              setMenuPosition(null);
              window.open(link.url, "_blank", "noopener,noreferrer");
            }}
          />
        ))}
        {(card.status === "active" && hasPromptAction) || hasSecondaryActions ? <CtxDivider /> : null}
        <CtxItem
          icon={<Trash2 size={16} />}
          label="Delete card"
          onClick={handleDeleteClick}
          disabled={pending}
          className="text-error"
        />
        </div>
      </ContextMenu>
    )
  );

  return (
    <div className="relative rounded-xl">
      <article
        className={`${UI.surface.card} relative overflow-hidden p-4 pl-5 space-y-4 transition-colors ${CARD_STATUS_CLASS[card.status]} ${highPriorityClass} ${pending ? "opacity-80" : ""}`}
        aria-busy={pending || undefined}
      >
        <div aria-hidden="true" className={`absolute inset-y-0 left-0 w-1 ${CARD_RAIL_CLASS[card.status]}`} />
        <header className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <div
              className={`mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full border text-xs font-semibold ${avatarClass}`}
              aria-hidden="true"
            >
              {metadataSource ? initialsForSource(metadataSource) : renderKindAvatarIcon(card.kind)}
            </div>
            <div className="min-w-0 space-y-1.5">
              <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs leading-tight text-text-muted">
                {metadataSource && (
                  <>
                    <span className="max-w-[11rem] truncate font-semibold text-text-primary sm:max-w-[18rem]" title={metadataSource}>
                      {metadataSource}
                    </span>
                    <span aria-hidden="true">·</span>
                  </>
                )}
                <span className={metadataSource ? "" : "font-semibold text-text-primary"}>{kindLabel}</span>
                {!pending && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>{timestamp.verb}</span>
                    <time dateTime={timestamp.iso} title={formatAbsoluteTime(timestamp.iso)}>
                      {formatRelativeTime(timestamp.iso)}
                    </time>
                  </>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {card.pinned && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-accent-surface px-2 py-0.5 text-[11px] font-medium text-accent">
                    <Pin size={11} />
                    Pinned
                  </span>
                )}
                {card.status !== "active" && (
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_CLASS[card.status]}`}>
                    {statusLabel(card.status)}
                  </span>
                )}
                {pending && (
                  <span className="rounded-full bg-bg-hover px-2 py-0.5 text-[11px] font-medium text-text-muted">
                    Saving...
                  </span>
                )}
                {card.priority === "high" && (
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${PRIORITY_CLASS[card.priority]}`}>
                    High priority
                  </span>
                )}
              </div>
            </div>
          </div>
          <div className="hidden shrink-0 items-center gap-1 sm:flex">
            {renderStatusActions("desktop")}
          </div>
        </header>

        <div className="space-y-2">
          <h3 className={`text-base font-semibold leading-snug sm:text-[15px] ${TITLE_STATUS_CLASS[card.status]}`}>{card.title}</h3>
          {card.body && (
            <p className={`whitespace-pre-wrap text-sm leading-relaxed ${BODY_STATUS_CLASS[card.status]}`}>{card.body}</p>
          )}
        </div>

        {card.visual && (
          <div className="overflow-hidden rounded-xl border border-border/70 bg-bg-primary/70 p-2">
            <VisualArtifactCard visual={card.visual} />
          </div>
        )}

        <div className={actionSectionClass}>
          <div
              className={`grid gap-2 sm:hidden ${card.status === "active" ? "grid-cols-[minmax(0,1fr)_minmax(0,1fr)_2.75rem]" : "grid-cols-[minmax(0,1fr)_2.75rem]"}`}
          >
            {renderStatusActions("mobile")}
          </div>

          {(hasPromptAction || card.taskId || card.sessionId || relatedLinks.length > 0) && (
            <div className="hidden flex-wrap items-center gap-1.5 sm:flex">
              {hasPromptAction && (
                <button
                  type="button"
                  onClick={() => onAction(card)}
                  disabled={pending}
                  className={`${UI.button.primary} inline-flex min-h-11 items-center gap-1.5 px-3 text-sm disabled:cursor-not-allowed disabled:opacity-60 sm:min-h-8 sm:px-2.5 sm:text-xs`}
                >
                  <MessageSquare size={14} />
                  {card.action?.label ?? DEFAULT_FEED_ACTION_LABEL}
                </button>
              )}
              {card.taskId && (
                <button
                  type="button"
                  onClick={() => onSelectTask(card.taskId!)}
                  className={LINK_BUTTON_CLASS}
                >
                  Open task
                </button>
              )}
              {card.sessionId && (
                <button
                  type="button"
                  onClick={() => onSelectSession(card.sessionId!, card.taskId ?? undefined)}
                  className={LINK_BUTTON_CLASS}
                >
                  <MessageSquare size={14} />
                  Open session
                </button>
              )}
              {relatedLinks.map((link, index) => (
                <a
                  key={`${link.url}-${index}`}
                  href={link.url}
                  target="_blank"
                  rel="noreferrer"
                  className={LINK_BUTTON_CLASS}
                >
                  {index === 0 && card.url ? <ExternalLink size={14} /> : <LinkIcon size={14} />}
                  {link.label}
                </a>
              ))}
            </div>
          )}
        </div>
      </article>
      {moreOpen && renderMoreMenu()}
    </div>
  );
}
