import { lazy, Suspense, useLayoutEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import type { Task } from "../api";
import { DS, cx } from "../design/tokens";
import { getRememberedDashboardPath } from "../lib/dashboard-routes";
import { prefersReducedMotion } from "../lib/motion";
import type { CalendarEntry } from "./calendar-entry";

const CalendarPage = lazy(() => import("./CalendarPage"));

export default function CalendarScreen({ phone, lifted, entry, onSelectTask, tasks }: {
  phone: boolean;
  lifted: boolean;
  entry: CalendarEntry | null;
  onSelectTask: (id: string, opts?: { checklistItemId?: string }) => void;
  tasks: Task[];
}) {
  const navigate = useNavigate();
  const surface = useRef<HTMLDivElement>(null);
  const exit = useRef<Animation | null>(null);
  useLayoutEffect(() => () => { exit.current?.cancel(); exit.current = null; }, []);

  function close() {
    const leave = () => entry ? navigate(-1) : navigate(getRememberedDashboardPath(), { replace: true });
    const el = surface.current;
    if (!lifted || !el?.animate || prefersReducedMotion()) { void leave(); return; }
    if (exit.current) return;
    const address = window.location.href;
    const animation = el.animate([{ transform: getComputedStyle(el).transform }, { transform: "translateY(100%)" }],
      { duration: 190, easing: "cubic-bezier(.4,0,.8,.5)", fill: "forwards" });
    exit.current = animation;
    el.inert = true;
    void animation.finished.then(() => {
      // Native Back, or a new route, wins over an unfinished dismissal.
      if (el.isConnected && window.location.href === address) void leave();
      else { animation.cancel(); el.inert = false; exit.current = null; }
    }, () => {});
  }

  return <div ref={surface} className={cx("flex min-h-0 flex-1 flex-col", phone && DS.surface.canvas, lifted && "calendar-lift")}>
    <Suspense fallback={<div className="flex flex-1 items-center justify-center text-sm text-text-muted">Loading calendar…</div>}>
      <CalendarPage onSelectTask={onSelectTask} tasks={tasks}
        mobileBack={phone ? { label: entry?.from === "task" ? "Task" : "Home", onBack: close } : undefined} />
    </Suspense>
  </div>;
}
