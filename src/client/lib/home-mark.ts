// Home combines the brief and the conversation on desktop; phone navigation separates them.

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

export interface HomeMark {
  kind: "unread" | "working" | "unread-working";
  label: string;
}

export function homeMarkFor({ helmReplied, newBrief, replying, updating }: {
  helmReplied?: boolean; newBrief?: boolean; replying?: boolean; updating?: boolean;
}): HomeMark | null {
  const unread = helmReplied && newBrief ? "Helm replied and wrote a new brief" : helmReplied ? "Helm replied" : newBrief ? "New brief from Helm" : "";
  const work = [updating && "Updating brief", replying && "Helm is replying"].filter(Boolean).join("; ");
  if (!unread && !work) return null;
  return { kind: work ? (unread ? "unread-working" : "working") : "unread", label: [unread, work].filter(Boolean).join("; ") };
}
