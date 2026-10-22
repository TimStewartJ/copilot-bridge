import { SCROLL_REST_MS, type ScrollActivity } from "./TranscriptViewport";

/**
 * A browser that anchors scrolling moves the view itself when content above it changes height,
 * and that is a scroll event too. While the reader's view still starts at the reply they are
 * parked on, the event is the browser holding it in place, not the reader moving.
 */
export function isHeldOnParkedReply(parkedTop: number | null, scrollTop: number, thresholdPx: number): boolean {
  return parkedTop != null && Math.abs(parkedTop - scrollTop) <= thresholdPx;
}

/**
 * Fetch the previous page once the reader is heading for the top and within a screen of it, so it
 * is usually in place before they get there. Only moving up asks: a chat often opens near the top
 * of what is loaded (a long reply under a collapsed run), and reading down from there must not
 * fetch anything. A failed page waits for Retry instead of refiring on every scroll event.
 */
export function shouldPrefetchOlderPage({ previousScrollTop, scrollTop, clientHeight, loadFailed }: {
  previousScrollTop: number;
  scrollTop: number;
  clientHeight: number;
  loadFailed: boolean;
}): boolean {
  return scrollTop < previousScrollTop && !loadFailed && scrollTop < clientHeight;
}

/**
 * Neither a window too short to scroll nor a reader parked at its very top produces a scroll event
 * that could ask for more, so such a window keeps filling from the top. A scroller that has not
 * been laid out yet asks for nothing.
 */
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
