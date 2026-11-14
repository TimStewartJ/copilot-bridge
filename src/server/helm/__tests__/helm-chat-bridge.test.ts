import { describe, expect, it } from "vitest";
import { buildThinkerPacket, readBridgeForChat, renderThinkerPacket } from "../thinker/context.js";
import type { HelmSource } from "../thinker/sources.js";
import type { HelmMemoryEntry } from "../../../shared/helm-thinker.js";
import { validatePublication } from "../thinker/publish.js";
import { onYouList } from "../thinker/thinker.js";
import { taskBasis } from "../attention.js";

const empty = { items: [], total: 0, hasMore: false };

function source(taskCount: number, row: Record<string, unknown> = {}): HelmSource {
  return {
    id: "pc", label: "PC", local: false, webBase: null,
    sessions: async () => [],
    snapshot: async () => ({ inputs: empty, replies: empty, actions: empty }) as any,
    overview: async () => ({
      tasks: Array.from({ length: taskCount }, (_, index) => ({
        id: `t${index}`, title: `Task ${index}`, state: "active", reasons: [], muted: false, busyCount: 0, idleDays: 3,
        nextAction: "x".repeat(400), waitingOn: "y".repeat(300), ...row,
      })),
    }) as any,
    input: async () => undefined,
    messages: async () => [],
    answer: async () => undefined,
    send: async () => undefined,
    tick: async () => undefined,
  };
}

describe("read_bridge for Helm's chat", () => {
  it("keeps a whole Bridge to a size the chat can read, and says what it left out", async () => {
    const view = await readBridgeForChat(source(150));
    expect(JSON.stringify(view).length).toBeLessThanOrEqual(40_000);
    expect(view.tasks.length).toBeGreaterThanOrEqual(20);
    expect(view.tasks.length + view.omitted!.tasks).toBe(150);
    expect(view.tasks[0]).toMatchObject({ taskId: "t0", title: "Task 0", idleDays: 3 });
  });

  it("returns a small Bridge whole", async () => {
    const view = await readBridgeForChat(source(3));
    expect(view.tasks).toHaveLength(3);
    expect(view.omitted).toBeUndefined();
  });
});

describe("the thinker's packet", () => {
  it("shows a task that has not moved with its dates and Helm's thread, but not its details", async () => {
    const at = "2026-10-29T15:00:00.000Z";
    const thread: HelmMemoryEntry = {
      id: "m1", kind: "thread", key: "pc:t0", text: "Waiting on the vendor's quote", source: null, author: "helm", status: "active",
      createdAt: at, updatedAt: at, confirmedAt: at, uses: 0, fromSources: [],
      basis: taskBasis({ nextAction: "x".repeat(400), waitingOn: "y".repeat(300), nextTouchAt: "2026-10-28T16:00:00.000Z" }),
    };
    const packet = await buildThinkerPacket({
      sources: [source(2, { lastEngagedAt: "2026-10-26T09:00:00.000Z", nextTouchAt: "2026-10-28T16:00:00.000Z" })],
      now: new Date("2026-10-29T18:00:00.000Z"), trigger: "schedule", rebuild: false, lastRunAt: at,
      memory: [thread], feedback: [], previousItems: [],
    });
    const [unchanged, changed] = JSON.parse(renderThinkerPacket(packet)).bridges[0].tasks;
    expect(unchanged).toEqual({
      taskId: "t0", title: "Task 0", state: "active",
      nextTouchAt: "2026-10-28T16:00:00.000Z", lastEngagedAt: "2026-10-26T09:00:00.000Z", idleDays: 3, thread: "Waiting on the vendor's quote",
    });
    expect(changed).toMatchObject({ taskId: "t1", changed: true, nextAction: expect.any(String), lastEngagedAt: "2026-10-26T09:00:00.000Z" });
  });

  it("reads tidy signs for this Bridge's tasks only on the weekly rebuild", async () => {
    const local = { ...source(2), id: "local", local: true };
    const tidyHints = (taskId: string) => (taskId === "t1" ? ["notes are 30,000 characters"] : []);
    const build = (rebuild: boolean, sources: HelmSource[]) => buildThinkerPacket({
      sources, now: new Date("2026-10-29T18:00:00.000Z"), trigger: "schedule", rebuild, lastRunAt: null,
      memory: [], feedback: [], previousItems: [], tidyHints,
    });
    const tidyOf = (packet: Awaited<ReturnType<typeof build>>) => packet.bridges.map((bridge) => bridge.tasks.map((task) => task.tidy));

    expect(tidyOf(await build(true, [local, source(2)]))).toEqual([[undefined, ["notes are 30,000 characters"]], [undefined, undefined]]);
    expect(tidyOf(await build(false, [local]))).toEqual([[undefined, undefined]]);
  });
});

describe("a task whose next step is Tim's", () => {
  // Shaped like a real miss: the task's agent wrote Tim's next step as an instruction, Helm's thread
  // line called it agent-run, and the brief put it under watching (morning) or left it out (evening).
  const thread = "Deadline passed: 41 of 64 done, the tab balances. Agent processing the Friday digest and Sam's paintball question, then locks the sheet. Agent-run; stay out unless it asks.";
  const absences = [{ title: "Mission trip", start: "2026-11-22", end: "2026-12-01" }];
  const morning = {
    nextAction: "After Thursday's deadline, check the Friday digest and confirm whether Sam played paintball before locking the sheet.",
    waitingOn: "Members ticking Paintball, Dinner and Done by Thursday 11/12", waitingSince: "2026-11-11T05:46:01.771Z",
    nextTouchAt: "2026-11-13T17:00:00.000Z", lastEngagedAt: "2026-11-11T06:18:20.054Z",
  };
  const evening = {
    nextAction: "Nudge the 11 members who stayed through Sunday but haven't touched their rows, ask Lee about Ben, then lock the sheet and send amounts.",
    nextTouchAt: "2026-11-14T17:00:00.000Z", lastEngagedAt: "2026-11-13T17:52:21.056Z",
  };
  const line = (at: string, extra: Partial<HelmMemoryEntry>): HelmMemoryEntry => ({
    id: "m1", kind: "thread", key: "local:t-retreat", text: thread, source: null, author: "helm", status: "active",
    createdAt: at, updatedAt: at, confirmedAt: at, uses: 0, fromSources: [], owner: "agent", ...extra,
  });
  const build = (now: string, lastRunAt: string, row: object, memory: HelmMemoryEntry[], notes = "") => buildThinkerPacket({
    sources: [{ ...source(1, { id: "t-retreat", title: "Retreat trip finances", state: "in_motion", idleDays: 0, waitingOn: undefined, ...row }), id: "local", local: true }],
    now: new Date(now), trigger: "schedule", rebuild: false, lastRunAt, memory, feedback: [], previousItems: [],
    attention: { timeZone: "America/Los_Angeles", absences, local: () => ({ notes, checklist: [] }) },
  });

  it.each([
    {
      when: "the morning after its deadline, while it still waits on a date that has passed",
      now: "2026-11-13T16:00:00.000Z", lastRunAt: "2026-11-13T02:00:00.000Z", row: morning, notes: "",
      // The line was written from these same fields, so it is current; the fields still overrule it.
      basis: taskBasis(morning), outOfDate: false,
      reason: "what it was waiting for was due Thu, Nov 12, which has passed",
    },
    {
      when: "that evening, with nothing waited on and amounts due before a trip",
      now: "2026-11-14T02:00:00.000Z", lastRunAt: "2026-11-13T16:00:00.000Z", row: evening,
      notes: "## Proposed dates (not agreed)\n- 11/12: roster final\n- 11/13: bills out\n- 11/20: payments due\n- 11/24: buyers repaid",
      // The line was written from the morning's fields; the next step has changed since.
      basis: taskBasis(morning), outOfDate: true,
      reason: "Fri, Nov 20 in its notes comes before Mission trip (from Sun, Nov 22)",
    },
  ])("needs him $when, whatever Helm's thread line says", async ({ now, lastRunAt, row, notes, basis, outOfDate, reason }) => {
    const memory = line(lastRunAt, { basis });
    const packet = await build(now, lastRunAt, row, [memory], notes);
    const [task] = JSON.parse(renderThinkerPacket(packet)).bridges[0].tasks;
    expect(task).toMatchObject({ taskId: "t-retreat", onTim: "fields", nextAction: row.nextAction, thread, threadOwner: "agent" });
    expect(task.needsTim).toContain(reason);
    expect(task.threadOutOfDate).toBe(outOfDate ? true : undefined);
    expect(task.basis).toBeUndefined();

    // Helm can't call it an agent's again or watch it; calling it Tim's stamps the fields it read.
    const asAgent = validatePublication({ summary: "x", items: [], memory: { threads: [{ bridge: "local", taskId: "t-retreat", text: thread, owner: "agent" }] } }, packet, [memory]);
    expect(asAgent.ok ? [] : asAgent.errors).toEqual([expect.stringMatching(/"Retreat trip finances" is Tim's move: no agent is working on it .* Its owner must be tim\.$/)]);
    const watched = validatePublication({ summary: "x", items: [], watching: [{ bridge: "local", taskId: "t-retreat", text: "The agent is working through the digest before locking the sheet." }] }, packet, [memory]);
    expect(watched.ok ? [] : watched.errors).toEqual([expect.stringMatching(/"Retreat trip finances" waits on no one but Tim/)]);
    const asTim = validatePublication({ summary: "x", items: [], memory: { threads: [{ bridge: "local", taskId: "t-retreat", text: "Tim nudges the stragglers, then sends amounts.", owner: "tim" }] } }, packet, [memory]);
    expect(asTim.ok && asTim.memory).toEqual([expect.objectContaining({ owner: "tim", holdUntil: null, basis: taskBasis(row) })]);

    // Left out of the items, Home still lists it under On you; an item about it takes its place there.
    expect(onYouList(packet, { items: [] }).onYou).toEqual([{ bridge: "local", taskId: "t-retreat", title: "Retreat trip finances", nextAction: row.nextAction, reasons: expect.arrayContaining([reason]) }]);
    const item = { id: "i1", kind: "due" as const, bridge: "local", title: "Send the amounts", recommendation: "Lock it now.", evidence: [{ label: "Task", target: { bridge: "local", taskId: "t-retreat" } }], actions: [] };
    expect(onYouList(packet, { items: [item] }).onYou).toEqual([]);
  });

  it("brings back a pause on Tim's own work before he goes away, even with no fields to go on", async () => {
    // Shaped like a donation question that needed only Tim's amount, paused "until December".
    const bare = { nextAction: undefined, waitingOn: undefined, state: "no_next_step", idleDays: 9 };
    const packet = await build("2026-11-13T18:00:00.000Z", "2026-11-13T02:00:00.000Z", bare, []);
    const pause = (holdUntil: string) => validatePublication({ summary: "x", items: [], memory: { threads: [{ bridge: "local", taskId: "t-retreat", text: "Needs Tim's amount; shares by Dec 31.", owner: "tim", holdUntil }] } }, packet, []);
    const december = pause("2026-12-01");
    expect(december.ok ? [] : december.errors).toEqual(["memory.threads 1: Tim is away from Sun, Nov 22 (Mission trip); a pause on his own work must end by 2026-11-21."]);
    expect(pause("2026-11-20").ok).toBe(true);

    const later = await build("2026-11-20T18:00:00.000Z", "2026-11-20T02:00:00.000Z", bare, [line("2026-11-13T18:00:00.000Z", { owner: "tim", holdUntil: "2026-11-20", basis: taskBasis({}) })]);
    expect(onYouList(later, { items: [] }).onYou).toEqual([expect.objectContaining({ taskId: "t-retreat", reasons: ["Helm's pause on it ends today"] })]);
  });
});
