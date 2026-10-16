import { Component, createRef, type ReactNode, type RefObject } from "react";
import { getSafeScrollTop } from "./useChatScroll";

export const SCROLL_REST_MS = 120;
const SCROLL_REST_TIMEOUT_MS = 5_000;
const VIEWPORT_ANCHOR_ROWS = 4;
const VIEWPORT_EDGE_PX = 1;

interface ViewportAnchor {
  row: Element;
  offset: number;
}

function browserAnchorsScrolling(): boolean {
  return typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("overflow-anchor", "auto");
}

function captureViewportAnchors(scroller: HTMLElement, rows: Element, limit = VIEWPORT_ANCHOR_ROWS): ViewportAnchor[] {
  const top = scroller.getBoundingClientRect().top;
  const candidates = rows.children;
  let first = 0;
  let end = candidates.length;
  while (first < end) {
    const middle = Math.floor((first + end) / 2);
    if (candidates[middle].getBoundingClientRect().bottom > top + VIEWPORT_EDGE_PX) end = middle;
    else first = middle + 1;
  }
  const anchors: ViewportAnchor[] = [];
  for (let index = first; index < candidates.length && anchors.length < limit; index += 1) {
    anchors.push({ row: candidates[index], offset: candidates[index].getBoundingClientRect().top - top });
  }
  return anchors;
}

function shiftOf(scroller: HTMLElement, { row, offset }: ViewportAnchor): number {
  return row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - offset;
}

function startsAboveView(anchor: ViewportAnchor): boolean {
  return anchor.offset < -VIEWPORT_EDGE_PX;
}

/** Holds the reader's place across row replacement and late layout changes above the viewport. */
export class ViewportKeeper extends Component<{
  scrollerRef: RefObject<HTMLElement | null>;
  className?: string;
  shouldKeep: () => boolean;
  atRest: () => boolean;
  shift: (scroller: HTMLElement, delta: number) => void;
  children: ReactNode;
}> {
  private readonly rows = createRef<HTMLDivElement>();
  private observer: ResizeObserver | null = null;
  private settled: { anchor: ViewportAnchor | undefined; scrollTop: number } | null = null;
  private settling = false;

  componentDidMount() {
    if (browserAnchorsScrolling() || typeof ResizeObserver === "undefined" || !this.rows.current) return;
    this.observer = new ResizeObserver(() => {
      this.holdSettled();
      this.settle();
    });
    this.observer.observe(this.rows.current);
    this.settleSoon();
  }

  getSnapshotBeforeUpdate(): { anchors: ViewportAnchor[]; scrollTop: number } | null {
    this.holdSettled();
    const scroller = this.props.scrollerRef.current;
    const rows = this.rows.current;
    if (!scroller || !rows || !this.props.shouldKeep()) return null;
    const anchors = captureViewportAnchors(scroller, rows);
    // A row that starts inside the viewport is a stronger anchor than one growing across its top.
    if (anchors.length > 1 && startsAboveView(anchors[0])) anchors.push(anchors.shift()!);
    return { anchors, scrollTop: getSafeScrollTop(scroller) };
  }

  componentDidUpdate(_props: unknown, _state: unknown, before: { anchors: ViewportAnchor[]; scrollTop: number } | null) {
    const scroller = this.props.scrollerRef.current;
    const anchor = before?.anchors.find(({ row }) => this.rows.current?.contains(row));
    if (scroller && before && anchor) {
      const delta = shiftOf(scroller, anchor);
      const heldByBrowser = startsAboveView(anchor) && getSafeScrollTop(scroller) !== before.scrollTop;
      if (Math.abs(delta) >= 1 && !heldByBrowser) this.props.shift(scroller, delta);
    }
    this.settleSoon();
  }

  componentWillUnmount() {
    this.observer?.disconnect();
    this.observer = null;
  }

  moved() {
    const scroller = this.props.scrollerRef.current;
    if (this.observer && scroller && this.settled?.scrollTop !== getSafeScrollTop(scroller)) this.settle();
  }

  private holdSettled() {
    const scroller = this.props.scrollerRef.current;
    const settled = this.settled;
    if (!scroller || !settled?.anchor || !this.rows.current?.contains(settled.anchor.row)) return;
    if (settled.scrollTop !== getSafeScrollTop(scroller) || !this.props.atRest()) return;
    const delta = shiftOf(scroller, settled.anchor);
    if (Math.abs(delta) >= 1) this.props.shift(scroller, delta);
  }

  private settle() {
    const scroller = this.props.scrollerRef.current;
    const rows = this.rows.current;
    this.settled = scroller && rows
      ? { anchor: captureViewportAnchors(scroller, rows, 1)[0], scrollTop: getSafeScrollTop(scroller) }
      : null;
  }

  private settleSoon() {
    if (!this.observer || this.settling) return;
    this.settling = true;
    queueMicrotask(() => {
      this.settling = false;
      if (this.observer) this.settle();
    });
  }

  render() {
    return <div ref={this.rows} className={this.props.className}>{this.props.children}</div>;
  }
}

export interface ScrollActivity {
  movedAt: number;
  touching: boolean;
}

/** Let scroll events queued behind long tasks run before an older page shifts the transcript. */
export function scrollerAtRest(activity: ScrollActivity): Promise<void> {
  const giveUpAt = Date.now() + SCROLL_REST_TIMEOUT_MS;
  return new Promise((resolve) => {
    const check = () => {
      if (Date.now() >= giveUpAt) {
        resolve();
        return;
      }
      const wait = activity.touching ? SCROLL_REST_MS : activity.movedAt + SCROLL_REST_MS - Date.now();
      if (wait > 0) {
        setTimeout(check, wait);
        return;
      }
      const { movedAt } = activity;
      window.requestAnimationFrame(() => {
        if (activity.movedAt === movedAt && !activity.touching) resolve();
        else check();
      });
    };
    check();
  });
}
