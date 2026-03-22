import { useRef, useState, useCallback, useEffect, type ReactNode } from "react";
import { Loader2, ArrowDown } from "lucide-react";

interface PullToRefreshProps {
  onRefresh: () => Promise<void>;
  children: ReactNode;
  className?: string;
}

const THRESHOLD = 64;    // px to pull before triggering refresh
const MAX_PULL = 100;    // max visual displacement
const RESISTANCE = 0.45; // damping factor past threshold

export default function PullToRefresh({ onRefresh, children, className = "" }: PullToRefreshProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const startYRef = useRef(0);
  const pullingRef = useRef(false);

  const [pullDistance, setPullDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const refreshingRef = useRef(false);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (refreshing) return;
    const el = containerRef.current;
    if (!el || el.scrollTop > 0) return;
    startYRef.current = e.touches[0].clientY;
    pullingRef.current = true;
  }, [refreshing]);

  // Native touchmove handler registered with { passive: false } so we can
  // preventDefault to suppress iOS Safari's rubber-band bounce.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onTouchMove = (e: TouchEvent) => {
      if (!pullingRef.current || refreshingRef.current) return;
      if (el.scrollTop > 0) {
        pullingRef.current = false;
        setPullDistance(0);
        return;
      }

      const deltaY = e.touches[0].clientY - startYRef.current;
      if (deltaY <= 0) {
        setPullDistance(0);
        return;
      }

      // Block the browser's native overscroll/rubber-band
      e.preventDefault();

      const distance = deltaY > THRESHOLD
        ? THRESHOLD + (deltaY - THRESHOLD) * RESISTANCE
        : deltaY;

      setPullDistance(Math.min(distance, MAX_PULL));
    };

    el.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => el.removeEventListener("touchmove", onTouchMove);
  }, []);

  const handleTouchEnd = useCallback(async () => {
    if (!pullingRef.current) return;
    pullingRef.current = false;

    if (pullDistance >= THRESHOLD && !refreshing) {
      setRefreshing(true);
      refreshingRef.current = true;
      setPullDistance(THRESHOLD); // hold at threshold during refresh
      try {
        await onRefresh();
      } finally {
        setRefreshing(false);
        refreshingRef.current = false;
        setPullDistance(0);
      }
    } else {
      setPullDistance(0);
    }
  }, [pullDistance, refreshing, onRefresh]);

  // Reset on unmount
  useEffect(() => {
    return () => {
      pullingRef.current = false;
    };
  }, []);

  const progress = Math.min(pullDistance / THRESHOLD, 1);
  const showIndicator = pullDistance > 8 || refreshing;

  return (
    <div
      ref={containerRef}
      className={`overflow-y-auto ${className}`}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      style={{ overscrollBehavior: "none" }}
    >
      {/* Pull indicator */}
      <div
        className="flex items-center justify-center overflow-hidden transition-[height] duration-200 ease-out"
        style={{
          height: showIndicator ? pullDistance : 0,
          transitionDuration: pullingRef.current ? "0ms" : "200ms",
        }}
      >
        {refreshing ? (
          <Loader2 size={20} className="animate-spin text-accent" />
        ) : (
          <ArrowDown
            size={20}
            className="text-text-muted transition-transform duration-150"
            style={{
              opacity: progress,
              transform: `rotate(${progress >= 1 ? 180 : 0}deg)`,
            }}
          />
        )}
      </div>

      {children}
    </div>
  );
}
