import { useEffect, useRef, useState, type RefObject } from "react";
import type { DocHeading } from "./docs-model";
import { cx } from "./docs-ui";
import { DS } from "../../design/tokens";

/** A heading counts as "current" once it has scrolled to within this distance of the top. */
const ACTIVE_OFFSET_PX = 96;

/**
 * Tracks which heading the reader is in. Scroll handling is throttled to one measurement per
 * frame, and the markdown itself never re-renders when the active heading changes.
 */
export function useActiveHeading(containerRef: RefObject<HTMLElement | null>, headings: DocHeading[]): string | null {
  const [activeId, setActiveId] = useState<string | null>(headings[0]?.id ?? null);
  const signature = headings.map((heading) => heading.id).join("\n");

  useEffect(() => {
    const container = containerRef.current;
    const ids = signature ? signature.split("\n") : [];
    if (!container || ids.length === 0 || typeof document.getElementById !== "function") {
      setActiveId(ids[0] ?? null);
      return;
    }

    let frame = 0;
    const measure = () => {
      frame = 0;
      const top = container.getBoundingClientRect().top;
      let current = ids[0];
      for (const id of ids) {
        const element = document.getElementById(id);
        if (!element) continue;
        if (element.getBoundingClientRect().top - top <= ACTIVE_OFFSET_PX) current = id;
        else break;
      }
      const atBottom = container.scrollTop > 0
        && container.scrollTop + container.clientHeight >= container.scrollHeight - 2;
      setActiveId(atBottom ? ids[ids.length - 1] : current);
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(measure);
    };

    measure();
    container.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      container.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [containerRef, signature]);

  return activeId;
}

export interface DocsTocProps {
  headings: DocHeading[];
  activeId: string | null;
  onSelect: (id: string) => void;
  /** "rail" is the desktop column; "sheet" is the roomier list shown in the mobile dialog. */
  variant?: "rail" | "sheet";
}

export default function DocsToc({ headings, activeId, onSelect, variant = "rail" }: DocsTocProps) {
  const listRef = useRef<HTMLUListElement | null>(null);
  const topLevel = headings.length ? Math.min(...headings.map((heading) => heading.level)) : 1;

  // Keep the active entry visible inside the rail without touching the page's own scroll.
  useEffect(() => {
    const list = listRef.current;
    if (variant !== "rail" || !list || !activeId || typeof list.querySelector !== "function") return;
    const scroller = list.parentElement;
    const item = list.querySelector<HTMLElement>(`[data-toc-id="${CSS.escape(activeId)}"]`);
    if (!scroller || !item) return;
    const itemTop = item.offsetTop;
    const itemBottom = itemTop + item.offsetHeight;
    if (itemTop < scroller.scrollTop + 24) scroller.scrollTop = Math.max(0, itemTop - 24);
    else if (itemBottom > scroller.scrollTop + scroller.clientHeight - 24) {
      scroller.scrollTop = itemBottom - scroller.clientHeight + 24;
    }
  }, [activeId, variant]);

  if (headings.length === 0) return null;
  const isRail = variant === "rail";

  return (
    <ul ref={listRef} className={cx("relative", isRail ? "border-l border-border" : "space-y-0.5")}>
      {headings.map((heading) => {
        const active = heading.id === activeId;
        const depth = Math.min(heading.level - topLevel, 2);
        return (
          <li key={heading.id}>
            <button
              type="button"
              data-toc-id={heading.id}
              aria-current={active ? "location" : undefined}
              onClick={() => onSelect(heading.id)}
              style={{ paddingLeft: `${(isRail ? 14 : 12) + depth * 12}px` }}
              className={cx(DS.row.stacked, "py-2 leading-5", isRail && "-ml-px border-l", active ? cx(DS.row.selected, "border-control-edge font-medium") : "border-transparent text-text-secondary")}
            >
              {heading.text}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
