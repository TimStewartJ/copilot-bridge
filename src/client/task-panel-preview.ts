import { getSessionActivityTime, getSessionRunState, type ChecklistItem, type Session } from "./api";
import { deadlineUrgency } from "./checklist-helpers";

export const TASK_PANEL_SESSION_PREVIEW_LIMIT = 4;
export const TASK_PANEL_CHECKLIST_PREVIEW_LIMIT = 3;

function compareIsoAscending(left?: string, right?: string): number {
  return (left ?? "").localeCompare(right ?? "");
}

function compareIsoDescending(left?: string, right?: string): number {
  return compareIsoAscending(right, left);
}

function getSessionPreviewRank(
  session: Session,
  isUnread?: (sessionId: string, modifiedTime?: string) => boolean,
): number {
  const runState = getSessionRunState(session);
  if (runState === "stalled") return 0;
  if (runState === "busy") return 1;
  if (isUnread?.(session.sessionId, getSessionActivityTime(session))) return 2;
  return 3;
}

export function sortTaskPanelSessions(
  sessions: Session[],
  activeSessionId: string | null,
  isUnread?: (sessionId: string, modifiedTime?: string) => boolean,
): Session[] {
  const currentSession = activeSessionId
    ? sessions.find((session) => session.sessionId === activeSessionId)
    : undefined;

  const remainingSessions = sessions.filter(
    (session) => session.sessionId !== currentSession?.sessionId && !session.archived,
  );

  const sortedRemainingSessions = [...remainingSessions].sort((left, right) => {
    const rankDiff = getSessionPreviewRank(left, isUnread) - getSessionPreviewRank(right, isUnread);
    if (rankDiff !== 0) return rankDiff;

    const activityDiff = compareIsoDescending(
      getSessionActivityTime(left),
      getSessionActivityTime(right),
    );
    if (activityDiff !== 0) return activityDiff;

    return left.sessionId.localeCompare(right.sessionId);
  });

  return currentSession
    ? [currentSession, ...sortedRemainingSessions]
    : sortedRemainingSessions;
}

function getChecklistPreviewRank(checklistItem: ChecklistItem): number {
  const urgency = deadlineUrgency(checklistItem.deadline, checklistItem.done);
  if (urgency === "overdue") return 0;
  if (urgency === "soon") return 1;
  return 2;
}

function compareChecklistPreviewItems(left: ChecklistItem, right: ChecklistItem): number {
  const leftRank = getChecklistPreviewRank(left);
  const rightRank = getChecklistPreviewRank(right);
  if (leftRank !== rightRank) return leftRank - rightRank;

  if (leftRank < 2) {
    const deadlineDiff = compareIsoAscending(left.deadline, right.deadline);
    if (deadlineDiff !== 0) return deadlineDiff;
  }

  const createdDiff = compareIsoAscending(left.createdAt, right.createdAt);
  if (createdDiff !== 0) return createdDiff;

  const orderDiff = left.order - right.order;
  if (orderDiff !== 0) return orderDiff;

  return left.id.localeCompare(right.id);
}

export interface TaskPanelChecklistPreview {
  openPreviewItems: ChecklistItem[];
  highlightedCompletedItem: ChecklistItem | null;
  openCount: number;
  completedCount: number;
  overdueCount: number;
  dueSoonCount: number;
  hiddenOpenCount: number;
}

export function getTaskPanelChecklistPreview(
  checklistItems: ChecklistItem[],
  options: { highlightId?: string | null; maxOpenItems?: number } = {},
): TaskPanelChecklistPreview {
  const maxOpenItems = Math.max(options.maxOpenItems ?? TASK_PANEL_CHECKLIST_PREVIEW_LIMIT, 1);
  const openChecklistItems = checklistItems
    .filter((checklistItem) => !checklistItem.done)
    .sort(compareChecklistPreviewItems);
  const completedChecklistItems = checklistItems.filter((checklistItem) => checklistItem.done);

  let openPreviewItems = openChecklistItems.slice(0, maxOpenItems);
  let highlightedCompletedItem: ChecklistItem | null = null;

  if (options.highlightId) {
    const highlightedOpenItem = openChecklistItems.find(
      (checklistItem) => checklistItem.id === options.highlightId,
    );
    if (highlightedOpenItem && !openPreviewItems.some((checklistItem) => checklistItem.id === highlightedOpenItem.id)) {
      if (openPreviewItems.length < maxOpenItems) {
        openPreviewItems = [...openPreviewItems, highlightedOpenItem];
      } else {
        openPreviewItems = [
          ...openPreviewItems.slice(0, maxOpenItems - 1),
          highlightedOpenItem,
        ];
      }
    }

    if (!highlightedOpenItem) {
      highlightedCompletedItem = completedChecklistItems.find(
        (checklistItem) => checklistItem.id === options.highlightId,
      ) ?? null;
    }
  }

  let overdueCount = 0;
  let dueSoonCount = 0;
  for (const checklistItem of openChecklistItems) {
    const urgency = deadlineUrgency(checklistItem.deadline, checklistItem.done);
    if (urgency === "overdue") overdueCount += 1;
    else if (urgency === "soon") dueSoonCount += 1;
  }

  return {
    openPreviewItems,
    highlightedCompletedItem,
    openCount: openChecklistItems.length,
    completedCount: completedChecklistItems.length,
    overdueCount,
    dueSoonCount,
    hiddenOpenCount: Math.max(openChecklistItems.length - openPreviewItems.length, 0),
  };
}
