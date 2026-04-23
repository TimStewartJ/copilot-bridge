export interface SessionNavigationTarget {
  sessionId: string;
  taskId?: string | null;
}

export function getSessionPath({ sessionId, taskId }: SessionNavigationTarget): string {
  return taskId
    ? `/tasks/${taskId}/sessions/${sessionId}`
    : `/sessions/${sessionId}`;
}
