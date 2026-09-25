import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "../queryClient";
import type { BatchAction, Session, Task } from "../api";
import { unlinkResource } from "../api";
import { sortTaskSessions } from "../task-panel-preview";
import SessionList from "./SessionList";
import { useTaskArchivedSessionsQuery } from "../hooks/queries/useTaskArchivedSessions";

interface TaskSessionListProps {
  task: Task;
  linkedSessions: Session[];
  activeSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onNewSession: (taskId: string) => void;
  showEmptyState?: boolean;
  isUnread?: (sessionId: string, modifiedTime?: string) => boolean;
  onArchiveSession?: (id: string, archived: boolean) => void;
  archivingIds?: Set<string>;
  exitingIds?: Set<string>;
  onUnlinkFromTask?: (sessionId: string, taskId: string) => void;
  onTasksChanged?: () => void;
  onDeleteSession?: (sessionId: string) => void;
  onForkSession?: (sessionId: string) => void;
  onReloadSession?: (sessionId: string) => void;
  onMarkUnread?: (sessionId: string) => void;
  onBulkAction?: (action: BatchAction, sessionIds: string[]) => void;
  hasDraft?: (sessionId: string) => boolean;
  className?: string;
  /** When false, hides the embedded SessionList new-chat button (e.g. when parent already provides one) */
  showNewButton?: boolean;
}

export default function TaskSessionList({
  task,
  linkedSessions,
  activeSessionId,
  onSelectSession,
  onNewSession,
  showEmptyState = true,
  isUnread,
  onArchiveSession,
  archivingIds,
  exitingIds,
  onUnlinkFromTask,
  onTasksChanged,
  onDeleteSession,
  onForkSession,
  onReloadSession,
  onMarkUnread,
  onBulkAction,
  hasDraft,
  className,
  showNewButton = true,
}: TaskSessionListProps) {
  const queryClient = useQueryClient();
  const [archivedRequestedTaskId, setArchivedRequestedTaskId] = useState<string | null>(null);
  const archivedRequested = archivedRequestedTaskId === task.id;
  const archivedQuery = useTaskArchivedSessionsQuery(task.id, archivedRequested);
  const archivedPages = archivedQuery.data?.pages;
  const archivedTotal = archivedPages?.[archivedPages.length - 1]?.total;
  // The task's active sessions come from the shared list; its archived ones are read a page at a
  // time from the task, never from the global archived list that holds every archived session.
  const sortedSessions = useMemo(() => {
    const active = linkedSessions.filter((session) => !session.archived);
    const activeIds = new Set(active.map((session) => session.sessionId));
    const linkedIds = new Set(task.sessionIds);
    const seenArchivedIds = new Set<string>();
    const archived = (archivedPages ?? [])
      .flatMap((page) => page.sessions)
      .filter((session) => {
        // A page can outlive an unlink made elsewhere; only the task's current links are shown.
        if (!linkedIds.has(session.sessionId)) return false;
        if (activeIds.has(session.sessionId) || seenArchivedIds.has(session.sessionId)) return false;
        seenArchivedIds.add(session.sessionId);
        return true;
      })
      .map((session) => ({ ...session, archived: true }));
    return [...sortTaskSessions(active), ...archived];
  }, [archivedPages, linkedSessions, task.sessionIds]);
  // A link made elsewhere (another tab, an agent) can add an archived session the pages lack.
  const linkedCount = task.sessionIds.length;
  const previousLinkedCountRef = useRef(linkedCount);
  useEffect(() => {
    const previous = previousLinkedCountRef.current;
    previousLinkedCountRef.current = linkedCount;
    if (!archivedRequested || linkedCount <= previous) return;
    void queryClient.invalidateQueries({ queryKey: queryKeys.taskArchivedSessions(task.id) });
  }, [archivedRequested, linkedCount, queryClient, task.id]);
  const archivedLoaded = archivedRequested && archivedQuery.isSuccess;
  const hasArchivedCandidates = task.sessionIds.length > linkedSessions.filter((session) => !session.archived).length;

  return (
    <SessionList
      key={task.id}
      variant="compact"
      sessions={sortedSessions}
      activeSessionId={activeSessionId}
      onSelectSession={onSelectSession}
      onNewSession={() => onNewSession(task.id)}
      newButtonLabel="+ New Chat"
      showEmptyState={showEmptyState}
      isUnread={isUnread}
      onArchiveSession={onArchiveSession}
      archivingIds={archivingIds}
      exitingIds={exitingIds}
      taskContext={task}
      onUnlinkFromTask={
        onUnlinkFromTask
          ?? (async (sessionId, taskId) => {
            await unlinkResource(taskId, {
              type: "session",
              sessionId,
            });
            void queryClient.invalidateQueries({ queryKey: queryKeys.taskArchivedSessions(taskId) });
            onTasksChanged?.();
          })
      }
      onDeleteSession={onDeleteSession}
      onForkSession={onForkSession}
      onReloadSession={onReloadSession}
      onMarkUnread={onMarkUnread}
      onBulkAction={onBulkAction}
      hasDraft={hasDraft}
      onRequestArchived={hasArchivedCandidates || archivedRequested ? () => setArchivedRequestedTaskId(task.id) : undefined}
      archivedLoaded={hasArchivedCandidates || archivedRequested ? archivedLoaded : true}
      archivedLoading={archivedRequested && archivedQuery.isPending}
      archivedTotal={archivedTotal}
      onLoadMoreArchived={archivedQuery.hasNextPage ? () => { void archivedQuery.fetchNextPage(); } : undefined}
      archivedLoadingMore={archivedQuery.isFetchingNextPage}
      archivedError={archivedRequested && (archivedQuery.isError || archivedQuery.isFetchNextPageError)}
      onRetryArchived={() => {
        if (archivedQuery.isFetchNextPageError) void archivedQuery.fetchNextPage();
        else void archivedQuery.refetch();
      }}
      showNewButton={showNewButton}
      className={className}
    />
  );
}
