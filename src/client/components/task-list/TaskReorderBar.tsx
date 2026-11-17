import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { Button } from "../../design/primitives";
import { DS, cx } from "../../design/tokens";

interface UseTaskReorderModeOptions {
  /** Whether reordering is possible now; reorder mode ends by itself when this turns false. */
  enabled: boolean;
  /** Whether a drag is in progress; Escape then cancels the drag and leaves the mode on. */
  dragging: boolean;
  /** Called when the mode ends, so the long-press click guard cannot eat the next tap. */
  onExit?: () => void;
  /** Where focus goes after Done or Escape; the handles and Done button it was on are gone. */
  returnFocusRef?: RefObject<HTMLElement | null>;
}

/** Reorder mode for a task list: the rows stop opening tasks and show drag handles until Done. */
export function useTaskReorderMode({ enabled, dragging, onExit, returnFocusRef }: UseTaskReorderModeOptions) {
  const [reordering, setReordering] = useState(false);
  const draggingRef = useRef(dragging);
  draggingRef.current = dragging;
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;

  const returnFocusRefRef = useRef(returnFocusRef);
  returnFocusRefRef.current = returnFocusRef;

  const start = useCallback(() => setReordering(true), []);
  const exit = useCallback(() => {
    setReordering(false);
    onExitRef.current?.();
  }, []);
  const stop = useCallback(() => {
    exit();
    window.requestAnimationFrame(() => returnFocusRefRef.current?.current?.focus());
  }, [exit]);

  // Reordering became impossible (list collapsed, tab switched): leave focus where it is.
  useEffect(() => {
    if (reordering && !enabled) exit();
  }, [enabled, reordering, exit]);

  useEffect(() => {
    if (!reordering) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || draggingRef.current) return;
      stop();
    };
    // Capture runs before dnd-kit's Escape handler, which would clear `dragging` before bubbling.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [reordering, stop]);

  return { reordering: reordering && enabled, start, stop };
}

/** The strip above a task list in reorder mode: what to do, and the way out. */
export function TaskReorderBar({ onDone }: { onDone: () => void }) {
  const doneRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    doneRef.current?.focus();
  }, []);

  return (
    <div
      data-task-reorder-bar=""
      className={cx(DS.surface.pane, "sticky top-0 z-10 flex items-center gap-2 border-b border-border-subtle py-1.5 pl-3 pr-1")}
    >
      <p role="status" className={cx(DS.text.meta, "min-w-0 flex-1")}>
        Drag the handles to reorder.
      </p>
      <Button ref={doneRef} size="sm" onClick={onDone}>
        Done
      </Button>
    </div>
  );
}
