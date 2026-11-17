import { SCROLL_REST_MS, type ScrollActivity } from "./TranscriptViewport";

/** Scroll anchoring fires scroll events holding a parked reply; that isn't the reader moving. */
export function isHeldOnParkedReply(parkedTop: number | null, scrollTop: number, thresholdPx: number): boolean {
  return parkedTop != null && Math.abs(parkedTop - scrollTop) <= thresholdPx;
}

/** Only when moving up within a screen of the top (chats open there); failures wait for Retry. */
export function shouldPrefetchOlderPage({ previousScrollTop, scrollTop, clientHeight, loadFailed }: {
  previousScrollTop: number;
  scrollTop: number;
  clientHeight: number;
  loadFailed: boolean;
}): boolean {
  return scrollTop < previousScrollTop && !loadFailed && scrollTop < clientHeight;
}

/** Unscrollable or parked at top: no scroll event can ask, so keep filling. Unlaid-out: no. */
export function shouldFillFromTop({ clientHeight, maxScrollTop, scrollTop }: {
  clientHeight: number;
  maxScrollTop: number;
  scrollTop: number;
}): boolean {
  if (!(clientHeight > 0)) return false;
  return !(maxScrollTop > 0 && scrollTop > 0);
}

/** The reader is neither touching the transcript nor has scrolled it within the last moment. */
export function isTranscriptAtRest({ movedAt, touching }: ScrollActivity, now: number): boolean {
  return !touching && now - movedAt >= SCROLL_REST_MS;
}
