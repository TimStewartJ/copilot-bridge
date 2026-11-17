// Model A/B test (shared/model-ab-test.ts): which arm a new chat starts on, where that is recorded,
// and the per-arm report Settings › Models shows.
import type { DatabaseSync } from "./db.js";
import type { AppSettings } from "./settings-store.js";
import type { CopilotUsageSessionRow } from "./copilot-usage.js";
import { resolveModelTier, type RoleModelInfo } from "./model-roles.js";
import { isModelPresetSlot, type ModelPresetSlot } from "../shared/model-presets.js";
import { isCopilotContextTier, type CopilotContextTier } from "../shared/copilot-context.js";
import {
  MODEL_AB_TEST_ARMS,
  type ModelAbTestArm,
  type ModelAbTestArmReport,
  type ModelAbTestReport,
  type ModelAbTestSettings,
} from "../shared/model-ab-test.js";

export interface ModelAbTestChoice {
  testStartedAt: string;
  arm: ModelAbTestArm;
  tier: ModelPresetSlot;
}

export interface ModelAbTestAssignment extends ModelAbTestChoice {
  sessionId: string;
  model: string;
  reasoningEffort?: string;
  contextTier?: CopilotContextTier;
  source: "chat" | "schedule";
  assignedAt: string;
  switchedAt?: string;
}

/**
 * The arm a new chat starts on while a test runs, or undefined when it starts on New chats as usual.
 * Both arms have to be usable: skipping only the broken one would send every chat to the other arm.
 */
export function chooseModelAbTestArm(
  settings: Pick<AppSettings, "modelAbTest" | "modelPresets"> | undefined,
  models: readonly RoleModelInfo[] | undefined,
  random: () => number = Math.random,
): ModelAbTestChoice | undefined {
  const test = settings?.modelAbTest;
  if (!test?.enabled || !test.startedAt) return undefined;
  if (!resolveModelTier(settings, test.a, models).model || !resolveModelTier(settings, test.b, models).model) return undefined;
  const arm: ModelAbTestArm = random() < 0.5 ? "a" : "b";
  return { testStartedAt: test.startedAt, arm, tier: test[arm] };
}

/** Counts and recorded cost per arm for the current test; `usage` is the usage reader's session rows. */
export function buildModelAbTestReport(
  test: ModelAbTestSettings | undefined,
  assignments: readonly ModelAbTestAssignment[],
  usage: readonly Pick<CopilotUsageSessionRow, "sessionId" | "meteredAiCredits" | "meteredTokens">[],
): ModelAbTestReport {
  if (!test?.startedAt) return { startedAt: null, arms: [] };
  const usageBySession = new Map(usage.map((row) => [row.sessionId, row]));
  const arms = MODEL_AB_TEST_ARMS.map((arm): ModelAbTestArmReport => {
    const report: ModelAbTestArmReport = {
      arm,
      tier: test[arm],
      chats: 0,
      scheduledRuns: 0,
      switched: 0,
      meteredSessions: 0,
      meteredAiCredits: 0,
    };
    for (const assignment of assignments) {
      if (assignment.arm !== arm) continue;
      report.tier = assignment.tier;
      report.setup ??= {
        model: assignment.model,
        ...(assignment.reasoningEffort ? { reasoningEffort: assignment.reasoningEffort } : {}),
        ...(assignment.contextTier ? { contextTier: assignment.contextTier } : {}),
      };
      if (assignment.source === "schedule") report.scheduledRuns += 1;
      else report.chats += 1;
      if (assignment.switchedAt) report.switched += 1;
      const row = usageBySession.get(assignment.sessionId);
      // A row without metering is an older or unfinished log, not a free chat.
      if (row && (row.meteredAiCredits > 0 || row.meteredTokens > 0)) {
        report.meteredSessions += 1;
        report.meteredAiCredits += row.meteredAiCredits;
      }
    }
    return report;
  });
  return { startedAt: test.startedAt, arms };
}

interface AssignmentRow {
  sessionId: string;
  testStartedAt: string;
  arm: string;
  tier: string;
  model: string;
  reasoningEffort: string | null;
  contextTier: string | null;
  source: string;
  assignedAt: string;
  switchedAt: string | null;
}

function fromRow(row: AssignmentRow): ModelAbTestAssignment | undefined {
  if ((row.arm !== "a" && row.arm !== "b") || !isModelPresetSlot(row.tier)) return undefined;
  return {
    sessionId: row.sessionId,
    testStartedAt: row.testStartedAt,
    arm: row.arm,
    tier: row.tier,
    model: row.model,
    ...(row.reasoningEffort ? { reasoningEffort: row.reasoningEffort } : {}),
    ...(isCopilotContextTier(row.contextTier) ? { contextTier: row.contextTier } : {}),
    source: row.source === "schedule" ? "schedule" : "chat",
    assignedAt: row.assignedAt,
    ...(row.switchedAt ? { switchedAt: row.switchedAt } : {}),
  };
}

export function createModelAbTestStore(db: DatabaseSync) {
  const insert = db.prepare(
    `INSERT INTO model_ab_assignments
       (sessionId, testStartedAt, arm, tier, model, reasoningEffort, contextTier, source, assignedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(sessionId) DO NOTHING`,
  );
  const switched = db.prepare(
    `UPDATE model_ab_assignments SET switchedAt = ?
     WHERE sessionId = ? AND switchedAt IS NULL
       AND (model <> ? OR IFNULL(reasoningEffort, '') <> ?)`,
  );
  const forTest = db.prepare("SELECT * FROM model_ab_assignments WHERE testStartedAt = ? ORDER BY assignedAt");

  function record(assignment: ModelAbTestAssignment): void {
    insert.run(
      assignment.sessionId,
      assignment.testStartedAt,
      assignment.arm,
      assignment.tier,
      assignment.model,
      assignment.reasoningEffort ?? null,
      assignment.contextTier ?? null,
      assignment.source,
      assignment.assignedAt,
    );
  }

  /** Notes that a chat now runs on something other than its arm; only the first change is kept. */
  function noteModelChange(sessionId: string, model: string, reasoningEffort: string | undefined, at: string): void {
    switched.run(at, sessionId, model, reasoningEffort ?? "");
  }

  function listForTest(testStartedAt: string): ModelAbTestAssignment[] {
    return (forTest.all(testStartedAt) as unknown as AssignmentRow[])
      .map(fromRow)
      .filter((assignment): assignment is ModelAbTestAssignment => assignment !== undefined);
  }

  return { record, noteModelChange, listForTest };
}

export type ModelAbTestStore = ReturnType<typeof createModelAbTestStore>;
