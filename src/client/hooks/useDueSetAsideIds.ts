import { useEffect, useMemo, useState } from "react";
import type { Task } from "../api";
import { isRevisitDue } from "../lib/task-revisit";
import { isSetAsideTask } from "../task-helpers";

type DatedTask = Pick<Task, "id" | "deferred" | "muted" | "status" | "nextTouchAt">;

/** Set-aside tasks now due for revisit; stable identity so a clock tick alone re-sorts nothing. */
export default function useDueSetAsideIds(tasks: readonly DatedTask[]): ReadonlySet<string> {
  const [, setTick] = useState(0);
  const dated = useMemo(() => tasks.filter((task) => isSetAsideTask(task) && !!task.nextTouchAt), [tasks]);
  const waiting = dated.some((task) => !isRevisitDue(task.nextTouchAt));
  // Only a date still ahead needs the clock: while one exists, re-render each minute.
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => setTick((value) => value + 1), 60_000);
    return () => clearInterval(timer);
  }, [waiting]);
  const key = dated.filter((task) => isRevisitDue(task.nextTouchAt)).map((task) => task.id).join("\n");
  return useMemo(() => new Set(key ? key.split("\n") : []), [key]);
}
