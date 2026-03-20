import { useEffect, useRef } from "react";

/**
 * Detects left-edge swipe-right to open and swipe-left to close a drawer.
 * Only active on touch devices (mobile).
 */
export function useSwipeDrawer(
  isOpen: boolean,
  onOpen: () => void,
  onClose: () => void,
  { edgeWidth = 24, threshold = 60 } = {}
) {
  const touchRef = useRef<{ startX: number; startY: number; edge: boolean } | null>(null);

  useEffect(() => {
    const onTouchStart = (e: TouchEvent) => {
      const x = e.touches[0].clientX;
      const y = e.touches[0].clientY;
      const nearEdge = !isOpen && x <= edgeWidth;
      const inDrawer = isOpen;
      if (nearEdge || inDrawer) {
        touchRef.current = { startX: x, startY: y, edge: nearEdge };
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (!touchRef.current) return;
      const endX = e.changedTouches[0].clientX;
      const endY = e.changedTouches[0].clientY;
      const dx = endX - touchRef.current.startX;
      const dy = Math.abs(endY - touchRef.current.startY);
      // Ignore if the gesture is more vertical than horizontal
      if (dy > Math.abs(dx)) {
        touchRef.current = null;
        return;
      }
      if (touchRef.current.edge && dx > threshold) {
        onOpen();
      } else if (isOpen && dx < -threshold) {
        onClose();
      }
      touchRef.current = null;
    };

    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchend", onTouchEnd, { passive: true });
    return () => {
      document.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("touchend", onTouchEnd);
    };
  }, [isOpen, onOpen, onClose, edgeWidth, threshold]);
}
