import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  FocusAttentionEvent, FocusAttentionMetrics, FocusAuthorityMutation, FocusCoverageMutation,
  FocusEpisodeRead, FocusHistoryFilter, FocusHistoryPage, FocusLifecycleMutation,
  FocusNotificationDelivery, FocusNotificationPolicy, FocusNotificationPolicyUpdate,
  FocusObjectMutation, FocusQuietConcern, FocusQuietConcernFilter, FocusTransition,
} from "./api";
import {
  FOCUS_TEST_NOW, FOCUS_TEST_NOW_MS, focusAction, focusAlert, focusAudit, focusCoverage,
  focusDecision, focusDetails, focusDigest, focusEpisode, focusEvent, focusGrant,
  focusOverdueHandoff, focusQuietConcern, focusSnapshot,
} from "./test-focus-fixtures";

type RecordedRequest = { url: string; method: string; body?: unknown };
let api: typeof import("./api");

function mockResponses(...responses: Response[]): RecordedRequest[] {
  const requests: RecordedRequest[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/telemetry/batch")) return Response.json({});
    requests.push({
      url,
      method: init?.method ?? "GET",
      ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}),
    });
    const response = responses.shift();
    if (!response) throw new Error(`Unexpected request: ${url}`);
    return response;
  }));
  return requests;
}

function retainedEpisodeRead(overrides: Partial<FocusEpisodeRead> = {}): FocusEpisodeRead {
  const objectId = overrides.objectId ?? "decision-1";
  const activationId = overrides.activationId ?? "activation-1";
  const previousEpisode = focusEpisode({
    objectId, activationId, sourceFamily: "release:watch/api",
    lifecycle: "resolved", taskId: "prior-task", taskTitle: "Prior release task",
    originalTaskId: "prior-task", originalTaskTitle: "Prior release task",
    outcome: "The prior release was restored.", resolutionReason: "Rollback verified", resolvedAt: FOCUS_TEST_NOW,
    sessionId: "prior-session", sessionIds: ["prior-session", "earlier-session"],
    linkedActionIds: ["prior-action"],
    linkedActions: [{
      sourceId: objectId, sourceType: "decision", activationId,
      actionId: "prior-action", createdAt: FOCUS_TEST_NOW,
    }],
  });
  const currentObject = focusDecision({
    id: objectId, activationId: "activation-2", taskId: "current-task", taskTitle: "Current release task",
    details: focusDetails({ objectId, originalTaskId: "current-task", originalTaskTitle: "Current release task" }),
  });
  const transition: FocusTransition = {
    id: "reactivation-2", objectId: currentObject.id, objectType: "decision", title: currentObject.title,
    activationId: currentObject.activationId, fromLifecycle: "resolved", toLifecycle: "active",
    reason: "A different release needs review", actor: "agent", relatedActionId: null, sessionId: null,
    details: { previousEpisode }, createdAt: FOCUS_TEST_NOW,
  };
  return {
    objectId: currentObject.id, activationId: previousEpisode.activationId, currentObject,
    isCurrentEpisode: false, previousEpisode, transitions: [transition], transitionTotal: 1,
    nextOffset: null, deleted: false, quarantined: false, historyIncomplete: false, ...overrides,
  };
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(FOCUS_TEST_NOW_MS);
  vi.stubEnv("BASE_URL", "/");
  mockResponses();
  api = await import("./api");
});

afterEach(async () => {
  try {
    await vi.runOnlyPendingTimersAsync();
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
  }
});

describe("first-class Focus API client", () => {
  it.each([
    { type: "decision", object: focusDecision(), created: true },
    { type: "alert", object: focusAlert(), created: true },
    { type: "event", object: focusEvent(), created: false },
  ] as const)("reads, saves, and patches rich $type contracts without flattening details", async ({ type, object, created }) => {
    const input: FocusObjectMutation = {
      key: "release-watch:rich", title: object.title, body: "**Verified** evidence", priority: "high",
      taskId: null, sessionId: null, url: null, links: [{ label: "Evidence", url: "https://example.test/check" }],
      metadata: { attempts: 0, automatic: false }, launchPrompt: { prompt: "Compare the evidence", taskId: null },
      pinned: false, lifecycle: "active", sourceFamily: "release-watch", producer: "release-monitor",
      observedAt: FOCUS_TEST_NOW, validUntil: "2026-09-06T18:00:00.000Z",
      interventionBy: "2026-09-05T20:00:00.000Z",
      evidence: ["Health check failed", { summary: "Trace", url: "https://example.test/trace", observedAt: FOCUS_TEST_NOW }],
      impact: "Release unavailable", consequenceOfDelay: "Rollback window closes",
      alternatives: ["Roll back", "Repair"], recommendation: "Roll back", fallback: "Keep prior release",
      outcome: null, resolutionReason: null, notificationMode: "focus", authorizationGrantId: null,
      episodeReason: null, recurring: false, ...(type === "event" ? { category: "observation" } : {}),
    };
    const linked = { actionId: "action-1", activationId: object.activationId, createdAt: FOCUS_TEST_NOW, action: focusAction() };
    const responseObject = {
      ...object,
      taskId: null,
      taskState: "global",
      taskTitle: null,
      launchPrompt: input.launchPrompt,
      details: { ...object.details, evidence: input.evidence },
      linkedActions: [linked],
    };
    const updates: FocusObjectMutation = {
      body: null, metadata: null, launchPrompt: null, pinned: false,
      expectedActivationId: object.activationId, evidence: input.evidence,
    };
    const patched = { ...responseObject, body: null, metadata: null, launchPrompt: null, pinned: false };
    const id = `${type} /?#`;
    const url = `/api/focus/${type}s/${encodeURIComponent(id)}`;
    const requests = mockResponses(
      Response.json({ [type]: responseObject }),
      Response.json({ created, [type]: responseObject }),
      Response.json({ [type]: patched }),
    );

    await expect(api.fetchFocusObject(type, id)).resolves.toEqual(responseObject);
    await expect(api.saveFocusObject(type, input)).resolves.toEqual({ created, object: responseObject });
    await expect(api.patchFocusObject(type, id, updates)).resolves.toEqual(patched);
    expect(requests).toEqual([
      { method: "GET", url },
      { method: "POST", url: `/api/focus/${type}s`, body: input },
      { method: "PATCH", url, body: updates },
    ]);
    expect(vi.mocked(fetch).mock.calls[1]?.[1]?.headers).toEqual({ "Content-Type": "application/json" });
  });

  it("preserves canonical paging and legacy status filters with rich page results", async () => {
    const decisions = { objects: [focusDecision()], total: 31, nextOffset: 30 };
    const alerts = { objects: [focusAlert({ status: "dismissed", lifecycle: "dismissed", details: focusDetails({ lifecycle: "dismissed" }) })], total: 1, nextOffset: null };
    const cleared = { objects: [focusEvent({ status: "done", lifecycle: "resolved", details: focusDetails({ lifecycle: "resolved" }) })], total: 41, nextOffset: null };
    const requests = mockResponses(Response.json(decisions), Response.json(alerts), Response.json(cleared));

    await expect(api.fetchFocusDecisionPage(20, 10)).resolves.toEqual(decisions);
    await expect(api.fetchFocusAlertPage(0, 20, "dismissed")).resolves.toEqual(alerts);
    await expect(api.fetchFocusClearedPage(40, 20)).resolves.toEqual(cleared);
    expect(requests).toEqual([
      { method: "GET", url: "/api/focus/decisions?offset=20&limit=10&status=active" },
      { method: "GET", url: "/api/focus/alerts?offset=0&limit=20&status=dismissed" },
      { method: "GET", url: "/api/focus/cleared?offset=40&limit=20" },
    ]);
  });

  it("serializes lifecycle, task, and explicit all=false object filters", async () => {
    const page = { objects: [], total: 0, nextOffset: null };
    const requests = mockResponses(Response.json(page), Response.json(page), Response.json(page));
    await api.fetchFocusDecisionPage(4, 8, { lifecycle: "acknowledged", taskId: "task /1", all: false });
    await api.fetchFocusAlertPage(0, 10, { status: "active", lifecycle: "handed_off", all: true });
    await api.fetchFocusEventPage(5, 15, { status: "done", lifecycle: "resolved", taskId: "task 1" });
    expect(requests.map(({ url }) => url)).toEqual([
      "/api/focus/decisions?offset=4&limit=8&lifecycle=acknowledged&taskId=task+%2F1&all=false",
      "/api/focus/alerts?offset=0&limit=10&status=active&lifecycle=handed_off&all=true",
      "/api/focus/events?offset=5&limit=15&status=done&lifecycle=resolved&taskId=task+1",
    ]);
  });

  it("retains degraded concern domain health and null totals rather than implying all-clear", async () => {
    const snapshot = focusSnapshot({
      allClear: false, alertTotal: null, attentionTotal: null, compatibilityErrorCount: null,
      overdueHandoffTotal: null, quietConcernTotal: null,
      digests: [focusDigest()],
      quietDigests: [focusDigest({ id: "orphaned", taskId: null, orphaned: true, quiet: true })],
      auditExceptions: [focusAudit()],
    });
    snapshot.domainHealth.alerts = { status: "error", error: "Alert storage unavailable" };
    snapshot.domainHealth.overdueHandoffs = { status: "error", error: "Handoff retrieval unavailable" };
    snapshot.domainHealth.quietConcerns = { status: "unknown" };
    snapshot.domainHealth.compatibility = { status: "unknown" };
    const requests = mockResponses(Response.json(snapshot));
    await expect(api.fetchFocusSnapshot()).resolves.toEqual(snapshot);
    expect(requests).toEqual([{ method: "GET", url: "/api/focus" }]);
  });

  it("retains overdue handoffs and suppressed concerns with their distinct attention and task identities", async () => {
    const snapshot = focusSnapshot({
      allClear: false, handedOffTotal: 3, overdueHandoffTotal: 1, quietConcernTotal: 3,
      overdueHandoffs: [focusOverdueHandoff()],
      quietConcerns: [
        focusQuietConcern(),
        focusQuietConcern({ objectId: "archived-alert", objectType: "alert", taskState: "archived", suppressionReason: "archived" }),
        focusQuietConcern({
          objectId: "orphaned-decision", taskId: null, taskState: "orphaned", originalTaskId: "deleted-task",
          taskTitle: "Deleted release task", originalTaskTitle: "Deleted release task",
          orphanedAt: FOCUS_TEST_NOW, suppressionReason: "orphaned",
        }),
      ],
    });
    const requests = mockResponses(Response.json(snapshot));
    await expect(api.fetchFocusSnapshot()).resolves.toEqual(snapshot);
    expect(requests).toEqual([{ method: "GET", url: "/api/focus" }]);
  });

  it.each([
    {
      filter: { taskId: "task 1", keyPrefix: "source:" },
      query: "taskId=task+1&keyPrefix=source%3A",
    },
    {
      filter: { taskId: null, category: "release note", sourceFamily: "release:watch/api", orphanedTaskId: "deleted task" },
      query: "category=release+note&sourceFamily=release%3Awatch%2Fapi&orphanedTaskId=deleted+task",
    },
    {
      filter: { taskId: null, keyPrefix: null, category: null, sourceFamily: null, orphanedTaskId: null },
      query: "",
    },
  ])("serializes digest scope without inventing a Global task identity: $query", async ({ filter, query }) => {
    const page = { objects: [focusEvent()], total: 30, nextOffset: 20 };
    const requests = mockResponses(Response.json(page));
    await expect(api.fetchFocusEventDigestPage(filter, 10, 10)).resolves.toEqual(page);
    expect(requests).toEqual([{
      method: "GET",
      url: `/api/focus/events/digest-items?offset=10&limit=10${query ? `&${query}` : ""}`,
    }]);
  });

  it("marks a digest viewed using its exact identity and the rendered observation time", async () => {
    const digestId = focusDigest().id;
    const view = { digestId, lastViewedAt: FOCUS_TEST_NOW };
    const requests = mockResponses(Response.json({ view }));
    await expect(api.markFocusDigestViewed(digestId, FOCUS_TEST_NOW)).resolves.toEqual(view);
    expect(requests).toEqual([{
      method: "POST", url: "/api/focus/digests/viewed", body: { digestId, viewedAt: FOCUS_TEST_NOW },
    }]);
  });
});

describe("Focus lifecycle and accepted work", () => {
  it.each(["acknowledged", "handed_off", "resolved", "accepted_risk", "dismissed"] as const)(
    "sends activation guards and reasons for %s without implying Action completion",
    async (lifecycle) => {
      const input: FocusLifecycleMutation = {
        lifecycle, expectedActivationId: "activation-1", lifecycleReason: "Reviewed the current evidence",
        outcome: "The next step is recorded",
      };
      const object = focusDecision({
        lifecycle,
        status: lifecycle === "dismissed" ? "dismissed" : lifecycle === "resolved" || lifecycle === "accepted_risk" ? "done" : "active",
        details: focusDetails({ lifecycle, outcome: input.outcome, resolutionReason: input.lifecycleReason }),
      });
      const requests = mockResponses(Response.json({ decision: object }));
      await expect(api.transitionFocusObject("decision", object.id, input)).resolves.toEqual(object);
      expect(requests).toEqual([{ method: "PATCH", url: "/api/focus/decisions/decision-1", body: input }]);
      expect(requests[0]?.body).not.toHaveProperty("done");
    },
  );

  it("keeps reasoned legacy status patches on the canonical endpoint", async () => {
    const object = focusDecision({ status: "dismissed", lifecycle: "dismissed" });
    const input = { status: "dismissed", lifecycleReason: "Not needed", expectedActivationId: object.activationId } as const;
    const requests = mockResponses(Response.json({ decision: object }));
    await expect(api.patchFocusObject("decision", object.id, input)).resolves.toEqual(object);
    expect(requests).toEqual([{ method: "PATCH", url: "/api/focus/decisions/decision-1", body: input }]);
  });

  it("reactivates as a new episode and returns the replacement activation ID", async () => {
    const object = focusAlert({ activationId: "activation-2", details: focusDetails({ episodeReason: "New outage verified" }) });
    const input = { episodeReason: "New outage verified", expectedActivationId: "activation-1" };
    const requests = mockResponses(Response.json({ alert: object }));
    await expect(api.reactivateFocusObject("alert", object.id, input)).resolves.toEqual(object);
    expect(requests).toEqual([{
      method: "PATCH", url: "/api/focus/alerts/alert-1",
      body: { ...input, lifecycle: "active", newEpisode: true },
    }]);
  });

  it.each([
    { type: "decision", taskId: "destination-task", created: true },
    { type: "alert", taskId: null, created: true },
    { type: "event", taskId: "new-destination", created: false },
  ] as const)("promotes $type to its explicit destination, preserving created=$created", async ({ type, taskId, created }) => {
    const source = type === "decision" ? focusDecision() : type === "alert" ? focusAlert() : focusEvent();
    const action = focusAction({
      taskId,
      sources: [{ sourceId: source.id, sourceType: type, activationId: source.activationId, title: source.title, lifecycle: "handed_off" }],
    });
    const result = {
      created,
      object: {
        ...source, lifecycle: "handed_off", details: { ...source.details, lifecycle: "handed_off", handedOffAt: FOCUS_TEST_NOW },
        linkedActions: [{ actionId: action.id, activationId: source.activationId, createdAt: FOCUS_TEST_NOW, action }],
      },
      action,
    };
    const input = { text: "Carry out the accepted work", taskId, expectedActivationId: source.activationId };
    const requests = mockResponses(Response.json(result));
    await expect(api.promoteFocusObjectToAction(type, source.id, input)).resolves.toEqual(result);
    expect(requests).toEqual([{
      method: "POST", url: `/api/focus/${type}s/${source.id}/make-action`, body: input,
    }]);
    expect(requests[0]?.body).toHaveProperty("taskId", taskId);
    expect(result.action.done).toBe(false);
  });

  it.each(["decision", "alert", "event"] as const)("links a %s session without sending status=done", async (type) => {
    const source = type === "decision" ? focusDecision() : type === "alert" ? focusAlert() : focusEvent();
    const object = {
      ...source, sessionId: "session-1", lifecycle: "acknowledged", status: "active",
      details: { ...source.details, lifecycle: "acknowledged", acknowledgedAt: FOCUS_TEST_NOW },
    };
    const input = { sessionId: "session-1", expectedActivationId: source.activationId };
    const requests = mockResponses(Response.json({ object }));
    await expect(api.linkFocusObjectSession(type, source.id, input)).resolves.toEqual(object);
    expect(requests).toEqual([{ method: "POST", url: `/api/focus/${type}s/${source.id}/link-session`, body: input }]);
    expect(requests[0]?.body).not.toHaveProperty("status");
    expect(requests[0]?.body).not.toHaveProperty("lifecycle");
    expect(requests[0]?.body).not.toHaveProperty("done");
  });
});

describe("Focus authority, coverage, and audits", () => {
  it("lists, saves, patches, and revokes authority with explicit null/false values and a reason", async () => {
    const grant = focusGrant();
    const input: FocusAuthorityMutation = {
      key: "release-monitor", title: grant.title, taskId: null, sourceFamily: grant.sourceFamily,
      producer: grant.producer, scope: grant.scope, validFrom: grant.validFrom, validUntil: grant.validUntil,
      allowImmediate: false, allowQuietHoursOverride: false, constraints: grant.constraints, grantedBy: "Tim",
    };
    const updates = { allowImmediate: false, allowQuietHoursOverride: false, taskId: null, constraints: [] };
    const revoked = focusGrant({ status: "revoked", revokedAt: FOCUS_TEST_NOW, revokeReason: "Permission withdrawn" });
    const requests = mockResponses(
      Response.json({ grants: [grant] }), Response.json({ grant }), Response.json({ grant }),
      Response.json({ grant: revoked }),
    );
    await expect(api.fetchFocusAuthorityPage(50, 25, "active")).resolves.toEqual([grant]);
    await expect(api.saveFocusAuthorityGrant(input)).resolves.toEqual(grant);
    await expect(api.patchFocusAuthorityGrant("grant /1", updates)).resolves.toEqual(grant);
    await expect(api.revokeFocusAuthorityGrant("grant /1", "Permission withdrawn")).resolves.toEqual(revoked);
    expect(requests).toEqual([
      { method: "GET", url: "/api/focus/authority?offset=50&limit=25&status=active" },
      { method: "POST", url: "/api/focus/authority", body: input },
      { method: "PATCH", url: "/api/focus/authority/grant%20%2F1", body: updates },
      { method: "POST", url: "/api/focus/authority/grant%20%2F1/revoke", body: { reason: "Permission withdrawn" } },
    ]);
  });

  it("preserves computed coverage alongside its assertion and serializes nullable clears", async () => {
    const assertion = focusCoverage({ state: "at-risk", observationGap: "Last observation overdue", constrainedAutonomy: ["Grant expired"] });
    const summary = focusSnapshot().coverage.summary!;
    const page = { assertions: [assertion], summary };
    const input: FocusCoverageMutation = {
      key: "release-health", title: assertion.title, taskId: null, sourceFamily: assertion.sourceFamily,
      producer: assertion.producer, scope: assertion.scope, explicitState: "valid", lastCheckedAt: FOCUS_TEST_NOW,
      validUntil: assertion.validUntil, interventionBy: null, expectedIntervalMinutes: 60, atRiskMinutes: 0,
      evidence: assertion.evidence, reason: null, authorityGrantId: null,
    };
    const updates = { explicitState: "unknown", reason: "No recent observation", authorityGrantId: null, validUntil: null } as const;
    const requests = mockResponses(
      Response.json(page), Response.json({ assertion }), Response.json({ assertion }), new Response(null, { status: 204 }),
    );
    await expect(api.fetchFocusCoveragePage(25, 25)).resolves.toEqual(page);
    await expect(api.saveFocusCoverageAssertion(input)).resolves.toEqual(assertion);
    await expect(api.patchFocusCoverageAssertion("coverage /1", updates)).resolves.toEqual(assertion);
    await expect(api.deleteFocusCoverageAssertion("coverage /1")).resolves.toBeUndefined();
    expect(requests).toEqual([
      { method: "GET", url: "/api/focus/coverage?offset=25&limit=25" },
      { method: "POST", url: "/api/focus/coverage", body: input },
      { method: "PATCH", url: "/api/focus/coverage/coverage%20%2F1", body: updates },
      { method: "DELETE", url: "/api/focus/coverage/coverage%20%2F1" },
    ]);
  });

  it("lists and records audits, resolving them only with an explicit outcome", async () => {
    const audit = focusAudit();
    const input = { objectId: null, title: audit.title, category: audit.category, severity: audit.severity, notes: audit.notes, outcome: null };
    const updates = { status: "resolved", outcome: "Classification corrected" } as const;
    const resolved = focusAudit({ ...updates, resolvedAt: FOCUS_TEST_NOW });
    const requests = mockResponses(Response.json({ audits: [audit] }), Response.json({ audit }), Response.json({ audit: resolved }));
    await expect(api.fetchFocusAuditPage(10, 10, "open")).resolves.toEqual([audit]);
    await expect(api.saveFocusAudit(input)).resolves.toEqual(audit);
    await expect(api.patchFocusAudit("audit /1", updates)).resolves.toEqual(resolved);
    expect(requests).toEqual([
      { method: "GET", url: "/api/focus/audits?offset=10&limit=10&status=open" },
      { method: "POST", url: "/api/focus/audits", body: input },
      { method: "PATCH", url: "/api/focus/audits/audit%20%2F1", body: updates },
    ]);
  });
});

describe("Focus history and attention telemetry", () => {
  it("retains Action history, deleted entries, transition provenance, and pagination", async () => {
    const transition: FocusTransition = {
      id: "transition-1", objectId: "action /1", objectType: "action", title: "Accepted work",
      activationId: "activation-1", fromLifecycle: "active", toLifecycle: "resolved", reason: "Work verified",
      actor: "user", relatedActionId: "action-1", sessionId: "session-1",
      details: { sourceId: "decision-1", previousTaskId: "old-task", taskId: null }, createdAt: FOCUS_TEST_NOW,
    };
    const history: FocusHistoryPage = {
      objects: [{
        id: "action /1", objectType: "action", title: "Accepted work", updatedAt: FOCUS_TEST_NOW,
        object: focusAction(), deleted: false, quarantined: false, transitions: [transition], transitionTotal: 101,
        matchSource: "current", matchedEpisode: null, matchedTransition: null,
      }, {
        id: "deleted-decision", objectType: "decision", title: "Deleted concern", updatedAt: FOCUS_TEST_NOW,
        object: null, deleted: true, quarantined: false, transitions: [], transitionTotal: 1,
        matchSource: "transition", matchedEpisode: null,
        matchedTransition: {
          ...transition, id: "deleted-transition", objectId: "deleted-decision", objectType: "decision",
          title: "Deleted concern", toLifecycle: null, reason: "Deleted from Focus", relatedActionId: null, details: {},
        },
      }],
      total: 42, nextOffset: 40,
    };
    const requests = mockResponses(Response.json(history), Response.json({ transitions: [transition] }));
    await expect(api.fetchFocusHistoryPage(20, 20, { objectId: "action /1", objectType: "action" })).resolves.toEqual(history);
    await expect(api.fetchFocusTransitionPage("action /1", 100, 100)).resolves.toEqual([transition]);
    expect(requests).toEqual([
      { method: "GET", url: "/api/focus/history?offset=20&limit=20&objectId=action+%2F1&objectType=action" },
      { method: "GET", url: "/api/focus/history/action%20%2F1/transitions?offset=100&limit=100" },
    ]);
  });

  it("retains a prior-episode History match without replacing it with the current object", async () => {
    const episode = retainedEpisodeRead({ objectId: "decision /?#" });
    const filter: FocusHistoryFilter = {
      query: "  rollback  ", taskId: " prior-task ", originalTaskId: " prior-task ",
      lifecycle: "resolved", sourceFamily: " release:watch/api ", activationId: " activation-1 ",
      objectId: " decision /?# ", objectType: "decision",
    };
    const history: FocusHistoryPage = {
      objects: [{
        id: episode.objectId, objectType: "decision", title: episode.currentObject!.title, updatedAt: FOCUS_TEST_NOW,
        object: episode.currentObject, deleted: false, quarantined: false,
        transitions: episode.transitions, transitionTotal: 51, matchSource: "previous_episode",
        matchedEpisode: episode.previousEpisode, matchedTransition: episode.transitions[0]!,
      }],
      total: 21, nextOffset: 20,
    };
    const requests = mockResponses(Response.json(history));
    await expect(api.fetchFocusHistoryPage(19, 1, filter)).resolves.toEqual(history);
    expect(requests).toEqual([{
      method: "GET",
      url: "/api/focus/history?offset=19&limit=1&query=rollback&taskId=prior-task&originalTaskId=prior-task&lifecycle=resolved&sourceFamily=release%3Awatch%2Fapi&activationId=activation-1&objectId=decision+%2F%3F%23&objectType=decision",
    }]);
    expect(filter.query).toBe("  rollback  ");
  });

  it("reads quiet concerns with exact trimmed filters and retains suppression provenance", async () => {
    const concern: FocusQuietConcern = {
      ...focusAlert({
        title: "Health /?#", activationId: "activation /1", taskId: "current task", taskState: "muted",
        details: focusDetails({
          objectId: "alert-1", sourceFamily: "release:watch/api",
          originalTaskId: "deleted task /1", originalTaskTitle: "Deleted release task",
        }),
      }),
      attentionVisible: false, suppressionReason: "muted",
    };
    const page = { objects: [concern], total: 22, nextOffset: 21 };
    const filter: FocusQuietConcernFilter = {
      query: "  health /?#  ", taskId: " current task ", originalTaskId: " deleted task /1 ",
      lifecycle: "active", sourceFamily: " release:watch/api ", activationId: " activation /1 ", objectType: "alert",
    };
    const requests = mockResponses(Response.json(page));
    await expect(api.fetchFocusQuietConcernPage(20, 1, filter)).resolves.toEqual(page);
    expect(requests).toEqual([{
      method: "GET",
      url: "/api/focus/quiet-concerns?offset=20&limit=1&query=health+%2F%3F%23&taskId=current+task&originalTaskId=deleted+task+%2F1&lifecycle=active&sourceFamily=release%3Awatch%2Fapi&activationId=activation+%2F1&objectType=alert",
    }]);
    expect(filter.originalTaskId).toBe(" deleted task /1 ");
  });

  it.each(["archived", "orphaned"] as const)("keeps %s quiet concerns attached to their original task scope", async (taskState) => {
    const concern: FocusQuietConcern = {
      ...focusDecision({
        taskState, taskId: taskState === "orphaned" ? null : "task-1",
        details: focusDetails({ orphanedAt: taskState === "orphaned" ? FOCUS_TEST_NOW : null }),
      }),
      attentionVisible: false, suppressionReason: taskState,
    };
    const page = { objects: [concern], total: 1, nextOffset: null };
    const requests = mockResponses(Response.json(page));
    await expect(api.fetchFocusQuietConcernPage(0, 20, { originalTaskId: "task-1" })).resolves.toEqual(page);
    expect(requests).toEqual([{
      method: "GET", url: "/api/focus/quiet-concerns?offset=0&limit=20&originalTaskId=task-1",
    }]);
  });

  it("omits blank and undefined History and quiet-concern filters without inventing Global scope", async () => {
    const filter = { query: "  ", taskId: "", originalTaskId: undefined, sourceFamily: "\t", activationId: undefined };
    const page = { objects: [], total: 0, nextOffset: null };
    const requests = mockResponses(Response.json(page), Response.json(page));
    await expect(api.fetchFocusHistoryPage(0, 20, filter)).resolves.toEqual(page);
    await expect(api.fetchFocusQuietConcernPage(0, 20, filter)).resolves.toEqual(page);
    expect(requests).toEqual([
      { method: "GET", url: "/api/focus/history?offset=0&limit=20" },
      { method: "GET", url: "/api/focus/quiet-concerns?offset=0&limit=20" },
    ]);
  });

  it("reads encoded episode identities and preserves the retained evidence, work links, and pagination", async () => {
    const episode = retainedEpisodeRead({
      objectId: "decision /?#", activationId: "activation /?#", transitionTotal: 52, nextOffset: 51,
    });
    const requests = mockResponses(Response.json(episode));
    await expect(api.fetchFocusEpisodePage(episode.objectId, episode.activationId, 50, 1)).resolves.toEqual(episode);
    expect(requests).toEqual([{
      method: "GET", url: "/api/focus/objects/decision%20%2F%3F%23/episodes/activation%20%2F%3F%23?offset=50&limit=1",
    }]);
  });

  it.each(["deleted", "quarantined", "incomplete"] as const)(
    "preserves %s episode history instead of substituting a current object",
    async (state) => {
      const episode = retainedEpisodeRead({
        currentObject: null, deleted: state !== "quarantined", quarantined: state === "quarantined",
        historyIncomplete: state === "incomplete",
      });
      if (state === "incomplete") {
        episode.previousEpisode = null;
        episode.transitions = episode.transitions.map((entry) => ({ ...entry, activationId: episode.activationId, details: {} }));
      }
      const requests = mockResponses(Response.json(episode));
      await expect(api.fetchFocusEpisodePage(episode.objectId, episode.activationId)).resolves.toEqual(episode);
      expect(requests).toEqual([{
        method: "GET", url: "/api/focus/objects/decision-1/episodes/activation-1?offset=0&limit=50",
      }]);
    },
  );

  it("retains a current episode with no previous snapshot", async () => {
    const object = focusDecision();
    const episode: FocusEpisodeRead = {
      objectId: object.id, activationId: object.activationId, currentObject: object, isCurrentEpisode: true,
      previousEpisode: null, transitions: [], transitionTotal: 0, nextOffset: null,
      deleted: false, quarantined: false, historyIncomplete: false,
    };
    const requests = mockResponses(Response.json(episode));
    await expect(api.fetchFocusEpisodePage(object.id, object.activationId)).resolves.toEqual(episode);
    expect(requests).toHaveLength(1);
  });

  it("keeps a missing episode as a 404 without falling back to the latest object", async () => {
    const requests = mockResponses(Response.json({ error: "Focus episode missing for decision-1 not found" }, { status: 404 }));
    await expect(api.fetchFocusEpisodePage("decision-1", "missing")).rejects.toMatchObject({
      name: "ApiError", status: 404, message: "Focus episode missing for decision-1 not found",
    });
    expect(requests).toEqual([{
      method: "GET", url: "/api/focus/objects/decision-1/episodes/missing?offset=0&limit=50",
    }]);
  });

  it("uses the staging API base for History, quiet concerns, and direct episode reads", async () => {
    vi.stubEnv("BASE_URL", "/staging/focus-preview///");
    vi.resetModules();
    api = await import("./api");
    const page = { objects: [], total: 0, nextOffset: null };
    const requests = mockResponses(Response.json(page), Response.json(page), Response.json(retainedEpisodeRead()));
    await api.fetchFocusHistoryPage(0, 20, { activationId: "episode /?#" });
    await api.fetchFocusQuietConcernPage();
    await api.fetchFocusEpisodePage("decision /?#", "episode /?#");
    expect(requests).toEqual([
      { method: "GET", url: "/staging/focus-preview/api/focus/history?offset=0&limit=20&activationId=episode+%2F%3F%23" },
      { method: "GET", url: "/staging/focus-preview/api/focus/quiet-concerns?offset=0&limit=20" },
      { method: "GET", url: "/staging/focus-preview/api/focus/objects/decision%20%2F%3F%23/episodes/episode%20%2F%3F%23?offset=0&limit=50" },
    ]);
  });

  it("retains counts, suppression reasons, attention provenance, and delivery outcomes", async () => {
    const metrics: FocusAttentionMetrics = {
      since: "2026-08-29T18:00:00.000Z", until: FOCUS_TEST_NOW, days: 7,
      counts: { create: 2, no_op: 0, global_leakage_prevented: 1, digest_viewed: 1 },
      total: 4, noOpRate: null,
      notifications: [{ status: "suppressed", suppressionReason: "quiet-hours", count: 2 }],
      audits: [{ category: "missed_attention", status: "open", count: 1 }],
    };
    const event: FocusAttentionEvent = {
      id: "attention-1", eventType: "notification_suppression", objectId: "alert /1", objectType: "alert",
      activationId: "activation-1", transitionId: "transition-1", actor: "system", reason: "quiet-hours",
      details: { authorized: false, pendingUntil: null }, createdAt: FOCUS_TEST_NOW,
    };
    const delivery: FocusNotificationDelivery = {
      id: "delivery-1", objectId: "alert /1", activationId: "activation-1", transitionId: "transition-1",
      reason: "intervention-required", status: "suppressed", suppressionReason: "quiet-hours",
      resolvedGrantId: "grant-1", pendingUntil: null, claimToken: null, claimedAt: null, sentAt: null,
      error: null, outcomeJson: '{"sent":0}', createdAt: FOCUS_TEST_NOW, updatedAt: FOCUS_TEST_NOW,
    };
    const requests = mockResponses(
      Response.json(metrics), Response.json({ events: [event] }), Response.json({ deliveries: [delivery] }),
    );
    await expect(api.fetchFocusAttentionMetrics(7)).resolves.toEqual(metrics);
    await expect(api.fetchFocusAttentionEvents("alert /1", 100)).resolves.toEqual([event]);
    await expect(api.fetchFocusNotificationDeliveries(100)).resolves.toEqual([delivery]);
    expect(requests).toEqual([
      { method: "GET", url: "/api/focus/metrics?days=7" },
      { method: "GET", url: "/api/focus/attention-events?limit=100&objectId=alert+%2F1" },
      { method: "GET", url: "/api/focus/notification-deliveries?limit=100" },
    ]);
  });

  it("uses read defaults without serializing undefined filters", async () => {
    const requests = mockResponses(
      Response.json({ grants: [] }), Response.json({ assertions: [], summary: focusSnapshot().coverage.summary }),
      Response.json({ audits: [] }), Response.json({ objects: [], total: 0, nextOffset: null }),
      Response.json({ transitions: [] }), Response.json({ events: [] }), Response.json({ deliveries: [] }),
    );
    await api.fetchFocusAuthorityPage();
    await api.fetchFocusCoveragePage();
    await api.fetchFocusAuditPage();
    await api.fetchFocusHistoryPage();
    await api.fetchFocusTransitionPage("decision-1");
    await api.fetchFocusAttentionEvents();
    await api.fetchFocusNotificationDeliveries();
    expect(requests.map(({ url }) => url)).toEqual([
      "/api/focus/authority?offset=0&limit=50",
      "/api/focus/coverage?offset=0&limit=50",
      "/api/focus/audits?offset=0&limit=50",
      "/api/focus/history?offset=0&limit=20",
      "/api/focus/history/decision-1/transitions?offset=0&limit=100",
      "/api/focus/attention-events?limit=50",
      "/api/focus/notification-deliveries?limit=50",
    ]);
  });
});

describe("Focus rejection and response parsing", () => {
  it.each(["transition", "reactivation", "promotion", "link-session"] as const)(
    "rejects a stale %s with the server's 400 error and details",
    async (operation) => {
      const message = "Focus activation changed; reload before mutating";
      const details = { expectedActivationId: "activation-1", currentActivationId: "activation-2" };
      const requests = mockResponses(Response.json({ error: message, details }, { status: 400 }));
      const calls = {
        transition: () => api.transitionFocusObject("decision", "decision-1", { lifecycle: "acknowledged", expectedActivationId: "activation-1" }),
        reactivation: () => api.reactivateFocusObject("decision", "decision-1", { episodeReason: "New evidence", expectedActivationId: "activation-1" }),
        promotion: () => api.promoteFocusObjectToAction("decision", "decision-1", { text: "Accepted work", taskId: null, expectedActivationId: "activation-1" }),
        "link-session": () => api.linkFocusObjectSession("decision", "decision-1", { sessionId: "session-1", expectedActivationId: "activation-1" }),
      };
      await expect(calls[operation]()).rejects.toMatchObject({ name: "ApiError", status: 400, message, details });
      expect(requests).toHaveLength(1);
      expect(requests[0]?.body).toHaveProperty("expectedActivationId", "activation-1");
    },
  );

  it.each([
    { name: "reasonless clearing", run: () => api.patchFocusObject("decision", "decision-1", { status: "dismissed" }), error: "Clearing a concern requires lifecycleReason, resolutionReason or outcome" },
    { name: "reasonless reactivation", run: () => api.reactivateFocusObject("alert", "alert-1", { expectedActivationId: "activation-1", episodeReason: "" }), error: "Reactivation requires newEpisode: true and a non-empty episodeReason" },
    { name: "hidden promotion destination", run: () => api.promoteFocusObjectToAction("event", "event-1", { text: "Work", taskId: "muted-task", expectedActivationId: "activation-1" }), error: "Promotion destination must be an active, unmuted task" },
    { name: "audit closure without outcome", run: () => api.patchFocusAudit("audit-1", { status: "resolved" }), error: "Closing an audit requires an outcome" },
    { name: "out-of-range metrics", run: () => api.fetchFocusAttentionMetrics(91), error: "days must be between 1 and 90" },
  ])("does not turn rejected $name into success", async ({ run, error }) => {
    const requests = mockResponses(Response.json({ error }, { status: 400 }));
    await expect(run()).rejects.toMatchObject({ name: "ApiError", message: error, status: 400 });
    expect(requests).toHaveLength(1);
  });

  it.each(["object", "coverage"] as const)("rejects a failed %s DELETE instead of reporting removal", async (kind) => {
    const requests = mockResponses(Response.json({ error: "Not found", details: { id: "missing /1" } }, { status: 404 }));
    const result = kind === "object" ? api.deleteFocusObject("event", "missing /1") : api.deleteFocusCoverageAssertion("missing /1");
    await expect(result).rejects.toMatchObject({ name: "ApiError", status: 404, message: "Not found", details: { id: "missing /1" } });
    expect(requests).toEqual([{
      method: "DELETE", url: `/api/focus/${kind === "object" ? "events" : "coverage"}/missing%20%2F1`,
    }]);
  });

  it("deletes the canonical encoded object path without trying to parse an empty success body", async () => {
    const requests = mockResponses(new Response(null, { status: 204 }));
    await expect(api.deleteFocusObject("decision", "decision /1")).resolves.toBeUndefined();
    expect(requests).toEqual([{ method: "DELETE", url: "/api/focus/decisions/decision%20%2F1" }]);
  });

  it.each(["read", "mutation"] as const)("rejects malformed successful JSON for a %s", async (operation) => {
    mockResponses(new Response('{"decision":', { status: 200, headers: { "Content-Type": "application/json" } }));
    const result = operation === "read"
      ? api.fetchFocusObject("decision", "decision-1")
      : api.patchFocusObject("decision", "decision-1", { pinned: false });
    await expect(result).rejects.toBeInstanceOf(SyntaxError);
  });

  it.each(["read", "delete"] as const)("falls back to HTTP status text for an unparseable %s error", async (operation) => {
    mockResponses(new Response("<html>Unavailable</html>", { status: 503, statusText: "Service Unavailable" }));
    const result = operation === "read" ? api.fetchFocusSnapshot() : api.deleteFocusCoverageAssertion("coverage-1");
    await expect(result).rejects.toMatchObject({ name: "ApiError", status: 503, message: "Service Unavailable" });
  });
});

describe("Focus notification policy serialization", () => {
  it("round-trips every policy field through the settings endpoint", async () => {
    const policy: FocusNotificationPolicy = {
      timezone: "America/Los_Angeles", quietHours: { start: "22:30", end: "07:15" },
      reviewTimes: ["09:00", "17:30"], coalesceMinutes: 10, enableAuthorizedImmediate: true,
      allowGrantQuietHoursOverride: false,
    };
    const settings = { mcpServers: {}, focusNotifications: policy };
    const requests = mockResponses(Response.json(settings));
    await expect(api.patchFocusNotificationPolicy(policy)).resolves.toEqual(settings);
    expect(requests).toEqual([{ method: "PATCH", url: "/api/settings", body: { focusNotifications: policy } }]);
  });

  it.each([
    { quietHours: null, reviewTimes: [], coalesceMinutes: 0, enableAuthorizedImmediate: false, allowGrantQuietHoursOverride: false },
    { timezone: null, quietHours: null, reviewTimes: null, coalesceMinutes: null, enableAuthorizedImmediate: null, allowGrantQuietHoursOverride: null },
    null,
  ] satisfies Array<FocusNotificationPolicyUpdate | null>)("preserves explicit policy clears and false values: %j", async (policy) => {
    const requests = mockResponses(Response.json({ mcpServers: {} }));
    expect(JSON.parse(api.serializeSettingsPatch({ focusNotifications: policy }))).toEqual({ focusNotifications: policy });
    await api.patchFocusNotificationPolicy(policy);
    expect(requests).toEqual([{ method: "PATCH", url: "/api/settings", body: { focusNotifications: policy } }]);
  });

  it("does not reset Focus policy while preserving legacy model and worker clears", () => {
    expect(JSON.parse(api.serializeSettingsPatch({
      model: undefined, reasoningEffort: undefined, contextTier: undefined, lastModelPreset: undefined, deferWorker: undefined,
    }))).toEqual({ model: "", reasoningEffort: "", contextTier: "", lastModelPreset: "", deferWorker: {} });
    expect(JSON.parse(api.serializeSettingsPatch({ focusNotifications: undefined, theme: "dark" }))).toEqual({ theme: "dark" });
  });

  it("rejects invalid policy input rather than presenting a successful update", async () => {
    const requests = mockResponses(Response.json({ error: "focusNotifications.coalesceMinutes must be between 0 and 60" }, { status: 400 }));
    await expect(api.patchFocusNotificationPolicy({ coalesceMinutes: 61 })).rejects.toThrow("coalesceMinutes");
    expect(requests).toEqual([{ method: "PATCH", url: "/api/settings", body: { focusNotifications: { coalesceMinutes: 61 } } }]);
  });
});
