import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";

import { BROWSER_HANDOFF_ANSWERS, type BrowserHandoffAnswer, type BrowserLiveTicket } from "../../shared/browser-live.js";
import { useModalDialog } from "../components/shared/useModalDialog";
import { Button } from "../design/primitives";
import { DS, cx } from "../design/tokens";
import type { BrowserLiveDeps } from "./live-connection";
import { LiveBrowserView } from "./LiveBrowserView";

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [tabindex="0"]';

/** Follow the visual viewport: a phone keyboard covers a fixed overlay without resizing it. */
function useVisibleBox(): CSSProperties | undefined {
  const [box, setBox] = useState<{ top: number; height: number } | null>(null);
  useEffect(() => {
    const viewport = typeof window !== "undefined" ? window.visualViewport : null;
    if (!viewport) return;
    const update = () => {
      // A pinch-zoomed page reports a smaller viewport too, and then the overlay should stay put.
      const next = viewport.scale > 1.01 ? null : { top: Math.round(viewport.offsetTop), height: Math.round(viewport.height) };
      setBox((current) => (current?.top === next?.top && current?.height === next?.height ? current : next));
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, []);
  return box ? { top: box.top, bottom: "auto", height: box.height } : undefined;
}

/** Portaled out of its opener so a card, list or dialog around it cannot clip or disable it. */
export function BrowserLiveDialog({
  browserSessionId,
  title = "Browser",
  reason,
  requestTicket,
  onClose,
  onAnswer,
  deps,
}: {
  browserSessionId: string;
  title?: string;
  /** What is to be done in the browser, shown above the page. */
  reason?: string;
  /** See LiveBrowserView. */
  requestTicket?: () => Promise<BrowserLiveTicket>;
  /** Closes the view and leaves any request unanswered. */
  onClose: () => void;
  /** Present when the view answers a handoff; the host closes the view when it is called. */
  onAnswer?: (answer: BrowserHandoffAnswer) => void;
  /** Replaces the network in tests. */
  deps?: Partial<BrowserLiveDeps>;
}) {
  const { titleId, dialogProps } = useModalDialog({ onDismiss: onClose });
  const ref = useRef<HTMLDivElement>(null);
  const visibleBox = useVisibleBox();

  useEffect(() => {
    const previous = document.activeElement;
    ref.current?.focus();
    return () => {
      if (previous && "focus" in previous && typeof previous.focus === "function") previous.focus();
    };
  }, []);

  if (typeof document === "undefined" || !document.body) return null;

  const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();

  return createPortal(
    // Portal events still bubble to the opener; stop them or the chat reads a scroll-away.
    <div
      className="fixed inset-0 z-[70] flex bg-black/50 md:p-4"
      style={visibleBox}
      onClick={stop}
      onContextMenu={stop}
      onMouseDown={stop}
      onMouseUp={stop}
      onPointerDown={stop}
      onPointerUp={stop}
      onTouchStart={stop}
      onTouchMove={stop}
      onTouchEnd={stop}
      onTouchCancel={stop}
      onWheel={stop}
      onKeyUp={stop}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.defaultPrevented || event.nativeEvent.isComposing) return;
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
          return;
        }
        if (event.key !== "Tab") return;
        const root = ref.current;
        const controls = root && typeof root.querySelectorAll === "function"
          ? Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE))
          : [];
        const first = controls[0];
        const last = controls[controls.length - 1];
        const active = document.activeElement;
        if (!first || !last) {
          event.preventDefault();
          root?.focus();
        } else if (event.shiftKey && (active === first || active === root)) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && active === last) {
          event.preventDefault();
          first.focus();
        }
      }}
    >
      <div
        {...dialogProps}
        ref={ref}
        tabIndex={-1}
        className={cx(
          DS.surface.dialog,
          "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden focus:outline-none max-md:rounded-none max-md:border-0",
        )}
        style={{
          paddingTop: "env(safe-area-inset-top)",
          paddingRight: "env(safe-area-inset-right)",
          paddingBottom: "env(safe-area-inset-bottom)",
          paddingLeft: "env(safe-area-inset-left)",
        }}
      >
        <div className="flex shrink-0 items-start gap-3 px-3 pt-2 sm:px-4 sm:pt-3">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className={DS.text.sectionTitle}>{title}</h2>
            {reason && <p className="mt-0.5 line-clamp-2 break-words text-xs leading-relaxed text-text-secondary">{reason}</p>}
          </div>
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </div>
        <LiveBrowserView
          browserSessionId={browserSessionId}
          requestTicket={requestTicket}
          deps={deps}
          className="flex-1"
        />
        {onAnswer && (
          <div className={cx("flex shrink-0 flex-wrap gap-2 border-t px-3 py-2 sm:px-4 sm:py-3", DS.surface.hairline)}>
            <Button variant="primary" onClick={() => onAnswer(BROWSER_HANDOFF_ANSWERS.done)}>Done, continue</Button>
            <Button onClick={() => onAnswer(BROWSER_HANDOFF_ANSWERS.notDone)}>I couldn't do it</Button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
