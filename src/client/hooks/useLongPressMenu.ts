import { useState, useRef, useCallback } from "react";

interface MenuState<T> {
  x: number;
  y: number;
  id: T;
}

interface LongPressBindings {
  onContextMenu: (e: React.MouseEvent) => void;
  onTouchStart: (e: React.TouchEvent) => void;
  onTouchMove: (e: React.TouchEvent) => void;
  onTouchEnd: () => void;
  onTouchCancel: () => void;
  onClick: () => void;
}

interface UseLongPressMenuReturn<T> {
  /** Spread onto a button to wire up long-press + right-click + click guard */
  bind: (id: T, onClick: () => void) => LongPressBindings;
  /** Current context menu state, or null when closed */
  menu: MenuState<T> | null;
  /** Close the context menu */
  closeMenu: () => void;
  /** Whether this id is currently being long-pressed (for visual feedback) */
  isTarget: (id: T) => boolean;
}

const LONG_PRESS_MS = 500;
const MOVE_THRESHOLD_SQ = 100; // 10px squared

/**
 * Generic hook for long-press / right-click context menus on mobile & desktop.
 * Handles touch timing, movement cancellation, click guards, and menu state.
 */
export default function useLongPressMenu<T>(): UseLongPressMenuReturn<T> {
  const [menu, setMenu] = useState<MenuState<T> | null>(null);
  const [longPressTarget, setLongPressTarget] = useState<T | null>(null);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const triggered = useRef(false);
  const origin = useRef<{ x: number; y: number } | null>(null);

  const cancelLongPress = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    setLongPressTarget(null);
  }, []);

  const closeMenu = useCallback(() => setMenu(null), []);

  const bind = useCallback(
    (id: T, onClick: () => void): LongPressBindings => ({
      onClick: () => {
        if (triggered.current) {
          triggered.current = false;
          return;
        }
        onClick();
      },
      onContextMenu: (e: React.MouseEvent) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY, id });
      },
      onTouchStart: (e: React.TouchEvent) => {
        const touch = e.touches[0];
        origin.current = { x: touch.clientX, y: touch.clientY };
        triggered.current = false;
        setLongPressTarget(id);
        timer.current = setTimeout(() => {
          triggered.current = true;
          setLongPressTarget(null);
          setMenu({ x: touch.clientX, y: touch.clientY, id });
        }, LONG_PRESS_MS);
      },
      onTouchMove: (e: React.TouchEvent) => {
        if (!origin.current) return;
        const touch = e.touches[0];
        const dx = touch.clientX - origin.current.x;
        const dy = touch.clientY - origin.current.y;
        if (dx * dx + dy * dy > MOVE_THRESHOLD_SQ) cancelLongPress();
      },
      onTouchEnd: () => cancelLongPress(),
      onTouchCancel: () => cancelLongPress(),
    }),
    [cancelLongPress],
  );

  const isTarget = useCallback(
    (id: T) => longPressTarget === id,
    [longPressTarget],
  );

  return { bind, menu, closeMenu, isTarget };
}
