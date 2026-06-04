import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

const UNREAD_TASK_ROW_SELECTOR = "[data-unread-task-id]";
const SCROLL_EPSILON = 1;

export interface UnreadTaskEdge {
  count: number;
  targetTaskId: string | null;
}

export interface UnreadTaskEdgeState {
  above: UnreadTaskEdge;
  below: UnreadTaskEdge;
}

interface UseUnreadTaskEdgesOptions {
  scopeRef: RefObject<HTMLElement | null>;
  scrollContainerRef?: RefObject<HTMLElement | null>;
  disabled?: boolean;
  refreshKey?: string;
}

interface UnreadTaskEdgePillProps {
  edge: UnreadTaskEdge;
  direction: "above" | "below";
  onJump: (taskId: string) => void;
}

const EMPTY_EDGE: UnreadTaskEdge = { count: 0, targetTaskId: null };
const EMPTY_STATE: UnreadTaskEdgeState = { above: EMPTY_EDGE, below: EMPTY_EDGE };

function getParentElement(element: HTMLElement): HTMLElement | null {
  const parent = element.parentElement ?? element.parentNode;
  return parent && parent.nodeType === 1 ? parent as HTMLElement : null;
}

function isScrollableCandidate(element: HTMLElement): boolean {
  if (element.scrollHeight > element.clientHeight + SCROLL_EPSILON) return true;
  if (typeof window === "undefined" || typeof window.getComputedStyle !== "function") return false;
  const overflowY = window.getComputedStyle(element).overflowY;
  return overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay";
}

function findScrollContainer(scope: HTMLElement | null): HTMLElement | null {
  let element = scope;
  while (element) {
    if (isScrollableCandidate(element)) return element;
    element = getParentElement(element);
  }
  return null;
}

function readUnreadTaskRows(scope: HTMLElement): HTMLElement[] {
  if (typeof scope.querySelectorAll === "function") {
    return Array.from(scope.querySelectorAll<HTMLElement>(UNREAD_TASK_ROW_SELECTOR));
  }
  const rows: HTMLElement[] = [];
  const visit = (node: Node) => {
    if (node.nodeType !== 1) return;
    const element = node as HTMLElement;
    if (element.getAttribute?.("data-unread-task-id")) rows.push(element);
    for (const child of Array.from(element.childNodes)) visit(child);
  };
  visit(scope);
  return rows;
}

function edgeStateEquals(a: UnreadTaskEdgeState, b: UnreadTaskEdgeState): boolean {
  return a.above.count === b.above.count
    && a.above.targetTaskId === b.above.targetTaskId
    && a.below.count === b.below.count
    && a.below.targetTaskId === b.below.targetTaskId;
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function getTaskId(row: HTMLElement): string | null {
  return row.getAttribute("data-unread-task-id");
}

function clampScrollTop(container: HTMLElement, scrollTop: number): number {
  const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
  return Math.max(0, Math.min(maxScrollTop, scrollTop));
}

function scrollContainerTo(container: HTMLElement, scrollTop: number) {
  const behavior = prefersReducedMotion() ? "auto" : "smooth";
  if (typeof container.scrollTo === "function") {
    container.scrollTo({ top: scrollTop, behavior });
    return;
  }
  container.scrollTop = scrollTop;
}

export function getUnreadTaskEdgeState(
  scrollContainer: HTMLElement,
  unreadRows: readonly HTMLElement[],
): UnreadTaskEdgeState {
  if (scrollContainer.scrollHeight <= scrollContainer.clientHeight + SCROLL_EPSILON) {
    return EMPTY_STATE;
  }

  const containerRect = scrollContainer.getBoundingClientRect();
  let aboveCount = 0;
  let nearestAboveId: string | null = null;
  let nearestAboveBottom = Number.NEGATIVE_INFINITY;
  let belowCount = 0;
  let nearestBelowId: string | null = null;
  let nearestBelowTop = Number.POSITIVE_INFINITY;

  for (const row of unreadRows) {
    const taskId = getTaskId(row);
    if (!taskId) continue;
    const rowRect = row.getBoundingClientRect();
    if (rowRect.bottom <= containerRect.top) {
      aboveCount += 1;
      if (rowRect.bottom >= nearestAboveBottom) {
        nearestAboveBottom = rowRect.bottom;
        nearestAboveId = taskId;
      }
    } else if (rowRect.top >= containerRect.bottom) {
      belowCount += 1;
      if (rowRect.top <= nearestBelowTop) {
        nearestBelowTop = rowRect.top;
        nearestBelowId = taskId;
      }
    }
  }

  return {
    above: { count: aboveCount, targetTaskId: nearestAboveId },
    below: { count: belowCount, targetTaskId: nearestBelowId },
  };
}

export function useUnreadTaskEdges({
  scopeRef,
  scrollContainerRef,
  disabled = false,
  refreshKey = "",
}: UseUnreadTaskEdgesOptions): UnreadTaskEdgeState & { jumpToTask: (taskId: string) => void } {
  const [edgeState, setEdgeState] = useState<UnreadTaskEdgeState>(EMPTY_STATE);
  const measureFrameRef = useRef<number | null>(null);

  const resolveScrollContainer = useCallback(() => {
    return scrollContainerRef?.current ?? findScrollContainer(scopeRef.current);
  }, [scopeRef, scrollContainerRef]);

  const measure = useCallback(() => {
    if (disabled) {
      setEdgeState((previous) => edgeStateEquals(previous, EMPTY_STATE) ? previous : EMPTY_STATE);
      return;
    }
    const scope = scopeRef.current;
    const scrollContainer = resolveScrollContainer();
    if (!scope || !scrollContainer) {
      setEdgeState((previous) => edgeStateEquals(previous, EMPTY_STATE) ? previous : EMPTY_STATE);
      return;
    }

    const next = getUnreadTaskEdgeState(scrollContainer, readUnreadTaskRows(scope));
    setEdgeState((previous) => edgeStateEquals(previous, next) ? previous : next);
  }, [disabled, resolveScrollContainer, scopeRef]);

  const cancelScheduledMeasure = useCallback(() => {
    if (measureFrameRef.current == null) return;
    window.cancelAnimationFrame(measureFrameRef.current);
    measureFrameRef.current = null;
  }, []);

  const scheduleMeasure = useCallback(() => {
    if (measureFrameRef.current != null) return;
    measureFrameRef.current = window.requestAnimationFrame(() => {
      measureFrameRef.current = null;
      measure();
    });
  }, [measure]);

  useEffect(() => {
    scheduleMeasure();
    return cancelScheduledMeasure;
  }, [cancelScheduledMeasure, refreshKey, scheduleMeasure]);

  useEffect(() => {
    if (disabled) return;
    const scrollContainer = resolveScrollContainer();
    if (!scrollContainer) return;
    const scope = scopeRef.current;
    const resizeObserver = typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(scheduleMeasure)
      : null;
    resizeObserver?.observe(scrollContainer);
    if (scope && scope !== scrollContainer) resizeObserver?.observe(scope);

    scrollContainer.addEventListener("scroll", scheduleMeasure, { passive: true });
    window.addEventListener("resize", scheduleMeasure);
    return () => {
      resizeObserver?.disconnect();
      scrollContainer.removeEventListener("scroll", scheduleMeasure);
      window.removeEventListener("resize", scheduleMeasure);
      cancelScheduledMeasure();
    };
  }, [cancelScheduledMeasure, disabled, resolveScrollContainer, scheduleMeasure, scopeRef]);

  const jumpToTask = useCallback((taskId: string) => {
    const scope = scopeRef.current;
    const scrollContainer = resolveScrollContainer();
    if (!scope || !scrollContainer) return;

    const row = readUnreadTaskRows(scope).find((candidate) => getTaskId(candidate) === taskId);
    if (!row) return;

    const containerRect = scrollContainer.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const rowTop = scrollContainer.scrollTop + rowRect.top - containerRect.top;
    const targetTop = rowTop - Math.max(0, (scrollContainer.clientHeight - rowRect.height) / 2);
    scrollContainerTo(scrollContainer, clampScrollTop(scrollContainer, targetTop));
    scheduleMeasure();
  }, [resolveScrollContainer, scheduleMeasure, scopeRef]);

  return { ...edgeState, jumpToTask };
}

function formatUnreadLabel(count: number): string {
  return `${count} unread`;
}

export function UnreadTaskEdgePill({ edge, direction, onJump }: UnreadTaskEdgePillProps) {
  if (edge.count === 0 || !edge.targetTaskId) return null;
  const isAbove = direction === "above";
  const label = isAbove
    ? `↑ ${formatUnreadLabel(edge.count)} above`
    : `${formatUnreadLabel(edge.count)} below ↓`;
  const directionLabel = isAbove ? "above" : "below";

  return (
    <div
      className={`sticky ${isAbove ? "top-1" : "bottom-1"} z-20 flex h-0 justify-center pointer-events-none`}
      data-testid={`unread-tasks-${directionLabel}`}
    >
      <button
        type="button"
        aria-label={`Jump to ${formatUnreadLabel(edge.count)} ${directionLabel}`}
        onClick={() => onJump(edge.targetTaskId!)}
        className={`pointer-events-auto inline-flex items-center gap-2 rounded-full border border-success/35 bg-bg-elevated/95 px-3 py-1.5 text-xs font-semibold leading-4 text-text-primary shadow-lg shadow-black/25 backdrop-blur transition-colors hover:border-success/60 hover:bg-bg-hover ${isAbove ? "-translate-y-1/2" : "-translate-y-full"}`}
      >
        <span aria-hidden="true" className="h-2 w-2 rounded-full bg-success shadow-[0_0_8px_rgba(34,197,94,0.55)]" />
        {label}
      </button>
    </div>
  );
}
