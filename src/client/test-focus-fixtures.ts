import type {
  ChecklistItem, FocusAlert, FocusAttentionAudit, FocusAuthorityGrant, FocusCoverageRead,
  FocusDecision, FocusDigest, FocusEvent, FocusObjectDetails, FocusSnapshot, Task,
  FocusEpisodeSnapshot, FocusSessionLaunch, FocusOverdueHandoffSummary, FocusQuietConcernSummary,
} from "./api";

export const FOCUS_TEST_NOW = "2026-09-05T18:00:00.000Z";
export const FOCUS_TEST_NOW_MS = Date.parse(FOCUS_TEST_NOW);

export function focusDetails(overrides: Partial<FocusObjectDetails> = {}): FocusObjectDetails {
  return {
    objectId: "decision-1", lifecycle: "active", sourceFamily: "release-watch", producer: "release-monitor",
    observedAt: FOCUS_TEST_NOW, validUntil: "2026-09-06T18:00:00.000Z", interventionBy: "2026-09-05T20:00:00.000Z",
    evidence: [{ summary: "The build failed its health check.", url: "https://example.test/evidence", observedAt: FOCUS_TEST_NOW }],
    impact: "The release cannot serve traffic.", consequenceOfDelay: "The rollback window will close.",
    alternatives: ["Roll back", "Repair the release"], recommendation: "Roll back before changing production.",
    fallback: "Keep the previous release running.", outcome: null, resolutionReason: null,
    notificationMode: "focus", authorizationGrantId: null, episodeReason: null, contentFingerprint: "fingerprint-1",
    lastMeaningfulChangeAt: FOCUS_TEST_NOW, acknowledgedAt: null, handedOffAt: null, resolvedAt: null,
    originalTaskId: "task-1", originalTaskTitle: "Bridge task", orphanedAt: null, ...overrides,
  };
}

export function focusDecision(overrides: Partial<FocusDecision> = {}): FocusDecision {
  return {
    id: "decision-1", objectType: "decision", dedupeKey: "release-watch:decision", title: "Should we roll back the release?",
    body: "Review **current evidence** before deciding.", priority: "normal", status: "active", lifecycle: "active",
    taskId: "task-1", taskTitle: "Bridge task", taskState: "active", sessionId: null, url: null, links: [],
    metadata: null, visual: null, launchPrompt: null, pinned: false, activationId: "activation-1",
    details: focusDetails(), linkedActions: [], statusChangedAt: FOCUS_TEST_NOW, createdAt: FOCUS_TEST_NOW,
    updatedAt: FOCUS_TEST_NOW, ...overrides,
  };
}

export function focusAlert(overrides: Partial<FocusAlert> = {}): FocusAlert {
  return { ...focusDecision(), id: "alert-1", objectType: "alert", title: "Release health check failed", priority: "high", details: focusDetails({ objectId: "alert-1" }), ...overrides };
}

export function focusEvent(overrides: Partial<FocusEvent> = {}): FocusEvent {
  return { ...focusDecision(), id: "event-1", objectType: "event", category: "note", title: "Release observation", details: focusDetails({ objectId: "event-1" }), ...overrides };
}

export function focusAction(overrides: Partial<ChecklistItem> = {}): ChecklistItem {
  return {
    id: "action-1", taskId: "task-1", text: "Roll back and verify the release", done: false, order: 0,
    createdAt: FOCUS_TEST_NOW, sources: [{ sourceId: "decision-1", sourceType: "decision", activationId: "activation-1", title: "Should we roll back the release?", lifecycle: "handed_off" }],
    ...overrides,
  };
}

export function focusTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1", title: "Bridge task", kind: "task", muted: false, status: "active", notes: "", priority: 0, order: 0,
    createdAt: FOCUS_TEST_NOW, updatedAt: FOCUS_TEST_NOW, sessionIds: [], workItems: [], pullRequests: [], ...overrides,
  };
}

export function focusDigest(overrides: Partial<FocusDigest> = {}): FocusDigest {
  return {
    id: '["task-1","family:release-watch"]', family: "release-watch", keyPrefix: null, category: null,
    taskId: "task-1", taskTitle: "Bridge task", quiet: false, count: 3, highPriorityCount: 0,
    latestUpdatedAt: FOCUS_TEST_NOW, sourceFamily: "release-watch", originalTaskId: "task-1", orphaned: false,
    lastViewedAt: null, newCount: 3, samples: [{ id: "event-1", title: "Release observation", category: "note", priority: "normal", updatedAt: FOCUS_TEST_NOW }],
    ...overrides,
  };
}

export function focusGrant(overrides: Partial<FocusAuthorityGrant> = {}): FocusAuthorityGrant {
  return {
    id: "grant-1", stableKey: "release-monitor", title: "Observe release health", taskId: "task-1",
    sourceFamily: "release-watch", producer: "release-monitor", scope: "Observe staging; no production changes",
    status: "active", validFrom: "2026-09-04T18:00:00.000Z", validUntil: "2026-09-06T18:00:00.000Z",
    allowImmediate: false, allowQuietHoursOverride: false, constraints: ["No production mutation"], grantedBy: "Tim",
    revokedAt: null, revokeReason: null, orphanedAt: null, createdAt: FOCUS_TEST_NOW, updatedAt: FOCUS_TEST_NOW, ...overrides,
  };
}

export function focusCoverage(overrides: Partial<FocusCoverageRead> = {}): FocusCoverageRead {
  return {
    id: "coverage-1", stableKey: "release-health", title: "Release checks", taskId: "task-1", sourceFamily: "release-watch",
    producer: "release-monitor", scope: "Staging health endpoint only", explicitState: "valid",
    lastCheckedAt: FOCUS_TEST_NOW, validUntil: "2026-09-06T18:00:00.000Z", interventionBy: null,
    expectedIntervalMinutes: 60, atRiskMinutes: 10, evidence: ["HTTP 200 observed at the last check."],
    reason: null, authorityGrantId: "grant-1", originalTaskTitle: null, orphanedAt: null,
    createdAt: FOCUS_TEST_NOW, updatedAt: FOCUS_TEST_NOW, state: "valid", observationGap: null,
    constrainedAutonomy: [], ...overrides,
  };
}

export function focusAudit(overrides: Partial<FocusAttentionAudit> = {}): FocusAttentionAudit {
  return {
    id: "audit-1", objectId: "alert-1", title: "Intervention was missed", category: "missed_attention", severity: "high",
    status: "open", notes: "Attention arrived after the intervention window.", outcome: null, actor: "user",
    createdAt: FOCUS_TEST_NOW, updatedAt: FOCUS_TEST_NOW, resolvedAt: null, ...overrides,
  };
}

export function focusSnapshot(overrides: Partial<FocusSnapshot> = {}): FocusSnapshot {
  return {
    generatedAt: FOCUS_TEST_NOW, alertTotal: 0, decisionTotal: 0, actionTotal: 0, attentionTotal: 0, handedOffTotal: 0,
    unresolvedHandoffTotal: 0, unresolvedHandoffs: [],
    overdueHandoffTotal: 0, overdueHandoffs: [], quietConcernTotal: 0, quietConcerns: [],
    digests: [], quietDigests: [],
    domainHealth: { actions: { status: "ok" }, alerts: { status: "ok" }, decisions: { status: "ok" },
      digests: { status: "ok" }, coverage: { status: "ok" }, authority: { status: "ok" }, audits: { status: "ok" },
      unresolvedHandoffs: { status: "ok" }, overdueHandoffs: { status: "ok" }, quietConcerns: { status: "ok" },
      compatibility: { status: "ok" }, telemetry: { status: "ok" } },
    allClear: true, coverage: { assertions: [focusCoverage()], summary: {
      total: 1, counts: { valid: 1, "at-risk": 0, expired: 0, broken: 0, unknown: 0 },
      observationGaps: [], upcomingInterventions: [], constrainedAutonomy: [],
    } },
    upcomingInterventions: [], authorityConstraints: [{ ...focusGrant(), currentlyActive: true }], auditExceptions: [],
    compatibilityErrorCount: 0, ...overrides,
  };
}

export function focusEpisode(overrides: Partial<FocusEpisodeSnapshot> = {}): FocusEpisodeSnapshot {
  return {
    ...focusDetails(), schemaVersion: 1, objectType: "decision", title: "Original release question",
    body: "Retained evidence and outcome.", category: null, activationId: "activation-1",
    taskId: "task-1", taskTitle: "Bridge task", sessionId: null, sessionIds: [], linkedActionIds: [], linkedActions: [],
    createdAt: FOCUS_TEST_NOW, updatedAt: FOCUS_TEST_NOW, statusChangedAt: FOCUS_TEST_NOW, ...overrides,
  };
}

export function focusLaunchReceipt(overrides: Partial<FocusSessionLaunch> = {}): FocusSessionLaunch {
  return {
    id: "receipt-1", objectId: "decision-1", activationId: "activation-1", source: "launch_prompt",
    objectType: "decision", objectTitle: "Should we roll back the release?", status: "ready",
    taskId: "task-1", taskTitle: "Bridge task", prompt: "Review this concern", promptFingerprint: "launch-fingerprint",
    creationOptions: {}, expectedSessionId: "receipt-1", sessionId: "receipt-1", promptStatus: "sent",
    creationDispatchedAt: FOCUS_TEST_NOW, linkedAt: FOCUS_TEST_NOW, promptDispatchedAt: FOCUS_TEST_NOW,
    error: null, errorStage: null, version: 4, createdAt: FOCUS_TEST_NOW, updatedAt: FOCUS_TEST_NOW, ...overrides,
  };
}

export function focusOverdueHandoff(overrides: Partial<FocusOverdueHandoffSummary> = {}): FocusOverdueHandoffSummary {
  return {
    objectId: "handoff-1", objectType: "decision", activationId: "handoff-episode", title: "Unresolved handoff",
    lifecycle: "handed_off", interventionBy: "2026-09-05T17:00:00.000Z", attentionVisible: true,
    taskId: "task-1", taskTitle: "Bridge task", taskState: "active", originalTaskId: "task-1",
    originalTaskTitle: "Bridge task", orphanedAt: null, sourceFamily: "release-watch", producer: "release-monitor",
    sessionId: null, updatedAt: FOCUS_TEST_NOW, ...overrides,
  };
}

export function focusQuietConcern(overrides: Partial<FocusQuietConcernSummary> = {}): FocusQuietConcernSummary {
  return {
    ...focusOverdueHandoff(), objectId: "quiet-decision", title: "Suppressed decision", lifecycle: "active",
    interventionBy: null, attentionVisible: false, taskState: "muted", suppressionReason: "muted", ...overrides,
  };
}
