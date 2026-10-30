import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, Session } from "../api";
import type { TaskOverview, TaskOverviewRow } from "../../shared/task-overview";
import type { TaskIndicator } from "./useTaskIndicators";
import { createTaskActivity } from "../../test-support/task-attention";
import { createDialogTestHarness, type DialogTestHarness } from "../test-dialog-harness";
import { waitUntilAct } from "../test-react-harness";
import { TASK_OVERVIEW_KEY } from "./queries/useTaskOverview";
import { useTaskAttention, useTaskAttentionPresentation } from "./useTaskAttention";

const api = vi.hoisted(() => ({ fetchTaskOverview: vi.fn() }));
vi.mock("../api", async importOriginal => ({ ...await importOriginal<typeof import("../api")>(), ...api }));

const NOW = "2026-10-20T15:00:00Z";
const task = (id: string, overrides: Partial<Task> = {}): Task => ({
  id, title: id, kind: "task", status: "active", muted: false, deferred: false, notes: "", priority: 0,
  order: 0, createdAt: NOW, updatedAt: NOW, activeSessionIds: [], sessionCount: 0, archivedSessionCount: 0,
  sessionLinksRevision: "0", workItems: [], pullRequests: [], ...overrides,
});
const row = (id: string, overrides: Partial<TaskOverviewRow> = {}): TaskOverviewRow => ({
  id, title: id, kind: "task", muted: false, deferred: false, order: 0, state: "no_next_step",
  reasons: [], idleDays: 0, staleWait: false, busyCount: 0, stalledCount: 0, inputCount: 0,
  automationCount: 0, activity: createTaskActivity(), ...overrides,
});
const overview = (rows: TaskOverviewRow[]): TaskOverview => ({
  tasks: rows, sessionsComplete: true, generatedAt: NOW,
  counts: { needs_you: 0, in_motion: 0, waiting: 0, up_next: 0, no_next_step: rows.length, gone_quiet: 0, set_aside: 0 },
});
const indicator = (overrides: Partial<TaskIndicator> = {}): TaskIndicator => ({
  busy: false, busyCount: 0, stalled: false, unread: false, unreadCount: 0, needsUserInputCount: 0,
  readStateKnown: true, sessionStateKnown: true, lastActivity: NOW, ...overrides,
});
const sourceGap = () => createTaskActivity({
  known: false, sessionIndexKnown: false,
  unavailable: { scope: "source", reason: "Preview conversations are isolated." },
});

describe("task attention source gaps", () => {
  let harness: DialogTestHarness;
  let reading: ReturnType<typeof useTaskAttentionPresentation>;
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    api.fetchTaskOverview.mockReset();
    harness = await createDialogTestHarness();
  });
  afterEach(async () => { await harness.cleanup(); vi.useRealTimers(); });

  async function render(tasks: Task[], data?: TaskOverview, indicators = new Map<string, TaskIndicator>(), error?: Error) {
    function Probe() {
      reading = useTaskAttentionPresentation(tasks, indicators, { data, isError: !!error });
      return null;
    }
    await harness.render(createElement(Probe));
  }

  it("shows no unknown/review badges while loading but keeps explicit attention", async () => {
    const tasks = ["idle", "question", "reply", "revisit"].map(id => task(id,
      id === "revisit" ? { nextTouchAt: "2026-10-19T15:00:00Z" } : {}));
    await render(tasks, undefined, new Map([
      ["question", indicator({ needsUserInputCount: 1 })],
      ["reply", indicator({ unreadCount: 1 })],
    ]));
    expect(reading.taskSignals.get("idle")).toBeNull();
    expect(reading.taskSignals.get("question")?.kind).toBe("needs-input");
    expect(reading.taskSignals.get("reply")?.kind).toBe("unread");
    expect(reading.taskSignals.get("revisit")?.label).toBe("Revisit");
    expect(reading.activityDescriptions.get("idle")).toBe("");
  });

  it("groups shared gaps without suppressing a healthy task's review cue", async () => {
    await render(["copy-a", "copy-b", "healthy"].map(id => task(id)), overview([
      row("copy-a", { activity: sourceGap() }), row("copy-b", { activity: sourceGap() }), row("healthy"),
    ]));
    expect(reading.taskSignals.get("copy-a")).toBeNull();
    expect(reading.taskSignals.get("copy-b")).toBeNull();
    expect(reading.taskSignals.get("healthy")?.kind).toBe("needs-look");
  });

  it("leaves expected preview isolation quiet without creating review suggestions", async () => {
    const activity = createTaskActivity({
      known: false, sessionIndexKnown: false,
      unavailable: { scope: "source", reason: "Preview conversations are isolated.", expectedInPreview: true },
    });
    const tasks = [task("copy"), task("healthy")], data = overview([row("copy", { activity }), row("healthy")]);
    await render(tasks, data, new Map([["copy", indicator({ sessionStateKnown: false, readStateKnown: false })]]));
    expect(reading.taskSignals.get("copy")).toBeNull();
    expect(reading.activityDescriptions.get("copy")).toBe("");
    expect(reading.taskSignals.get("healthy")?.kind).toBe("needs-look");
  });

  it("does not retain a stale review cue when a preview gap is expected", async () => {
    const tasks = [task("copy")];
    let data = overview([row("copy")]);
    function Probe() { reading = useTaskAttentionPresentation(tasks, undefined, { data, isError: false }); return null; }
    await harness.render(createElement(Probe));
    expect(reading.taskSignals.get("copy")?.kind).toBe("needs-look");
    data = overview([row("copy", { activity: createTaskActivity({
      known: false, sessionIndexKnown: false,
      unavailable: { scope: "source", reason: "Expected preview isolation.", expectedInPreview: true },
    }) })]);
    await harness.render(createElement(Probe));
    expect(reading.taskSignals.get("copy")).toBeNull();
  });

  it("reserves individual unknown badges for task-specific problems", async () => {
    await render(["broken", "healthy"].map(id => task(id)), overview([
      row("broken", { activity: createTaskActivity({
        known: false, sessionIndexKnown: false,
        unavailable: { scope: "task", reason: "A linked conversation is missing." },
      }) }), row("healthy"),
    ]));
    expect(reading.taskSignals.get("broken")).toMatchObject({ kind: "status-unknown", detail: "A linked conversation is missing." });
    expect(reading.taskSignals.get("healthy")?.kind).toBe("needs-look");
  });

  it("keeps saved waits and known work blank while shared information is missing", async () => {
    await render([task("wait", { waitingOn: "Reviewer" }), task("work"), task("question")], overview([
      row("wait", { activity: sourceGap() }), row("work", { activity: sourceGap() }),
      row("question", { activity: sourceGap(), inputCount: 1 }),
    ]), new Map([["work", indicator({ busy: true, busyCount: 1, sessionStateKnown: false, readStateKnown: false })]]));
    expect(reading.taskSignals.get("wait")).toBeNull();
    expect(reading.taskSignals.get("work")).toBeNull();
    expect(reading.taskSignals.get("question")?.kind).toBe("needs-input");
    expect(reading.activityDescriptions.get("wait")).toBe("Waiting for: Reviewer");
  });

  it("distinguishes read-state loading, initial failure and failed refresh", async () => {
    const tasks = [task("task")], data = overview([row("task")]);
    await render(tasks, data, new Map([["task", indicator({ readStateKnown: false })]]));
    expect(reading.taskSignals.get("task")).toBeNull();
    await render(tasks, data, new Map([["task", indicator({ readStateKnown: false, readStateError: "Offline" })]]));
    expect(reading.taskSignals.get("task")).toBeNull();
    await render(tasks, data, new Map([["task", indicator({ unreadCount: 1, readStateError: "Offline" })]]));
    expect(reading.taskSignals.get("task")?.kind).toBe("unread");
  });

  it("distinguishes conversation-source loading from failure without row-level Unknown noise", async () => {
    const tasks = [task("task")], data = overview([row("task")]);
    await render(tasks, data, new Map([["task", indicator({ sessionStateKnown: false, sessionSource: { loading: true } })]]));
    expect(reading.taskSignals.get("task")).toBeNull();
    await render(tasks, data, new Map([["task", indicator({ sessionStateKnown: false, sessionSource: { loading: false, error: "Offline" } })]]));
    expect(reading.taskSignals.get("task")).toBeNull();
  });

  it("keeps cached attention and manual order on refresh failure instead of replacing it with Unknown", async () => {
    api.fetchTaskOverview.mockResolvedValue(overview([row("first"), row("second", { waitingOn: "Reviewer", nextTouchAt: "2099-01-01T00:00:00Z" })]));
    const tasks = [task("first"), task("second", { waitingOn: "Reviewer", nextTouchAt: "2099-01-01T00:00:00Z" })];
    let result: ReturnType<typeof useTaskAttention>;
    const sessions: Session[] = [];
    function Probe() {
      result = useTaskAttention(tasks, sessions, () => false);
      return null;
    }
    await harness.render(createElement(Probe));
    await waitUntilAct(harness.act, () => result.overview.isSuccess);
    expect([...result!.taskSignals.keys()]).toEqual(["first", "second"]);
    expect(result!.taskSignals.get("first")?.kind).toBe("needs-look");
    api.fetchTaskOverview.mockRejectedValue(new Error("Offline"));
    await harness.act(async () => { await harness.queryClient.refetchQueries({ queryKey: TASK_OVERVIEW_KEY }); });
    await waitUntilAct(harness.act, () => result.overview.isError);
    expect([...result!.taskSignals.keys()]).toEqual(["first", "second"]);
    expect(result!.taskSignals.get("first")?.kind).toBe("needs-look");
    expect(result!.taskSignals.get("second")).toBeNull();
  });

  it("retains the previous reading when the server reports a shared source failure, then recovers", async () => {
    api.fetchTaskOverview.mockResolvedValue(overview([row("task")]));
    const tasks = [task("task")], sessions: Session[] = [];
    let result: ReturnType<typeof useTaskAttention>;
    function Probe() { result = useTaskAttention(tasks, sessions, () => false); return null; }
    await harness.render(createElement(Probe));
    await waitUntilAct(harness.act, () => result.overview.isSuccess);
    expect(result!.taskSignals.get("task")?.kind).toBe("needs-look");
    api.fetchTaskOverview.mockResolvedValue(overview([row("task", { activity: sourceGap() })]));
    await harness.act(async () => { await harness.queryClient.refetchQueries({ queryKey: TASK_OVERVIEW_KEY }); });
    await waitUntilAct(harness.act, () => result.overview.data?.tasks[0]?.activity?.known === false);
    expect(result!.taskSignals.get("task")?.kind).toBe("needs-look");
    api.fetchTaskOverview.mockResolvedValue(overview([row("task", { activity: createTaskActivity({ scheduledCount: 1 }) })]));
    await harness.act(async () => { await harness.queryClient.refetchQueries({ queryKey: TASK_OVERVIEW_KEY }); });
    await waitUntilAct(harness.act, () => result.overview.data?.tasks[0]?.activity?.scheduledCount === 1);
    expect(result!.taskSignals.get("task")).toBeNull();
  });

  it("does not resurrect an acknowledged reply from its previous reading", async () => {
    const tasks = [task("task")];
    let data = overview([row("task")]);
    let indicators = new Map([["task", indicator({ unreadCount: 1 })]]);
    function Probe() {
      reading = useTaskAttentionPresentation(tasks, indicators, { data, isError: false });
      return null;
    }
    await harness.render(createElement(Probe));
    expect(reading.taskSignals.get("task")?.kind).toBe("unread");
    data = overview([row("task", { activity: sourceGap() })]);
    indicators = new Map([["task", indicator()]]);
    await harness.render(createElement(Probe));
    expect(reading.taskSignals.get("task")).toBeNull();
    indicators = new Map([["task", indicator({ sessionStateKnown: false })]]);
    await harness.render(createElement(Probe));
    expect(reading.taskSignals.get("task")).toBeNull();
  });
});
