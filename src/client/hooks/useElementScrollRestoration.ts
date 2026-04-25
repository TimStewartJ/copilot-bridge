import { useLayoutEffect, type RefObject } from "react";

export interface UseElementScrollRestorationOptions {
  key: string | null | undefined;
  enabled?: boolean;
  restore?: boolean;
}

const MAX_RESTORED_ELEMENTS = 32;
const RESTORE_RETRY_MS = 1_000;
const SCROLL_EPSILON = 1;

const savedScrollTops = new Map<string, number>();

function saveScrollTop(key: string, scrollTop: number) {
  savedScrollTops.delete(key);
  savedScrollTops.set(key, Math.max(0, scrollTop));

  while (savedScrollTops.size > MAX_RESTORED_ELEMENTS) {
    const oldestKey = savedScrollTops.keys().next().value;
    if (oldestKey === undefined) return;
    savedScrollTops.delete(oldestKey);
  }
}

function getSavedScrollTop(key: string): number | undefined {
  const saved = savedScrollTops.get(key);
  if (saved === undefined) return undefined;
  saveScrollTop(key, saved);
  return saved;
}

function isRestored(element: HTMLElement, targetTop: number) {
  return Math.abs(element.scrollTop - targetTop) <= SCROLL_EPSILON;
}

function restoreWithRetry(
  element: HTMLElement,
  targetTop: number,
  onSettled: (restored: boolean) => void,
) {
  let frameId: number | undefined;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let resizeObserver: ResizeObserver | undefined;
  let mutationObserver: MutationObserver | undefined;
  const resizeObservedElements = new Set<Element>();

  const stop = (restored: boolean) => {
    if (stopped) return;
    stopped = true;
    if (frameId !== undefined) window.cancelAnimationFrame(frameId);
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    resizeObserver?.disconnect();
    mutationObserver?.disconnect();
    onSettled(restored);
  };

  const apply = () => {
    frameId = undefined;
    if (stopped) return;

    element.scrollTop = targetTop;
    if (isRestored(element, targetTop)) {
      stop(true);
    }
  };

  const scheduleApply = () => {
    if (stopped || frameId !== undefined) return;
    frameId = window.requestAnimationFrame(apply);
  };

  element.scrollTop = targetTop;
  if (targetTop <= SCROLL_EPSILON || isRestored(element, targetTop)) {
    onSettled(true);
    return () => {};
  }

  const observeResizeTarget = (target: Element) => {
    if (!resizeObserver || resizeObservedElements.has(target)) return;
    resizeObservedElements.add(target);
    resizeObserver.observe(target);
  };

  const observeResizeSubtree = (target: Element) => {
    observeResizeTarget(target);
    Array.from(target.children).forEach(observeResizeSubtree);
  };

  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(scheduleApply);
    observeResizeSubtree(element);
  }

  if (typeof MutationObserver !== "undefined") {
    mutationObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === 1) observeResizeSubtree(node as Element);
        });
      }
      scheduleApply();
    });
    mutationObserver.observe(element, { childList: true, subtree: true });
  }

  timeoutId = setTimeout(() => stop(false), RESTORE_RETRY_MS);
  scheduleApply();

  return () => stop(false);
}

export function useElementScrollRestoration<T extends HTMLElement>(
  ref: RefObject<T | null>,
  { key, enabled = true, restore = true }: UseElementScrollRestorationOptions,
) {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!enabled || !key || !element) return;

    let saveFrameId: number | undefined;
    let restoring = false;
    let protectSavedScrollTop = false;
    let stopRestore: (() => void) | undefined;

    const saveNow = () => {
      if (protectSavedScrollTop) return;
      saveScrollTop(key, element.scrollTop);
    };

    const scheduleSave = () => {
      if (restoring || protectSavedScrollTop || saveFrameId !== undefined) return;
      saveFrameId = window.requestAnimationFrame(() => {
        saveFrameId = undefined;
        saveNow();
      });
    };

    const cancelRestore = () => {
      protectSavedScrollTop = false;
      restoring = false;
      stopRestore?.();
      stopRestore = undefined;
    };

    const onScroll = () => {
      if (restoring || protectSavedScrollTop) return;
      scheduleSave();
    };

    element.addEventListener("scroll", onScroll, { passive: true });
    element.addEventListener("wheel", cancelRestore, { passive: true });
    element.addEventListener("touchstart", cancelRestore, { passive: true });
    element.addEventListener("pointerdown", cancelRestore, { passive: true });
    element.addEventListener("keydown", cancelRestore);

    const targetTop = restore ? getSavedScrollTop(key) ?? 0 : 0;
    if (!restore) saveScrollTop(key, 0);

    restoring = targetTop > SCROLL_EPSILON;
    protectSavedScrollTop = restoring;
    stopRestore = restoreWithRetry(
      element,
      targetTop,
      (restored) => {
        restoring = false;
        stopRestore = undefined;
        if (restored) {
          protectSavedScrollTop = false;
          saveNow();
        }
      },
    );

    return () => {
      stopRestore?.();
      if (saveFrameId !== undefined) window.cancelAnimationFrame(saveFrameId);
      element.removeEventListener("scroll", onScroll);
      element.removeEventListener("wheel", cancelRestore);
      element.removeEventListener("touchstart", cancelRestore);
      element.removeEventListener("pointerdown", cancelRestore);
      element.removeEventListener("keydown", cancelRestore);
      saveNow();
    };
  }, [enabled, key, ref, restore]);
}

export default useElementScrollRestoration;
