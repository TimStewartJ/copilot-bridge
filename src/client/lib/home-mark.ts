// The Home icon's mark: Home is Helm's brief and its conversation, so the mark says Helm has something new.

export interface HelmReplyState {
  sessionId: string;
  lastReplyAt: string | null;
  handsFree: boolean;
}

/**
 * A reply in the current Helm conversation that Tim has not had on screen. Until read state has loaded
 * every conversation looks unread, so nothing counts; nor does a reply hands-free is reading out.
 */
export function isHelmReplyUnread(
  current: HelmReplyState | null | undefined,
  readStateHydrated: boolean,
  isUnread: (sessionId: string, activityTime?: string) => boolean,
): boolean {
  if (!readStateHydrated || !current?.lastReplyAt || current.handsFree) return false;
  return isUnread(current.sessionId, current.lastReplyAt);
}

/** What the mark stands for, for the icon's label and tooltip; null when there is no mark. */
export function describeHomeMark({ helmReplied, newBrief }: { helmReplied: boolean; newBrief: boolean }): string | null {
  if (helmReplied && newBrief) return "Helm replied and wrote a new brief";
  if (helmReplied) return "Helm replied";
  if (newBrief) return "New brief from Helm";
  return null;
}
