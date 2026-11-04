import { useLayoutEffect, useRef } from "react";
import type { Location } from "react-router-dom";
import { isRecord } from "../../shared/is-record";
import { isDashboardRoutePath } from "../lib/dashboard-routes";

export type CalendarEntry = { from: "home" | "task"; openerId: string };

export function calendarEntryState(from: CalendarEntry["from"], openerId: string) {
  return { calendarEntry: { from, openerId } };
}

function readEntry(state: unknown): CalendarEntry | null {
  const entry = isRecord(state) ? state.calendarEntry : null;
  if (!isRecord(entry) || (entry.from !== "home" && entry.from !== "task") || typeof entry.openerId !== "string") return null;
  return { from: entry.from, openerId: entry.openerId };
}

/** Only a Home we actually showed sits behind the lift. A pasted Calendar URL is a normal page. */
export function useCalendarPresentation(location: Location, phone: boolean) {
  const lastHome = useRef<Location | null>(null);
  const opener = useRef<CalendarEntry | null>(null);
  const calendar = location.pathname.replace(/\/$/, "") === "/calendar";
  const entry = phone && calendar ? readEntry(location.state) : null;
  useLayoutEffect(() => {
    if (!phone) { lastHome.current = null; opener.current = null; return; }
    if (calendar) { opener.current = readEntry(location.state); return; }
    const home = isDashboardRoutePath(location.pathname);
    lastHome.current = home ? location : null;
    const previous = opener.current;
    opener.current = null;
    if (previous && (previous.from === "home" ? home : location.pathname.startsWith("/tasks/"))) {
      const trigger = document.getElementById(previous.openerId);
      if (trigger?.getClientRects().length) trigger.focus({ preventScroll: true });
      else {
        // Closing the last dated item can remove the task's calendar button.
        const fallback = document.querySelector<HTMLElement>("main h1") ?? document.querySelector("main");
        if (fallback) { fallback.tabIndex = -1; fallback.focus({ preventScroll: true }); }
      }
    }
  }, [calendar, location, phone]);
  return { entry, homeBehind: entry?.from === "home" ? lastHome.current : null };
}
