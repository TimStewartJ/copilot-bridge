import { useEffect, useRef } from "react";
import type { Task } from "../api";
import { focusTaskChoices, type FocusTaskChoice, type FocusTaskContext } from "../focus-filter-helpers";

function retainLabels(current: FocusTaskChoice[], previous: FocusTaskChoice[]): FocusTaskChoice[] {
  const choices = new Map(current.map((choice) => [choice.id, choice]));
  for (const choice of previous) {
    if (!choices.has(choice.id)) choices.set(choice.id, { ...choice, hint: "retained label" });
  }
  return [...choices.values()].sort((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id));
}

export function useFocusFilterChoices(tasks: Task[], contexts: FocusTaskContext[]) {
  const previousTasks = useRef<FocusTaskChoice[]>([]);
  const previousOriginals = useRef<FocusTaskChoice[]>([]);
  const taskChoices = retainLabels(focusTaskChoices(tasks, contexts), previousTasks.current);
  const originalChoices = retainLabels(focusTaskChoices(tasks, contexts, true), previousOriginals.current);
  // Filtering away a row must not turn its already-known task name back into
  // an opaque ID. Retained names are labels, not claims about current task state.
  useEffect(() => {
    previousTasks.current = taskChoices;
    previousOriginals.current = originalChoices;
  });
  return { taskChoices, originalChoices };
}
