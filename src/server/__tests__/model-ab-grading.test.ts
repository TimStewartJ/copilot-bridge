import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { makeTestDir, setupTestDb } from "./helpers.js";
import { buildModelAbTestReport } from "../model-ab-test.js";
import {
  createModelAbGradeStore,
  createModelAbTestGrader,
  readChatEventsForGrading,
  type ModelAbTestGrade,
} from "../model-ab-grading.js";
import type { AgentTrajectoryClassification, AgentTrajectoryClassifyRequest, AgentTrajectoryClassifyResult } from "../agent-backend/types.js";

const STARTED = "2026-03-02T09:00:00.000Z";
const TEST = { enabled: true, a: "preset2", b: "preset3", startedAt: STARTED } as const;

function row(overrides: Partial<AgentTrajectoryClassification>): AgentTrajectoryClassification {
  return {
    classifier: "outcome",
    classifierVersion: 1,
    scope: "session",
    unitId: "unit-1",
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

function graded(sessionId: string, arm: "a" | "b", classifications: AgentTrajectoryClassification[], tokens = 0): ModelAbTestGrade {
  return {
    sessionId,
    testStartedAt: STARTED,
    arm,
    status: "graded",
    gradedAt: STARTED,
    trajectoryFingerprint: `fp-${sessionId}`,
    eventCount: 10,
    inputTokens: tokens,
    outputTokens: tokens / 10,
    cachedInputTokens: 0,
    result: { classifications, trajectoryFingerprint: `fp-${sessionId}` },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("model A/B test grades in the report", () => {
  it("counts each arm's successful labels once per unit at each classifier's broadest scope", () => {
    const grades: ModelAbTestGrade[] = [
      graded("chat-a", "a", [
        // Two snapshots of one session: only the latest counts.
        row({ ordinal: 1, labels: { result: "partial" } }),
        row({ ordinal: 2, labels: { result: "done" } }),
        // outcome also reports turns, but it is counted per session.
        row({ scope: "turn", unitId: "turn-1", labels: { result: "partial" } }),
        row({ classifier: "effort", scope: "turn", unitId: "turn-1", labels: { level: "high" } }),
        row({ classifier: "effort", scope: "turn", unitId: "turn-2", labels: { level: "low" } }),
        row({ classifier: "effort", scope: "turn", unitId: "turn-3", status: "declined", labels: { level: "high" }, errorKind: "insufficient_evidence" }),
        row({ classifier: "effort", scope: "turn", unitId: "turn-4", status: "failed", errorKind: "http" }),
      ], 1_000),
      graded("chat-b", "b", [row({ labels: { result: "done" } })], 500),
      { ...graded("chat-b2", "b", []), status: "skipped", reason: "missing", result: undefined, inputTokens: 0, outputTokens: 0 },
    ];

    const report = buildModelAbTestReport(TEST, [], [], grades);

    expect(report.arms.map((arm) => arm.grades)).toEqual([
      {
        graded: 1,
        notGraded: {},
        judgeTokens: 1_100,
        labels: [
          { classifier: "effort", scope: "turn", label: "level", value: "high", count: 1 },
          { classifier: "effort", scope: "turn", label: "level", value: "low", count: 1 },
          { classifier: "outcome", scope: "session", label: "result", value: "done", count: 1 },
        ],
      },
      {
        graded: 1,
        notGraded: { missing: 1 },
        judgeTokens: 550,
        labels: [{ classifier: "outcome", scope: "session", label: "result", value: "done", count: 1 }],
      },
    ]);
  });
});

describe("model A/B test grader", () => {
  function setup(classify: (request: AgentTrajectoryClassifyRequest) => Promise<AgentTrajectoryClassifyResult>) {
    const copilotHome = makeTestDir("ab-grading");
    const eventsPath = (sessionId: string) => join(copilotHome, sessionId, "events.jsonl");
    const store = createModelAbGradeStore(setupTestDb());
    const classifyMock = vi.fn(classify);
    const grader = createModelAbTestGrader({
      store,
      listAssignments: () => [
        { sessionId: "chat-1", arm: "a" },
        { sessionId: "chat-2", arm: "b" },
        { sessionId: "chat-3", arm: "a" },
      ],
      classify: classifyMock,
      readEvents: (sessionId) => readChatEventsForGrading(eventsPath(sessionId)),
      logger: { log: vi.fn(), warn: vi.fn() },
    });
    const writeEvents = (sessionId: string, content: string) => {
      mkdirSync(join(copilotHome, sessionId), { recursive: true });
      writeFileSync(eventsPath(sessionId), content);
    };
    return { store, grader, classify: classifyMock, writeEvents };
  }

  it("grades only ungraded chats, records a missing log, and runs one grading at a time", async () => {
    const release = deferred<void>();
    const { store, grader, classify, writeEvents } = setup(async () => {
      await release.promise;
      return {
        trajectoryFingerprint: "fp-new",
        classifications: [row({ labels: { result: "done" }, inputTokens: 300, outputTokens: 20, cachedInputTokens: 100 })],
      };
    });
    store.save(graded("chat-1", "a", [row({ labels: { result: "done" } })]));
    writeEvents("chat-1", '{"type":"user.message","id":"e0"}\n');
    writeEvents("chat-2", '{"type":"user.message","id":"e1"}\r\nnot json\n{"type":"assistant.message","id":"e2"}');

    expect(grader.start(STARTED)).toBe("started");
    expect(grader.start(STARTED, { regrade: true })).toBe("running");
    expect(grader.status(STARTED)).toMatchObject({ running: true, total: 2 });
    release.resolve();
    await grader.settled();

    expect(classify).toHaveBeenCalledTimes(1);
    expect(classify).toHaveBeenCalledWith({ events: [{ type: "user.message", id: "e1" }, { type: "assistant.message", id: "e2" }] });
    const grades = new Map(store.listForTest(STARTED).map((grade) => [grade.sessionId, grade]));
    expect(grades.get("chat-2")).toMatchObject({
      arm: "b",
      status: "graded",
      trajectoryFingerprint: "fp-new",
      eventCount: 2,
      inputTokens: 300,
      outputTokens: 20,
      cachedInputTokens: 100,
    });
    expect(grades.get("chat-3")).toMatchObject({ arm: "a", status: "skipped", reason: "missing" });
    expect(grader.status(STARTED)).toMatchObject({ running: false, total: 2, done: 2, ungraded: 0 });
    expect(grader.start(STARTED)).toBe("nothing");
  });

  it("on a regrade, retries only the failed rows of a chat whose log is unchanged", async () => {
    const previous = graded("chat-1", "a", [
      row({ labels: { result: "done" } }),
      row({ classifier: "effort", status: "failed", errorKind: "http" }),
    ]);
    const { store, grader, classify, writeEvents } = setup(async (request) => request.validateOnly
      ? { classifications: [], trajectoryFingerprint: "fp-chat-1", validation: { valid: true, inputBytes: 40, errors: [] } }
      : { classifications: [], trajectoryFingerprint: "fp-other" });
    store.save(previous);
    writeEvents("chat-1", '{"type":"user.message","id":"e0"}\n');
    writeEvents("chat-2", '{"type":"user.message","id":"e1"}\n');

    expect(grader.start(STARTED, { regrade: true })).toBe("started");
    await grader.settled();

    const fullRuns = classify.mock.calls.map(([request]) => request).filter((request) => !request.validateOnly);
    expect(fullRuns).toEqual([
      { events: [{ type: "user.message", id: "e0" }], previousResult: previous.result },
      { events: [{ type: "user.message", id: "e1" }] },
    ]);
    // chat-3 had no log and nothing to keep, so the regrade records why.
    expect(store.listForTest(STARTED).find((grade) => grade.sessionId === "chat-3")).toMatchObject({ status: "skipped", reason: "missing" });
  });
});
