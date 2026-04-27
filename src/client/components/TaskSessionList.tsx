import { useMemo } from "react";
import type { BatchAction, Session, Task } from "../api";
import { unlinkResource } from "../api";
import { sortTaskSessions } from "../task-panel-preview";
import SessionList from "./SessionList";

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
  onDuplicateSession?: (sessionId: string) => void;
  onReloadSession?: (sessionId: string) => void;
  onMarkUnread?: (sessionId: string) => void;
  onBulkAction?: (action: BatchAction, sessionIds: string[]) => void;
  hasDraft?: (sessionId: string) => boolean;
  onRequestArchived?: () => void;
  archivedLoaded?: boolean;
  archivedLoading?: boolean;
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
  onDuplicateSession,
  onReloadSession,
  onMarkUnread,
  onBulkAction,
  hasDraft,
  onRequestArchived,
  archivedLoaded,
  archivedLoading = false,
  className,
  showNewButton = true,
}: TaskSessionListProps) {
  const sortedSessions = useMemo(
    () => sortTaskSessions(linkedSessions),
    [linkedSessions],
  );
  const hasUnloadedLinkedSessions = useMemo(() => {
    const linkedSessionIds = new Set(linkedSessions.map((session) => session.sessionId));
    return task.sessionIds.some((sessionId) => !linkedSessionIds.has(sessionId));
  }, [linkedSessions, task.sessionIds]);
  const taskSessionArchivedLoaded = hasUnloadedLinkedSessions && archivedLoading
    ? false
    : hasUnloadedLinkedSessions
      ? archivedLoaded ?? false
      : true;
  const requestTaskArchivedSessions = hasUnloadedLinkedSessions ? onRequestArchived : undefined;

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
            onTasksChanged?.();
          })
      }
      onDeleteSession={onDeleteSession}
      onDuplicateSession={onDuplicateSession}
      onReloadSession={onReloadSession}
      onMarkUnread={onMarkUnread}
      onBulkAction={onBulkAction}
      hasDraft={hasDraft}
      onRequestArchived={requestTaskArchivedSessions}
      archivedLoaded={taskSessionArchivedLoaded}
      archivedLoading={hasUnloadedLinkedSessions && archivedLoading}
      showNewButton={showNewButton}
      className={className}
    />
  );
}
