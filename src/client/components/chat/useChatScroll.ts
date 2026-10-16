import { useCallback, useEffect, useRef, useState } from "react";
import { prefersReducedMotion } from "../../lib/motion";

export const FOLLOW_BOTTOM_THRESHOLD_PX = 96;
export const LATEST_MESSAGE_TOP_THRESHOLD_PX = 8;
const FOLLOW_SCROLL_EASE = 0.35;
const FOLLOW_SCROLL_SETTLE_PX = 1.5;

export function getSafeScrollTop(el: HTMLElement): number {
  return Number.isFinite(el.scrollTop) ? el.scrollTop : 0;
}

export function getMaxScrollTop(el: HTMLElement): number {
  const scrollHeight = Number.isFinite(el.scrollHeight) ? el.scrollHeight : 0;
  const clientHeight = Number.isFinite(el.clientHeight) ? el.clientHeight : 0;
  return Math.max(0, scrollHeight - clientHeight);
}

export function getDistanceFromBottom(el: HTMLElement): number {
  return Math.max(0, getMaxScrollTop(el) - getSafeScrollTop(el));
}

/** Owns live-tail following and programmatic movement; paging decides when entries change. */
export function useChatScroll(active: boolean) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const anchoredMessageKeyRef = useRef<string | null>(null);
  const messageElementRefs = useRef(new Map<string, HTMLDivElement>());
  const programmaticScrollRef = useRef(false);
  const followScrollFrameRef = useRef<number | null>(null);
  const resetProgrammaticScrollFrameRef = useRef<number | null>(null);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);

  const cancelFollowScroll = useCallback(() => {
    if (followScrollFrameRef.current != null) {
      window.cancelAnimationFrame(followScrollFrameRef.current);
      followScrollFrameRef.current = null;
    }
  }, []);

  const clearProgrammaticScroll = useCallback(() => {
    if (resetProgrammaticScrollFrameRef.current != null) {
      window.cancelAnimationFrame(resetProgrammaticScrollFrameRef.current);
      resetProgrammaticScrollFrameRef.current = null;
    }
    programmaticScrollRef.current = false;
  }, []);

  const settleProgrammaticScroll = useCallback(() => {
    if (resetProgrammaticScrollFrameRef.current != null) {
      window.cancelAnimationFrame(resetProgrammaticScrollFrameRef.current);
    }
    resetProgrammaticScrollFrameRef.current = window.requestAnimationFrame(() => {
      resetProgrammaticScrollFrameRef.current = null;
      programmaticScrollRef.current = false;
    });
  }, []);

  const getMessageTopWithinScroller = useCallback((key: string): number | null => {
    const scroller = scrollContainerRef.current;
    const message = messageElementRefs.current.get(key);
    if (!scroller || !message) return null;
    const scrollerRect = scroller.getBoundingClientRect();
    const messageRect = message.getBoundingClientRect();
    return messageRect.top - scrollerRect.top + getSafeScrollTop(scroller);
  }, []);

  const scrollToLatest = useCallback((
    opts: { immediate?: boolean; force?: boolean; anchorKey?: string | null } = {},
  ) => {
    const el = scrollContainerRef.current;
    if (!el) return;
    if (opts.force) {
      stickToBottomRef.current = true;
      anchoredMessageKeyRef.current = null;
      setShowJumpToLatest(false);
    } else if (!stickToBottomRef.current) {
      return;
    }
    cancelFollowScroll();
    const reducedMotion = prefersReducedMotion();
    const immediate = opts.immediate || reducedMotion;
    const step = () => {
      const anchorKey = opts.anchorKey ?? null;
      const top = getSafeScrollTop(el);
      const bottom = getMaxScrollTop(el);
      const anchorTop = anchorKey ? getMessageTopWithinScroller(anchorKey) : null;
      const hasAnchor = anchorTop != null && Number.isFinite(anchorTop);
      const canAnchor = hasAnchor && bottom > 0 && bottom >= anchorTop - LATEST_MESSAGE_TOP_THRESHOLD_PX;
      if (!opts.force && anchorKey && canAnchor && anchorTop <= top + LATEST_MESSAGE_TOP_THRESHOLD_PX) {
        programmaticScrollRef.current = true;
        if (Math.abs(anchorTop - top) <= LATEST_MESSAGE_TOP_THRESHOLD_PX) {
          el.scrollTop = Math.max(0, Math.min(bottom, anchorTop));
        }
        followScrollFrameRef.current = null;
        stickToBottomRef.current = true;
        anchoredMessageKeyRef.current = anchorKey;
        setShowJumpToLatest(false);
        settleProgrammaticScroll();
        return;
      }
      const target = hasAnchor ? Math.min(bottom, anchorTop) : bottom;
      const delta = target - top;
      programmaticScrollRef.current = true;
      if (immediate || Math.abs(delta) <= FOLLOW_SCROLL_SETTLE_PX) {
        el.scrollTop = target;
        followScrollFrameRef.current = null;
        stickToBottomRef.current = true;
        anchoredMessageKeyRef.current = anchorKey && canAnchor && Math.abs(target - anchorTop) <= LATEST_MESSAGE_TOP_THRESHOLD_PX
          ? anchorKey : null;
        setShowJumpToLatest(false);
        settleProgrammaticScroll();
        return;
      }
      const nextTop = top + delta * FOLLOW_SCROLL_EASE;
      if (anchorKey && canAnchor && Math.abs(target - anchorTop) <= LATEST_MESSAGE_TOP_THRESHOLD_PX
        && nextTop >= anchorTop - LATEST_MESSAGE_TOP_THRESHOLD_PX) {
        el.scrollTop = Math.max(0, Math.min(bottom, anchorTop));
        followScrollFrameRef.current = null;
        stickToBottomRef.current = true;
        anchoredMessageKeyRef.current = anchorKey;
        setShowJumpToLatest(false);
        settleProgrammaticScroll();
        return;
      }
      anchoredMessageKeyRef.current = null;
      el.scrollTop = nextTop;
      followScrollFrameRef.current = window.requestAnimationFrame(step);
    };
    if (immediate) step();
    else followScrollFrameRef.current = window.requestAnimationFrame(step);
  }, [cancelFollowScroll, getMessageTopWithinScroller, settleProgrammaticScroll]);

  const handleUserScrollIntent = useCallback(() => {
    cancelFollowScroll();
    clearProgrammaticScroll();
    stickToBottomRef.current = false;
    anchoredMessageKeyRef.current = null;
    if (active) setShowJumpToLatest(true);
  }, [active, cancelFollowScroll, clearProgrammaticScroll]);

  useEffect(() => () => {
    cancelFollowScroll();
    clearProgrammaticScroll();
  }, [cancelFollowScroll, clearProgrammaticScroll]);

  return {
    scrollContainerRef, stickToBottomRef, anchoredMessageKeyRef, messageElementRefs, programmaticScrollRef,
    showJumpToLatest, setShowJumpToLatest, cancelFollowScroll, clearProgrammaticScroll,
    settleProgrammaticScroll, getMessageTopWithinScroller, scrollToLatest, handleUserScrollIntent,
  };
}
