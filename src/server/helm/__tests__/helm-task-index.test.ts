import { describe, expect, it } from "vitest";
import { buildHelmTaskIndex, HELM_TASK_INDEX_MAX_CHARS } from "../helm-task-index.js";

function task(id: string, title: string, overrides: Partial<{ status: "active" | "archived"; deferred: boolean; priority: number; updatedAt: string }> = {}) {
  return { id, title, status: "active" as const, deferred: false, priority: 0, updatedAt: "2026-10-01T00:00:00.000Z", ...overrides };
}

describe("buildHelmTaskIndex", () => {
  it("lists live tasks, worked-on before set aside, by priority then activity, with Helm's thread lines", () => {
    const index = buildHelmTaskIndex({
      tasks: [
        task("t-old", "Old migration", { status: "archived", priority: 5 }),
        task("t-garden", "Garden planner", { deferred: true, priority: 3 }),
        task("t-bridge", "Copilot Bridge", { updatedAt: "2026-10-30T00:00:00.000Z" }),
        task("t-trip", "Trip [Lisbon] plans", { updatedAt: "2026-10-02T00:00:00.000Z" }),
        task("t-taxes", "Taxes", { priority: 1 }),
      ],
      threads: new Map([
        ["t-bridge", { text: "Ongoing app work;\n  calendar import in review." }],
        ["t-trip", { text: "Waiting on hotel reply.", from: ["Mail"] }],
        ["t-old", { text: "Done." }],
      ]),
      // A session's activity counts as the task's: the trip chat is newer than the task's change.
      lastActivity: new Map([["t-trip", Date.parse("2026-11-01T00:00:00.000Z")]]),
    });
    expect(index?.split("\n").slice(5)).toEqual([
      "- [Taxes](bridge://task/t-taxes)",
      "- [Trip Lisbon plans](bridge://task/t-trip): Waiting on hotel reply. [from Mail]",
      "- [Copilot Bridge](bridge://task/t-bridge): Ongoing app work; calendar import in review.",
      "- [Garden planner](bridge://task/t-garden) (set aside)",
      "</helm_task_index>",
    ]);
    expect(index).toMatch(/^<helm_task_index>\nCopilot Bridge added this index of the user's 4 live tasks when this conversation started/);
    expect(buildHelmTaskIndex({ tasks: [task("t-old", "Old", { status: "archived" })], threads: new Map() })).toBeUndefined();
  });

  it("stays within its size cap and says how many tasks it left out", () => {
    const tasks = Array.from({ length: 120 }, (_, i) => task(`task-${String(i).padStart(3, "0")}`, `Task number ${i} with a fairly long descriptive title`, { priority: 120 - i }));
    const threads = new Map(tasks.map((entry) => [entry.id, { text: "x".repeat(600) }]));
    const index = buildHelmTaskIndex({ tasks, threads })!;
    expect(index.length).toBeLessThanOrEqual(HELM_TASK_INDEX_MAX_CHARS);
    const listed = index.split("\n").filter((line) => line.startsWith("- ["));
    // Highest priority first, and thread lines are clipped rather than dropped.
    expect(listed[0]).toMatch(/^- \[Task number 0 with .*\(bridge:\/\/task\/task-000\): x+…$/);
    expect(listed[0]!.length).toBeLessThan(300);
    expect(index).toContain(`\n${120 - listed.length} more live tasks not listed: use task_list or find.\n</helm_task_index>`);
  });

  it("tags each next step and waiting-for with its age, and names who set an old step on the user", () => {
    const now = Date.parse("2026-11-17T12:00:00.000Z");
    const set = (days: number, extra: object = {}) => ({ at: new Date(now - days * 86_400_000 - 60_000).toISOString(), source: "agent" as const, sessionId: "s-9", ...extra });
    const index = buildHelmTaskIndex({
      now,
      tasks: [
        { ...task("t-ask", "Ask Madina", { priority: 3 }), nextAction: "Draft the ask" },
        { ...task("t-fresh", "Fresh step", { priority: 2 }), nextAction: "Review the draft" },
        { ...task("t-iso", "Image build", { priority: 1 }), nextAction: "Flash the image", waitingOn: "The ISO" },
        { ...task("t-peer", "No stamps"), nextAction: "Anything" },
      ],
      threads: new Map(),
      attention: new Map([
        ["t-ask", { onUser: true, fromFields: true, reasons: [] }],
        ["t-fresh", { onUser: true, fromFields: true, reasons: [] }],
      ]),
      momentum: new Map([
        ["t-ask", { nextActionSet: set(5) }],
        ["t-fresh", { nextActionSet: set(1) }],
        ["t-iso", { nextActionSet: set(4, { scheduleName: "Sweep" }), waitingOnSet: { at: new Date(now - 2 * 86_400_000).toISOString(), source: "user" as const } }],
      ]),
    })!;
    expect(index.split("\n").filter((line) => line.startsWith("- ["))).toEqual([
      "- [Ask Madina](bridge://task/t-ask) ON YOU [next step set 5d ago by session s-9, unverified]",
      "- [Fresh step](bridge://task/t-fresh) ON YOU [next step set 1d ago]",
      "- [Image build](bridge://task/t-iso) [next step set 4d ago; waiting-for set 2d ago]",
      "- [No stamps](bridge://task/t-peer)",
    ]);
  });
});
