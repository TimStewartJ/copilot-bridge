// Native rendering for links to Bridge's own things. Agents write `bridge://session/<id>`,
// `bridge://task/<id>` or `bridge://doc/<path>` (and sometimes plain app routes); chat shows
// them as live chips and cards that navigate inside the app instead of opening a new tab.
import { createContext, useContext, useMemo, type MouseEvent, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { defaultUrlTransform } from "react-markdown";
import { BookOpen, ListTodo, MessageSquare, ShipWheel } from "lucide-react";
import {
  bridgeLinkToAppPath,
  isBridgeSchemeLink,
  parseBridgeLink,
  type BridgeLinkTarget,
} from "../../shared/bridge-links";
import { API_BASE, getSessionActivityTime, getSessionRunState, type Session, type Task } from "../api";
import { useSessionsQuery } from "../hooks/queries/useSessions";
import { useTasksQuery } from "../hooks/queries/useTasks";
import { getSessionPath } from "../lib/session-path";
import { timeAgo } from "../time";
import { DS, cx } from "../design/tokens";


export interface BridgeReferenceContextValue {
  isUnread?: (sessionId: string, activityTime?: string) => boolean;
}

/** Lets references show unread state, which lives in the app shell rather than a query. */
export const BridgeReferenceContext = createContext<BridgeReferenceContextValue>({});

/** react-markdown drops unknown URL schemes; keep `bridge:` so links reach the renderer. */
export function bridgeUrlTransform(url: string): string {
  return isBridgeSchemeLink(url) ? url : defaultUrlTransform(url);
}

export function parseChatBridgeLink(href: string | null | undefined): BridgeLinkTarget | null {
  return parseBridgeLink(href, {
    origin: typeof window === "undefined" ? undefined : window.location?.origin,
    basePath: API_BASE,
  });
}

type ReferenceTone = "waiting" | "running" | "stalled" | "unread" | "idle" | "archived" | "unknown";

const TONE_DOT: Record<ReferenceTone, string> = {
  waiting: "bg-warning",
  running: "bg-info animate-pulse",
  stalled: "bg-error",
  unread: "bg-success",
  idle: "bg-text-faint/60",
  archived: "bg-text-faint/40",
  unknown: "bg-text-faint/40",
};

const TONE_LABEL: Record<ReferenceTone, string> = {
  waiting: "Waiting on you",
  running: "Running",
  stalled: "Stalled",
  unread: "Unread reply",
  idle: "Idle",
  archived: "Archived",
  unknown: "Not in your active sessions",
};

export interface ResolvedBridgeReference {
  kind: BridgeLinkTarget["kind"];
  /** In-app route without the deployment base path. */
  path: string;
  title: string;
  found: boolean;
  tone?: ReferenceTone;
  detail?: string;
  meta?: string;
}

function findSession(sessions: readonly Session[], ref: string): Session | undefined {
  return sessions.find((session) => session.sessionId === ref)
    ?? (ref.length >= 8 ? sessions.find((session) => session.sessionId.startsWith(ref)) : undefined);
}

export function resolveBridgeReference(
  target: BridgeLinkTarget,
  data: {
    sessions: readonly Session[];
    tasks: readonly Task[];
    isUnread?: BridgeReferenceContextValue["isUnread"];
    label?: string;
  },
): ResolvedBridgeReference {
  const label = data.label?.trim();
  switch (target.kind) {
    case "session": {
      const session = findSession(data.sessions, target.sessionId);
      if (!session) {
        return {
          kind: "session",
          path: bridgeLinkToAppPath(target),
          title: label || `Session ${target.sessionId.slice(0, 8)}`,
          found: false,
          tone: "unknown",
        };
      }
      const taskId = target.taskId ?? session.linkedTaskIds?.[0];
      const task = taskId ? data.tasks.find((candidate) => candidate.id === taskId) : undefined;
      const runState = getSessionRunState(session);
      const tone: ReferenceTone = session.archived
        ? "archived"
        : session.needsUserInput
          ? "waiting"
          : runState === "stalled"
            ? "stalled"
            : runState === "busy"
              ? "running"
              : data.isUnread?.(session.sessionId, getSessionActivityTime(session))
                ? "unread"
                : "idle";
      return {
        kind: "session",
        path: getSessionPath({ sessionId: session.sessionId, taskId: task?.id }),
        title: session.summary?.trim() || label || "Untitled session",
        found: true,
        tone,
        detail: tone === "running" && session.intentText ? session.intentText : undefined,
        meta: [task?.title, timeAgo(getSessionActivityTime(session))].filter(Boolean).join(" · ") || undefined,
      };
    }
    case "task": {
      const task = data.tasks.find((candidate) => candidate.id === target.taskId);
      if (!task) {
        return { kind: "task", path: bridgeLinkToAppPath(target), title: label || "Task", found: false, tone: "unknown" };
      }
      const linked = data.sessions.filter((session) => task.sessionIds.includes(session.sessionId) && !session.archived);
      const waiting = linked.filter((session) => session.needsUserInput).length;
      const running = linked.filter((session) => !session.needsUserInput && getSessionRunState(session) !== "idle").length;
      const unread = linked.filter((session) => (
        !session.needsUserInput
        && getSessionRunState(session) === "idle"
        && data.isUnread?.(session.sessionId, getSessionActivityTime(session))
      )).length;
      const tone: ReferenceTone = task.status === "archived"
        ? "archived"
        : waiting > 0 ? "waiting" : running > 0 ? "running" : unread > 0 ? "unread" : "idle";
      const counts = [
        waiting ? `${waiting} waiting` : "",
        running ? `${running} running` : "",
        unread ? `${unread} unread` : "",
      ].filter(Boolean).join(" · ");
      return {
        kind: "task",
        path: bridgeLinkToAppPath(target),
        title: task.title.trim() || label || "Untitled task",
        found: true,
        tone,
        detail: task.nextAction?.trim() ? `${task.deferred ? "When resumed" : "Next step"}: ${task.nextAction.trim()}` : task.waitingOn?.trim() ? `Waiting for: ${task.waitingOn.trim()}` : undefined,
        meta: [task.deferred ? "Deferred" : "", counts || (task.completedAt ? "Completed" : "")].filter(Boolean).join(" · ") || undefined,
      };
    }
    case "doc": {
      const name = target.path.split("/").filter(Boolean).at(-1) ?? target.path;
      return { kind: "doc", path: bridgeLinkToAppPath(target), title: label || name, found: true, meta: target.path };
    }
    case "helm":
      return { kind: "helm", path: bridgeLinkToAppPath(target), title: label || "Helm", found: true };
  }
}

const KIND_ICON = { session: MessageSquare, task: ListTodo, doc: BookOpen, helm: ShipWheel } as const;
const KIND_NAME = { session: "Session", task: "Task", doc: "Doc", helm: "Helm" } as const;

function useResolvedReference(target: BridgeLinkTarget, label: string | undefined): ResolvedBridgeReference {
  const { isUnread } = useContext(BridgeReferenceContext);
  const needsData = target.kind === "session" || target.kind === "task";
  const active = useSessionsQuery(false, { enabled: needsData });
  const tasks = useTasksQuery();
  const missingFromActive = target.kind === "session"
    && active.isSuccess
    && !findSession(active.data ?? [], target.sessionId);
  // Only a reference the active list can't explain pays for the archived list.
  const archived = useSessionsQuery(true, { enabled: missingFromActive, refetchInterval: false, refetchOnWindowFocus: false });
  return useMemo(() => resolveBridgeReference(target, {
    sessions: [...(active.data ?? []), ...(missingFromActive ? archived.data ?? [] : [])],
    tasks: tasks.data ?? [],
    isUnread,
    label,
  }), [active.data, archived.data, isUnread, label, missingFromActive, target, tasks.data]);
}

function useReferenceNavigation(path: string) {
  const navigate = useNavigate();
  return {
    // A real href (under the deployment base path) keeps open-in-new-tab and copy-link working.
    href: `${API_BASE}${path}`,
    onClick: (event: MouseEvent<HTMLAnchorElement>) => {
      // Modified clicks keep their browser meaning (new tab, new window, download).
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      navigate(path);
    },
  };
}

function describeReference(reference: ResolvedBridgeReference): string {
  return [KIND_NAME[reference.kind], reference.title, reference.tone ? TONE_LABEL[reference.tone] : ""].filter(Boolean).join(", ");
}

/** Inline form: sits in a sentence like a link, but carries the item's live state. */
export function BridgeReferenceChip({ target, label }: { target: BridgeLinkTarget; label?: string; children?: ReactNode }) {
  const reference = useResolvedReference(target, label);
  const navigation = useReferenceNavigation(reference.path);
  const Icon = KIND_ICON[reference.kind];
  return (
    <a
      {...navigation}
      data-bridge-reference={reference.kind}
      data-bridge-reference-state={reference.tone ?? "none"}
      aria-label={describeReference(reference)}
      title={[reference.tone ? TONE_LABEL[reference.tone] : "", reference.detail, reference.meta].filter(Boolean).join(" · ") || undefined}
      className={cx(DS.surface.inset, DS.focus, "not-prose mx-0.5 inline-flex max-w-full items-center gap-1 px-1.5 py-px align-baseline text-[0.92em] font-medium no-underline transition-colors hover:bg-surface-selected", reference.found ? "text-text-primary" : "text-text-muted")}
    >
      <Icon size={12} aria-hidden="true" className="shrink-0 text-text-muted" />
      <span className="truncate">{reference.title}</span>
      {reference.tone && reference.tone !== "idle" && reference.tone !== "unknown" && (
        <span aria-hidden="true" className={cx("h-1.5 w-1.5 shrink-0 rounded-full", TONE_DOT[reference.tone])} />
      )}
    </a>
  );
}

/** Block form: a link alone on its line becomes a card with status, detail and context. */
export function BridgeReferenceCard({ target, label }: { target: BridgeLinkTarget; label?: string }) {
  const reference = useResolvedReference(target, label);
  const navigation = useReferenceNavigation(reference.path);
  const Icon = KIND_ICON[reference.kind];
  return (
    <div className="not-prose my-2 max-w-xl">
      <a
        {...navigation}
        data-bridge-reference={reference.kind}
        data-bridge-reference-state={reference.tone ?? "none"}
        data-bridge-reference-card="true"
        aria-label={describeReference(reference)}
        className={cx(DS.surface.detail, "block border-l-2 border-l-accent px-3 py-2.5 no-underline transition-colors hover:bg-bg-hover")}
      >
        <span className="flex items-center gap-2">
          <Icon size={13} aria-hidden="true" className="shrink-0 text-text-muted" />
          <span className={cx(DS.text.sectionLabel, "font-semibold text-text-muted")}>{KIND_NAME[reference.kind]}</span>
          {reference.tone && (
            <span className="ml-auto inline-flex items-center gap-1.5 text-[11px] text-text-muted">
              <span aria-hidden="true" className={cx("h-1.5 w-1.5 rounded-full", TONE_DOT[reference.tone])} />
              {TONE_LABEL[reference.tone]}
            </span>
          )}
        </span>
        <span className={cx("mt-1 block text-sm font-medium leading-snug", reference.found ? "text-text-primary" : "text-text-muted")}>
          {reference.title}
        </span>
        {reference.detail && <span className="mt-1 block truncate text-xs text-text-secondary">{reference.detail}</span>}
        {reference.meta && <span className="mt-1 block truncate text-[11px] text-text-faint">{reference.meta}</span>}
      </a>
    </div>
  );
}
