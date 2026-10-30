import { describe, expect, it } from "vitest";
import { buildTaskTidyPrompt, taskTidyHints } from "../task-tidy.js";

describe("task tidy", () => {
  it.each([
    ["rules that cite when they were verified", { instructions: "Use gh (verified 2026-10-02). Reruns approved on 2026-10-02.", notes: "" }, []],
    ["dated stories", { instructions: "WATCH STOPPED (Oct27): sold. Suspended from Oct 20. GROUPED (20 Oct 21:39).", notes: "" }, ["instructions mention specific dates 3 times"]],
    ["ids of past items", { instructions: "Approved completing reminder00000000-1111-4222-8333-444444444444.", notes: "" }, ["instructions hold 1 id of specific items"]],
    ["long instructions and notes", { instructions: "x".repeat(6_001), notes: "y".repeat(12_001) }, ["instructions are 6,001 characters", "notes are 12,001 characters"]],
    ["words that only look like months", { instructions: "Mark 10 tasks; Decide 3 things; Octopus 5; Junebug 4.", notes: "" }, []],
  ])("flags %s", (_label, task, hints) => {
    expect(taskTidyHints(task)).toEqual(hints);
  });

  it("asks for a done-when only on a one-off task that has none", () => {
    const ask = /has no "done when"/;
    expect(buildTaskTidyPrompt({ id: "t1", title: "Trip", kind: "task" })).toMatch(ask);
    expect(buildTaskTidyPrompt({ id: "t1", title: "Trip", kind: "task", doneWhen: "Booked" })).not.toMatch(ask);
    expect(buildTaskTidyPrompt({ id: "t1", title: "Upkeep", kind: "ongoing" })).not.toMatch(ask);
  });
});
