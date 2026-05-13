import type { FeedCard as FeedCardData } from "./api";

export const DEFAULT_FEED_ACTION_LABEL = "Start session";

export function resolveFeedActionTaskId(card: Pick<FeedCardData, "taskId" | "action">): string | null {
  if (!card.action) return null;
  return Object.prototype.hasOwnProperty.call(card.action, "taskId")
    ? card.action.taskId ?? null
    : card.taskId ?? null;
}
