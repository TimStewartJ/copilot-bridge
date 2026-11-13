import { describe, expect, it } from "vitest";
import { setupTestDb } from "./helpers.js";
import {
  buildModelAbTestReport,
  chooseModelAbTestArm,
  createModelAbTestStore,
  type ModelAbTestAssignment,
} from "../model-ab-test.js";
import type { AppSettings } from "../settings-store.js";

const STARTED = "2026-03-02T09:00:00.000Z";
const TEST = { enabled: true, a: "preset2", b: "preset3", startedAt: STARTED } as const;
const PRESETS = {
  preset2: { model: "model-standard", reasoningEffort: "high" },
  preset3: { model: "model-deep" },
};

function assignment(sessionId: string, overrides: Partial<ModelAbTestAssignment> = {}): ModelAbTestAssignment {
  return {
    sessionId,
    testStartedAt: STARTED,
    arm: "a",
    tier: "preset2",
    model: "model-standard",
    reasoningEffort: "high",
    source: "chat",
    assignedAt: STARTED,
    ...overrides,
  };
}

describe("chooseModelAbTestArm", () => {
  it.each<[string, Pick<AppSettings, "modelAbTest" | "modelPresets">, Array<{ id: string; policy?: { state: string } }> | undefined, number, unknown]>([
    ["off", { modelAbTest: { ...TEST, enabled: false }, modelPresets: PRESETS }, undefined, 0.2, undefined],
    ["an arm's tier without a model", { modelAbTest: TEST, modelPresets: { preset2: PRESETS.preset2 } }, undefined, 0.2, undefined],
    ["an arm's model turned off", { modelAbTest: TEST, modelPresets: PRESETS }, [{ id: "model-standard" }, { id: "model-deep", policy: { state: "disabled" } }], 0.2, undefined],
    ["a draw below half", { modelAbTest: TEST, modelPresets: PRESETS }, [{ id: "model-standard" }, { id: "model-deep" }], 0.2, { testStartedAt: STARTED, arm: "a", tier: "preset2" }],
    ["a draw of half or more", { modelAbTest: TEST, modelPresets: PRESETS }, undefined, 0.5, { testStartedAt: STARTED, arm: "b", tier: "preset3" }],
  ])("with %s", (_case, settings, models, draw, expected) => {
    expect(chooseModelAbTestArm(settings, models, () => draw)).toEqual(expected);
  });
});

describe("model A/B test store", () => {
  it("keeps the first arm a chat got and notes only its first change away from it", () => {
    const store = createModelAbTestStore(setupTestDb());
    store.record(assignment("chat-1"));
    store.record(assignment("chat-1", { arm: "b", tier: "preset3", model: "model-deep" }));
    store.record(assignment("older-test", { testStartedAt: "2026-02-01T09:00:00.000Z" }));

    store.noteModelChange("chat-1", "model-standard", "high", "2026-03-02T10:00:00.000Z");
    expect(store.listForTest(STARTED)).toEqual([assignment("chat-1")]);

    store.noteModelChange("chat-1", "model-standard", "low", "2026-03-02T11:00:00.000Z");
    store.noteModelChange("chat-1", "model-deep", undefined, "2026-03-02T12:00:00.000Z");
    expect(store.listForTest(STARTED)).toEqual([assignment("chat-1", { switchedAt: "2026-03-02T11:00:00.000Z" })]);
  });
});

describe("buildModelAbTestReport", () => {
  it("counts each arm's chats and scheduled runs and adds only recorded cost", () => {
    const report = buildModelAbTestReport(TEST, [
      assignment("chat-1"),
      assignment("run-1", { source: "schedule", switchedAt: STARTED }),
      assignment("chat-2", { arm: "b", tier: "preset3", model: "model-deep", reasoningEffort: undefined }),
    ], [
      { sessionId: "chat-1", meteredAiCredits: 40, meteredTokens: 900 },
      // An older log without metering is not a free run.
      { sessionId: "chat-2", meteredAiCredits: 0, meteredTokens: 0 },
      { sessionId: "not-in-test", meteredAiCredits: 99, meteredTokens: 10 },
    ]);
    expect(report).toEqual({
      startedAt: STARTED,
      arms: [
        { arm: "a", tier: "preset2", setup: { model: "model-standard", reasoningEffort: "high" }, chats: 1, scheduledRuns: 1, switched: 1, meteredSessions: 1, meteredAiCredits: 40 },
        { arm: "b", tier: "preset3", setup: { model: "model-deep" }, chats: 1, scheduledRuns: 0, switched: 0, meteredSessions: 0, meteredAiCredits: 0 },
      ],
    });
    expect(buildModelAbTestReport({ enabled: false, a: "preset2", b: "preset3" }, [], [])).toEqual({ startedAt: null, arms: [] });
  });
});
