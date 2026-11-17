import { useRef, useState, useEffect, type ReactNode } from "react";
import { Loader2, ArrowDown } from "lucide-react";
import useElementScrollRestoration, { type UseElementScrollRestorationOptions } from "../hooks/useElementScrollRestoration";
import { haptic } from "../lib/haptics";

export type PullToRefreshScrollRestoration = Omit<UseElementScrollRestorationOptions, "key"> & {
  key: string;
};

interface PullToRefreshProps {
  onRefresh: () => Promise<void>;
  children: ReactNode;
  className?: string;
  /** Saves/restores container scroll; set restore=false for fresh navigation reset. */
  scrollRestoration?: PullToRefreshScrollRestoration;
}

const DISABLED_SCROLL_RESTORATION = {
  key: null,
  enabled: false,
} satisfies UseElementScrollRestorationOptions;

const THRESHOLD = 64;    // px to pull before triggering refresh
const MAX_PULL = 100;    // max visual displacement
const RESISTANCE = 0.45;
// Tolerate sub-pixel scroll positions left over from momentum / rounding
const SCROLL_TOP_EPSILON = 1;

export default function PullToRefresh({ onRefresh, children, className = "", scrollRestoration }: PullToRefreshProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const startYRef = useRef(0);
  const pullingRef = useRef(false);
  const pullDistRef = useRef(0);          // always-current pull distance (no stale closure)
  const armedRef = useRef(false);         // pulled past the threshold; letting go now refreshes
  const onRefreshRef = useRef(onRefresh); // avoid re-attaching listeners when callback changes
  onRefreshRef.current = onRefresh;

  const [pullDistance, setPullDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const refreshingRef = useRef(false);

  // Keep pullDistRef in sync with state
  useEffect(() => { pullDistRef.current = pullDistance; }, [pullDistance]);

  useElementScrollRestoration(containerRef, scrollRestoration ?? DISABLED_SCROLL_RESTORATION);

  // Native non-passive listeners: React's root-delegated touch handlers can't block scrolling.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onTouchStart = (e: TouchEvent) => {
      if (refreshingRef.current) return;
      if (el.scrollTop > SCROLL_TOP_EPSILON) return;
      startYRef.current = e.touches[0].clientY;
      pullingRef.current = true;
      armedRef.current = false;
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!pullingRef.current || refreshingRef.current) return;
      if (el.scrollTop > SCROLL_TOP_EPSILON) {
        pullingRef.current = false;
        setPullDistance(0);
        return;
      }

      const deltaY = e.touches[0].clientY - startYRef.current;
      if (deltaY <= 0) {
        setPullDistance(0);
        return;
      }

      // Block the browser's native overscroll / rubber-band
      e.preventDefault();

      const distance = deltaY > THRESHOLD
        ? THRESHOLD + (deltaY - THRESHOLD) * RESISTANCE
        : deltaY;

      // Like iOS lists, a bump marks the point where letting go will refresh.
      const armed = distance >= THRESHOLD;
      if (armed && !armedRef.current) haptic("medium");
      armedRef.current = armed;

      setPullDistance(Math.min(distance, MAX_PULL));
    };

    const onTouchEnd = async () => {
      if (!pullingRef.current) return;
      pullingRef.current = false;

      // The ref has the latest value even before React commits setPullDistance.
      if (pullDistRef.current >= THRESHOLD && !refreshingRef.current) {
        setRefreshing(true);
        refreshingRef.current = true;
        setPullDistance(THRESHOLD); // hold at threshold during refresh
        try {
          await onRefreshRef.current();
        } finally {
          setRefreshing(false);
          refreshingRef.current = false;
          setPullDistance(0);
        }
      } else {
        setPullDistance(0);
      }
    };

    el.addEventListener("touchstart", onTouchStart, { passive: false });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd);
    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
    };
  }, []);

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
