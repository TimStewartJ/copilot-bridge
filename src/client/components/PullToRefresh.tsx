import { useRef, useState, useEffect, type ReactNode } from "react";
import { Loader2, ArrowDown } from "lucide-react";

interface PullToRefreshProps {
  onRefresh: () => Promise<void>;
  children: ReactNode;
  className?: string;
  /** When this or children structure changes, scroll resets to top */
  scrollKey?: string;
}

const THRESHOLD = 64;    // px to pull before triggering refresh
const MAX_PULL = 100;    // max visual displacement
const RESISTANCE = 0.45; // damping factor past threshold
// Tolerate sub-pixel scroll positions left over from momentum / rounding
const SCROLL_TOP_EPSILON = 1;

export default function PullToRefresh({ onRefresh, children, className = "", scrollKey }: PullToRefreshProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const startYRef = useRef(0);
  const pullingRef = useRef(false);
  const pullDistRef = useRef(0);          // always-current pull distance (no stale closure)
  const onRefreshRef = useRef(onRefresh); // avoid re-attaching listeners when callback changes
  onRefreshRef.current = onRefresh;

  const [pullDistance, setPullDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const refreshingRef = useRef(false);

  // Keep pullDistRef in sync with state
  useEffect(() => { pullDistRef.current = pullDistance; }, [pullDistance]);

  // Reset scroll position when scrollKey changes (e.g. tab switch)
  useEffect(() => {
    containerRef.current?.scrollTo(0, 0);
  }, [scrollKey]);

  // Register ALL touch handlers as native listeners with { passive: false }
  // so the browser waits for our preventDefault before committing to native
  // scrolling. React synthetic handlers are delegated to the root element
  // which some mobile browsers don't consider when choosing touch-action.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onTouchStart = (e: TouchEvent) => {
      if (refreshingRef.current) return;
      if (el.scrollTop > SCROLL_TOP_EPSILON) return;
      startYRef.current = e.touches[0].clientY;
      pullingRef.current = true;
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

      setPullDistance(Math.min(distance, MAX_PULL));
    };

    const onTouchEnd = async () => {
      if (!pullingRef.current) return;
      pullingRef.current = false;

      // Read from ref so we always get the latest value,
      // even if React hasn't committed the last setPullDistance yet.
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
