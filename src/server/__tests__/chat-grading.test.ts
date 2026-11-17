import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { makeTestDir, setupTestDb } from "./helpers.js";
import {
  buildChatGradeUnits,
  buildChatGradesReport,
  createChatGradeStore,
  createChatGrader,
  excerptsFor,
  readChatEventsForGrading,
  selectChatsForGrading,
  type ChatGrade,
  type ChatGradeUsageSession,
} from "../chat-grading.js";
import type { AgentTrajectoryClassification, AgentTrajectoryClassifyRequest, AgentTrajectoryClassifyResult } from "../agent-backend/types.js";

const GRADED_AT = "2026-03-02T09:00:00.000Z";

function row(overrides: Partial<AgentTrajectoryClassification>): AgentTrajectoryClassification {
  return {
    classifier: "task_outcome",
    classifierVersion: 1,
    scope: "task",
    unitId: "task-1",
    ordinal: 1,
    closeReason: "eof",
    status: "success",
    labels: {},
    metrics: {},
    textTruncated: false,
    unresolvedBoundaries: 0,
    ...overrides,
  };
}

function graded(sessionId: string, classifications: AgentTrajectoryClassification[]): ChatGrade {
  return {
    sessionId,
    status: "graded",
    gradedAt: GRADED_AT,
    trajectoryFingerprint: `fp-${sessionId}`,
    eventCount: 10,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    result: { classifications, trajectoryFingerprint: `fp-${sessionId}` },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("choosing chats to grade", () => {
  const usage = (sessionId: string, dates: string[], models: Array<[string, number]>): ChatGradeUsageSession => ({
    sessionId,
    days: dates.map((date) => ({ date })),
    models: models.map(([model, outputTokens]) => ({ model, outputTokens, totalTokens: outputTokens * 10 })),
  });
  const sessions = [
    // Most output on the sub-agent's model: that is the chat's model.
    usage("chat-mixed", ["2026-03-01", "2026-03-05"], [["model-a", 100], ["model-b", 400]]),
    usage("chat-a", ["2026-03-03"], [["model-a", 50]]),
    usage("chat-old", ["2026-02-10"], [["model-a", 50]]),
    usage("chat-scheduled", ["2026-03-04"], [["model-a", 50]]),
    usage("chat-no-log", ["2026-03-04"], [["model-b", 50]]),
  ];
  const select = (filters: Parameters<typeof selectChatsForGrading>[0]["filters"]) => selectChatsForGrading({
    sessions,
    scheduled: new Set(["chat-scheduled"]),
    hasEventsLog: async (sessionId) => sessionId !== "chat-no-log",
    filters,
  });

  it("keeps chats active in the range with a log, people's chats unless asked, and the chosen models", async () => {
    const inRange = await select({ from: "2026-03-01", to: "2026-03-04" });
    expect(inRange.matching).toEqual([
      { sessionId: "chat-mixed", model: "model-b", date: "2026-03-01" },
      { sessionId: "chat-a", model: "model-a", date: "2026-03-03" },
    ]);
    expect(Object.fromEntries(inRange.modelCounts)).toEqual({ "model-a": 1, "model-b": 1 });

    const withScheduled = await select({ from: "2026-03-01", includeScheduled: true, models: ["model-a"] });
    expect(withScheduled.matching.map((chat) => chat.sessionId)).toEqual(["chat-a", "chat-scheduled"]);
    expect(Object.fromEntries(withScheduled.modelCounts)).toEqual({ "model-a": 2, "model-b": 1 });

    expect((await select({})).matching.map((chat) => chat.sessionId)).toEqual(["chat-mixed", "chat-a", "chat-old"]);
    expect((await select({ sessionIds: ["chat-old", "chat-no-log", "chat-scheduled"] })).matching.map((chat) => chat.sessionId))
      .toEqual(["chat-old"]);
  });
});

describe("chat grades report", () => {
  it("counts each classifier's successful units per model by its main label key", () => {
    const chats = [
      { sessionId: "chat-1", model: "model-a", date: "2026-03-02", title: "Fix the build" },
      { sessionId: "chat-2", model: "model-a", date: "2026-03-03", title: "Plan the trip" },
      { sessionId: "chat-3", model: "model-b", date: "2026-03-01", title: "Write the notes" },
    ];
    const grades = [
      graded("chat-1", [
        row({ unitId: "task-1", labels: { outcome: "succeeded", effort: "high" }, inputTokens: 100, outputTokens: 10 }),
        row({ unitId: "task-2", labels: { outcome: "failed", effort: "low" } }),
        row({ unitId: "task-3", status: "declined", labels: { outcome: "succeeded" }, errorKind: "nothing_to_classify" }),
        row({ unitId: "task-4", status: "failed", errorKind: "http" }),
        // Two snapshots of one session: only the latest counts.
        row({ classifier: "session_taxonomy", scope: "session", unitId: "s", ordinal: 1, labels: { l1: "coding", l2: "tests" } }),
        row({ classifier: "session_taxonomy", scope: "session", unitId: "s", ordinal: 2, labels: { l1: "debugging", l2: "build" } }),
        // Counted per session, so its turn rows are left out.
        row({ classifier: "session_taxonomy", scope: "turn", unitId: "t", labels: { l1: "chat" } }),
        row({ classifier: "requested_task_demand", scope: "task", labels: { scope: "small", autonomy: "high" } }),
      ]),
      graded("chat-2", [row({ labels: { outcome: "succeeded" } })]),
      graded("chat-3", [row({ labels: { outcome: "succeeded" } })]),
    ];

    const report = buildChatGradesReport(chats, grades);

    expect(report.classifiers).toEqual([
      {
        classifier: "requested_task_demand", scope: "task", label: "autonomy",
        models: [{ model: "model-a", chats: 1, units: 1, judgeTokens: 0, values: [{ value: "high", count: 1 }] }],
      },
      {
        classifier: "session_taxonomy", scope: "session", label: "l1",
        models: [{ model: "model-a", chats: 1, units: 1, judgeTokens: 0, values: [{ value: "debugging", count: 1 }] }],
      },
      {
        classifier: "task_outcome", scope: "task", label: "outcome",
        models: [
          { model: "model-a", chats: 2, units: 3, judgeTokens: 110, values: [{ value: "succeeded", count: 2 }, { value: "failed", count: 1 }] },
          { model: "model-b", chats: 1, units: 1, judgeTokens: 0, values: [{ value: "succeeded", count: 1 }] },
        ],
      },
    ]);
    expect(report.chats.find((chat) => chat.sessionId === "chat-1")).toEqual({
      sessionId: "chat-1", title: "Fix the build", model: "model-a", date: "2026-03-02",
      labels: { task_outcome: ["succeeded", "failed"], session_taxonomy: ["debugging"], requested_task_demand: ["high"] },
    });
  });
});

describe("chat grade units", () => {
  it("keeps the latest row per classifier, scope and unit, with failed rows and only typed values", () => {
    const units = buildChatGradeUnits([
      graded("chat-1", [
        row({ classifier: "session_taxonomy", scope: "session", unitId: "s", ordinal: 1, labels: { l1: "coding" } }),
        row({ classifier: "session_taxonomy", scope: "session", unitId: "s", ordinal: 2, labels: { l1: "debugging" }, model: "judge-x" }),
        row({ classifier: "session_taxonomy", scope: "turn", unitId: "s", labels: { l1: "chat" } }),
        row({ unitId: "task-1", anchorEventId: "ev-1", labels: { outcome: "failed", skipped: undefined }, metrics: { confidence: 0.7 } }),
        row({ unitId: "task-2", status: "failed", errorKind: "http", textTruncated: true }),
      ]),
      { ...graded("chat-2", [row({})]), status: "skipped", reason: "too-large" },
    ]);
    expect(units.map((unit) => [unit.classifier, unit.scope, unit.unitId, unit.status, unit.labels])).toEqual([
      ["session_taxonomy", "session", "s", "success", { l1: "debugging" }],
      ["session_taxonomy", "turn", "s", "success", { l1: "chat" }],
      ["task_outcome", "task", "task-1", "success", { outcome: "failed" }],
      ["task_outcome", "task", "task-2", "failed", {}],
    ]);
    expect(units[0].judgeModel).toBe("judge-x");
    expect(units[2]).toMatchObject({ sessionId: "chat-1", anchorEventId: "ev-1", metrics: { confidence: 0.7 } });
    expect(units[3].textTruncated).toBe(true);
  });

  it("excerpts a user anchor with the agent's last own reply before the next user message", () => {
    const events = [
      { type: "user.message", id: "u1", data: { content: "Make the build pass" } },
      { type: "assistant.message", id: "a1", data: { content: "Looking." } },
      { type: "assistant.message", id: "a2", agentId: "helper", data: { content: "sub-agent text" } },
      { type: "assistant.message", id: "a3", data: { content: "" } },
      { type: "assistant.message", id: "a4", data: { content: "Done, tests pass." } },
      { type: "user.message", id: "u2", data: { content: "x".repeat(700) } },
      { type: "tool.execution_start", id: "t1", data: {} },
    ];
    const excerpts = excerptsFor(events, new Set(["u1", "u2", "t1", "missing"]));
    expect(excerpts.get("u1")).toEqual({ user: "Make the build pass", agent: "Done, tests pass." });
    expect(excerpts.get("u2")).toEqual({ user: `${"x".repeat(599)}\u2026`, agent: "" });
    expect([...excerpts.keys()]).toEqual(["u1", "u2"]);
  });
});

describe("chat grader", () => {
  function setup(classify: (request: AgentTrajectoryClassifyRequest) => Promise<AgentTrajectoryClassifyResult>) {
    const copilotHome = makeTestDir("chat-grading");
    const eventsPath = (sessionId: string) => join(copilotHome, sessionId, "events.jsonl");
    const store = createChatGradeStore(setupTestDb());
    const classifyMock = vi.fn(classify);
    const grader = createChatGrader({
      store,
      classify: classifyMock,
      readEvents: (sessionId) => readChatEventsForGrading(eventsPath(sessionId)),
      logger: { log: vi.fn(), warn: vi.fn() },
    });
    const writeEvents = (sessionId: string, content: string) => {
      mkdirSync(join(copilotHome, sessionId), { recursive: true });
      writeFileSync(eventsPath(sessionId), content);
    };
    const byId = (sessionIds: string[]) => new Map(store.listFor(sessionIds).map((grade) => [grade.sessionId, grade]));
    return { store, grader, classify: classifyMock, writeEvents, byId };
  }
  const CHATS = ["chat-1", "chat-2", "chat-3"];

  it("grades only ungraded chats, records a missing log, and runs one grading at a time", async () => {
    const release = deferred<void>();
    const { store, grader, classify, writeEvents, byId } = setup(async () => {
      await release.promise;
      return {
        trajectoryFingerprint: "fp-new",
        classifications: [row({ labels: { outcome: "succeeded" }, inputTokens: 300, outputTokens: 20, cachedInputTokens: 100 })],
      };
    });
    store.save(graded("chat-1", [row({ labels: { outcome: "succeeded" } })]));
    writeEvents("chat-1", '{"type":"user.message","id":"e0"}\n');
    writeEvents("chat-2", '{"type":"user.message","id":"e1"}\r\nnot json\n{"type":"assistant.message","id":"e2"}');

    expect(grader.start(CHATS)).toBe("started");
    expect(grader.start(CHATS, { regrade: true })).toBe("running");
    expect(grader.status()).toMatchObject({ running: true, total: 2 });
    release.resolve();
    await grader.settled();

    expect(classify).toHaveBeenCalledTimes(1);
    expect(classify).toHaveBeenCalledWith({ events: [{ type: "user.message", id: "e1" }, { type: "assistant.message", id: "e2" }] });
    const grades = byId(CHATS);
    expect(grades.get("chat-2")).toMatchObject({
      status: "graded",
      trajectoryFingerprint: "fp-new",
      eventCount: 2,
      inputTokens: 300,
      outputTokens: 20,
      cachedInputTokens: 100,
    });
    expect(grades.get("chat-3")).toMatchObject({ status: "skipped", reason: "missing" });
    expect(grader.status()).toMatchObject({ running: false, total: 2, done: 2 });
    expect(grader.pending(CHATS, false)).toEqual([]);
    expect(grader.start(CHATS)).toBe("nothing");
  });

  it("on a regrade, retries only the failed rows of a chat whose log is unchanged", async () => {
    const previous = graded("chat-1", [
      row({ labels: { outcome: "succeeded" } }),
      row({ classifier: "effort", status: "failed", errorKind: "http" }),
    ]);
    const { store, grader, classify, writeEvents, byId } = setup(async (request) => request.validateOnly
      ? { classifications: [], trajectoryFingerprint: "fp-chat-1", validation: { valid: true, inputBytes: 40, errors: [] } }
      : { classifications: [], trajectoryFingerprint: "fp-other" });
    store.save(previous);
    writeEvents("chat-1", '{"type":"user.message","id":"e0"}\n');
    writeEvents("chat-2", '{"type":"user.message","id":"e1"}\n');

    expect(grader.start(CHATS, { regrade: true })).toBe("started");
    await grader.settled();

    const fullRuns = classify.mock.calls.map(([request]) => request).filter((request) => !request.validateOnly);
    expect(fullRuns).toEqual(expect.arrayContaining([
      { events: [{ type: "user.message", id: "e0" }], previousResult: previous.result },
      { events: [{ type: "user.message", id: "e1" }] },
    ]));
    expect(fullRuns).toHaveLength(2);
    // chat-3 had no log and nothing to keep, so the regrade records why.
    expect(byId(["chat-3"]).get("chat-3")).toMatchObject({ status: "skipped", reason: "missing" });
  });
});
