const DRAFT_PREFIX = "draft:";
const TASK_DRAFT_PREFIX = "draft:task:";
const QUICK_CHAT_DRAFT_KEY = "draft:quickchat";

export function getDraftComposerKey(taskId?: string | null): string {
  return taskId ? `${TASK_DRAFT_PREFIX}${taskId}` : QUICK_CHAT_DRAFT_KEY;
}

export function isDraftComposerKey(composerKey: string): boolean {
  return composerKey.startsWith(DRAFT_PREFIX);
}

export function getTaskIdFromDraftComposerKey(composerKey: string): string | undefined {
  return composerKey.startsWith(TASK_DRAFT_PREFIX)
    ? composerKey.slice(TASK_DRAFT_PREFIX.length)
    : undefined;
}

export function getComposerKeyFromPathname(pathname: string): string | null {
  const taskDraftMatch = pathname.match(/^\/tasks\/([^/]+)\/sessions\/new$/);
  if (taskDraftMatch) {
    return getDraftComposerKey(taskDraftMatch[1]);
  }

  if (pathname === "/sessions/new") {
    return getDraftComposerKey();
  }

  const taskSessionMatch = pathname.match(/^\/tasks\/[^/]+\/sessions\/(.+)$/);
  if (taskSessionMatch) {
    return taskSessionMatch[1];
  }

  const sessionMatch = pathname.match(/^\/sessions\/(.+)$/);
  return sessionMatch?.[1] ?? null;
}
