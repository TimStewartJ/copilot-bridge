import type {
  FocusProtectionImpact, FocusProtectionPreview, FocusProtectionRequest,
  FocusProtectionSnapshot, FocusProtectionWindow,
} from "./api";
import { FOCUS_TEST_NOW } from "./test-focus-fixtures";

export function protectionRequest(overrides: Partial<FocusProtectionRequest> = {}): FocusProtectionRequest {
  return {
    endsAt: "2026-09-05T19:00:00.000Z", timezone: "UTC", reason: "Prepare launch review",
    allowNeedsInput: true, allowAuthorizedDeadlineOverride: false, ...overrides,
  };
}

export function protectionWindow(overrides: Partial<FocusProtectionWindow> = {}): FocusProtectionWindow {
  return {
    ...protectionRequest(), id: "protection-1", startsAt: FOCUS_TEST_NOW,
    createdAt: FOCUS_TEST_NOW, updatedAt: FOCUS_TEST_NOW, cancelledAt: null, status: "active", ...overrides,
  };
}

export function protectionImpact(overrides: Partial<FocusProtectionImpact> = {}): FocusProtectionImpact {
  return {
    id: "impact-1", windowId: "protection-1", kind: "schedule", workId: "cron-1",
    scheduledFor: "2026-09-05T18:05:00.000Z", endsAt: "2026-09-05T19:00:00.000Z",
    createdAt: FOCUS_TEST_NOW, title: "Release watch", disposition: null, settledAt: null, ...overrides,
  };
}

export function protectionSnapshot(overrides: Partial<FocusProtectionSnapshot> = {}): FocusProtectionSnapshot {
  return {
    generatedAt: FOCUS_TEST_NOW, current: null, upcoming: null, latest: null,
    impacts: { postponed: 0, pending: 0, dispositions: {}, recent: [] }, ...overrides,
  };
}

export function protectionPreview(overrides: Partial<FocusProtectionPreview> = {}): FocusProtectionPreview {
  return {
    generatedAt: FOCUS_TEST_NOW, request: protectionRequest(), startsAt: FOCUS_TEST_NOW, endsAt: "2026-09-05T19:00:00.000Z",
    schedules: [
      { id: "cron-1", name: "Release watch", taskId: "task-1", type: "cron", slotsDue: 4, firstScheduledFor: "2026-09-05T18:05:00.000Z", lastScheduledFor: "2026-09-05T18:50:00.000Z", expiresAt: null },
      { id: "once-1", name: "One-time review", taskId: "task-1", type: "once", slotsDue: 1, firstScheduledFor: "2026-09-05T18:30:00.000Z", lastScheduledFor: "2026-09-05T18:30:00.000Z", expiresAt: null },
    ],
    defers: [
      { id: "defer-1", deferId: "once_defer-1", kind: "defer", sessionId: "session-1", name: "Return with quote", scheduledFor: "2026-09-05T18:20:00.000Z", expiresAt: null, expiresDuringProtection: false },
      { id: "loop-1", deferId: "interval_loop-1", kind: "defer-loop", sessionId: "session-1", name: "Bounded release checks", scheduledFor: "2026-09-05T18:25:00.000Z", expiresAt: "2026-09-05T18:55:00.000Z", expiresDuringProtection: true },
    ],
    needsInput: [
      { sessionId: "session-1", title: "Muted release conversation", taskId: "task-1", muted: true, busy: false, pendingUserInputCount: 2 },
      { sessionId: "session-2", title: "Approval conversation", taskId: null, muted: false, busy: true, pendingUserInputCount: 1 },
    ],
    interventions: [
      { objectId: "alert-1", activationId: "activation-1", objectType: "alert", title: "Rollback window", interventionBy: "2026-09-05T18:30:00.000Z", taskId: "task-1", taskState: "active", notificationMode: "immediate", consequenceOfDelay: "Rollback becomes unavailable" },
      { objectId: "decision-1", activationId: "activation-1", objectType: "decision", title: "Quiet approval deadline", interventionBy: "2026-09-05T18:40:00.000Z", taskId: "task-2", taskState: "muted", notificationMode: "focus", consequenceOfDelay: "Release approval lapses" },
    ],
    inFlight: [
      { kind: "session", id: "session-1", name: "Existing session", sessionId: "session-1" },
      { kind: "session-creation", id: "creation-1", name: "Admitted session creation" },
      { kind: "schedule", id: "cron-running", name: "Admitted schedule" },
      { kind: "defer", id: "defer-running", name: "Admitted defer" },
      { kind: "defer-loop", id: "loop-running", name: "Admitted recurring check" },
    ],
    continuingRecoveryPrompts: 2, confirmationToken: "server-confirmation-1", ...overrides,
  };
}
