import { describe, expect, it, vi } from "vitest";
import { getBridgeToolDefinitions } from "../agent-tools-mcp/register.js";
import type { ApiRouteTestState } from "../../test-support/api-routes.js";
import { installApiRouteTestHooks, request } from "../../test-support/api-routes.js";
import { alertDetails, decisionDetails, eventDetails } from "./focus-test-fixtures.js";
import { initPushEventNotifications, type BridgePushPayload } from "../push-notification-service.js";

let app: ApiRouteTestState["app"];
let ctx: ApiRouteTestState["ctx"];
installApiRouteTestHooks((state) => { ({ app, ctx } = state); });

async function tool(name: string, args: Record<string, unknown>) {
  const definition = getBridgeToolDefinitions(ctx).find((entry) => entry.name === name);
  if (!definition?.handler) throw new Error(`${name} missing`);
  return await definition.handler(args, {
    sessionId: "focus-hardening-test", toolCallId: name, toolName: name, arguments: args,
  }) as Record<string, any>;
}

describe("Focus hardening APIs and tools", () => {
  it("rejects incomplete first-class admission at both API and agent boundaries", async () => {
    for (const type of ["decision", "alert", "event"]) {
      const response = await request(app).post(`/api/focus/${type}s`).send({ title: "Incomplete", ...(type === "event" ? { category: "note" } : {}) });
      expect(response.status, type).toBe(400);
      const result = await tool(`${type}_save`, { title: "Incomplete", ...(type === "event" ? { category: "note" } : {}) });
      expect(result.success, type).not.toBe(true);
    }
    const decision = await request(app).post("/api/focus/decisions").send({ ...decisionDetails, question: "Choose a direction?" });
    expect(decision.status).toBe(201);
    expect(decision.body.decision.details.alternatives).toEqual(decisionDetails.alternatives);
    expect((await request(app).post("/api/focus/events").send({ ...eventDetails(), category: "note", key: "source:valid", title: "Verified observation" })).status).toBe(201);
  });

  it("makes feed_save Event-only without disabling rollback import adapters", async () => {
    for (const kind of ["decision", "alert", " alert "]) {
      const result = await tool("feed_save", { kind, title: "Not a valid shortcut" });
      expect(result).toMatchObject({ error: expect.stringContaining("Event-only") });
      expect(result.success).not.toBe(true);
    }
    const old = ctx.feedStore.saveCard({ kind: "decision", title: "Old binary object", key: "legacy:choice" }).card;
    expect(ctx.decisionStore.get(old.id)?.details.notificationMode).toBe("focus");
    expect(await tool("feed_save", { id: old.id, body: "Bypass?" })).toMatchObject({ error: expect.stringContaining("Event-only") });
    expect(await tool("feed_save", { kind: "note", key: "legacy:event", title: "Compatible Event" })).toMatchObject({ success: true });
  });

  it("has Event promotion parity, explicit global destinations, source links and truthful session linking", async () => {
    const event = await tool("event_save", { ...eventDetails(), category: "observation", key: "source:promote", title: "Accepted concern" });
    const id = event.event.id;
    expect((await request(app).post(`/api/focus/events/${id}/make-action`).send({})).status).toBe(400);
    const promoted = await tool("event_promote", { id, text: "Carry out accepted work", taskId: null });
    expect(promoted).toMatchObject({ success: true, created: true, object: { lifecycle: "handed_off", status: "active" } });
    const retry = await request(app).post(`/api/focus/events/${id}/make-action`).send({ taskId: null });
    expect(retry.status).toBe(200);
    expect(retry.body.action.id).toBe(promoted.action.id);
    expect(retry.body.action.sources).toEqual([expect.objectContaining({ sourceId: id, lifecycle: "handed_off" })]);
    expect(retry.body.object.linkedActions[0].actionId).toBe(promoted.action.id);
    const decision = (await request(app).post("/api/focus/decisions").send({
      ...decisionDetails, title: "Discuss", launchPrompt: { prompt: "Compare the alternatives" },
    })).body.decision;
    const linked = await request(app).post(`/api/focus/decisions/${decision.id}/link-session`).send({
      sessionId: "created-session", expectedActivationId: decision.activationId,
    });
    expect(linked.body.object).toMatchObject({ sessionId: "created-session", lifecycle: "acknowledged", status: "active" });
    const history = await request(app).get(`/api/focus/history?objectId=${encodeURIComponent(id)}`);
    expect(history.body.total).toBe(1);
    expect(history.body.objects[0].transitions).toEqual(expect.arrayContaining([expect.objectContaining({ relatedActionId: promoted.action.id })]));
  });

  it("requires explicit new episodes and keeps hidden Decisions queryable", async () => {
    const task = ctx.taskStore.createTask("Hidden");
    const decision = ctx.focusMutationCoordinator.saveDecision({ ...decisionDetails, title: "Hidden choice", taskId: task.id }).decision;
    ctx.taskStore.updateTask(task.id, { muted: true });
    expect((await request(app).get("/api/focus/decisions")).body.total).toBe(0);
    expect((await request(app).get("/api/focus/decisions?all=true")).body.total).toBe(1);
    expect((await request(app).post(`/api/focus/decisions/${decision.id}/make-action`).send({})).status).toBe(400);
    expect((await request(app).patch(`/api/focus/decisions/${decision.id}`).send({ lifecycle: "dismissed", lifecycleReason: "Not needed" })).status).toBe(200);
    expect((await request(app).patch(`/api/focus/decisions/${decision.id}`).send({ lifecycle: "active" })).status).toBe(400);
    expect((await request(app).patch(`/api/focus/decisions/${decision.id}`).send({ lifecycle: "active", newEpisode: true, episodeReason: "New evidence" })).status).toBe(200);
  });

  it.each(["resolved", "accepted_risk"])("serializes retained %s episode results without rewriting older history", async (lifecycle) => {
    const decision = ctx.focusMutationCoordinator.saveDecision({
      ...decisionDetails, title: "Review a deployment", fallback: "Keep the current deployment",
    }).decision;
    const closed = await request(app).patch(`/api/focus/decisions/${decision.id}`).send({
      lifecycle, outcome: "Observed successful rollout", resolutionReason: "Owner confirmed the result",
    });
    expect(closed.status).toBe(200);
    const legacy = ctx.focusTransitionStore.append({
      objectId: decision.id, objectType: "decision", title: decision.title, activationId: decision.activationId,
      fromLifecycle: "active", toLifecycle: "resolved", reason: "legacy-result", actor: "legacy",
      details: { fingerprint: "old-format", retainedExtension: { note: "Preserve this entry verbatim" } },
    });
    const reopened = await request(app).patch(`/api/focus/decisions/${decision.id}`).send({
      lifecycle: "active", newEpisode: true, episodeReason: "A new rollout is requested",
    });
    expect(reopened.status).toBe(200);
    expect(reopened.body.decision.details.outcome).toBeNull();
    const history = (await request(app).get(`/api/focus/history?objectId=${decision.id}`)).body;
    const transitions = (await request(app).get(`/api/focus/history/${decision.id}/transitions`)).body.transitions;
    const toolHistory = await tool("focus_history_list", { objectId: decision.id });
    for (const entries of [history.objects[0].transitions, transitions, toolHistory.objects[0].transitions]) {
      expect(entries).toEqual(expect.arrayContaining([
        expect.objectContaining({
          reason: "new-episode",
          details: expect.objectContaining({
            previousEpisode: expect.objectContaining({
              schemaVersion: 1, activationId: decision.activationId, lifecycle,
              outcome: "Observed successful rollout", resolutionReason: "Owner confirmed the result",
              recommendation: decisionDetails.recommendation, fallback: "Keep the current deployment",
              resolvedAt: closed.body.decision.details.resolvedAt,
            }),
          }),
        }),
        legacy,
      ]));
    }
    expect(ctx.focusTransitionStore.list(decision.id).find((entry) => entry.id === legacy.id)).toEqual(legacy);
  });

  it("manages authority and coverage with strict inputs, computed status, and delivery-time revocation", async () => {
    const until = new Date(Date.now() + 86_400_000).toISOString();
    const created = await request(app).post("/api/focus/authority").send({
      title: "Approved", sourceFamily: "health", producer: "health-check", scope: "Service health",
      validUntil: until, grantedBy: "user", allowImmediate: true,
    });
    expect(created.status).toBe(200);
    const grant = created.body.grant;
    expect((await request(app).get("/api/focus/authority")).body.grants).toHaveLength(1);
    expect((await request(app).patch(`/api/focus/authority/${grant.id}`).send({ mystery: true })).status).toBe(400);
    expect((await request(app).patch(`/api/focus/authority/${grant.id}`).send({ constraints: ["Notify; never change deployment"] })).body.grant.constraints).toHaveLength(1);
    const alert = await request(app).post("/api/focus/alerts").send({
      ...alertDetails(), title: "Verified immediate", notificationMode: "immediate", authorizationGrantId: grant.id,
    });
    expect(alert.status).toBe(201);
    const coverage = await tool("focus_coverage_save", {
      title: "Service monitored", sourceFamily: "health", producer: "health-check", scope: "Health endpoint",
      explicitState: "valid", lastCheckedAt: new Date(Date.now() - 1000).toISOString(), validUntil: until,
      evidence: ["Endpoint checked"], authorityGrantId: grant.id,
    });
    expect(coverage.assertion.state).toBe("valid");
    const revoked = await tool("focus_authority_revoke", { id: grant.id, reason: "Permission withdrawn" });
    expect(revoked.grant.status).toBe("revoked");
    expect((await request(app).get("/api/focus/coverage")).body.assertions[0].constrainedAutonomy).toContain("No currently active matching authority grant");
    const denied = await request(app).post("/api/focus/alerts").send({
      ...alertDetails(), title: "No longer authorized", notificationMode: "immediate", authorizationGrantId: grant.id,
    });
    expect(denied.status).toBe(400);
    const cleared = await request(app).patch(`/api/focus/alerts/${alert.body.alert.id}`).send({ lifecycle: "resolved", lifecycleReason: "Service recovered" });
    expect(cleared.status).toBe(200);
    expect(cleared.body.alert.lifecycle).toBe("resolved");
    expect((await request(app).delete(`/api/focus/coverage/${coverage.assertion.id}`)).status).toBe(200);
  });

  it("exposes audits, aggregate metrics, history transitions and digest viewing", async () => {
    const event = ctx.focusMutationCoordinator.saveEvent("note", { ...eventDetails(), key: "source:view", title: "Digest item" }).event;
    const snapshot = (await request(app).get("/api/focus")).body;
    const digest = snapshot.digests[0];
    expect(digest.newCount).toBe(1);
    const view = await request(app).post("/api/focus/digests/viewed").send({ digestId: digest.id });
    expect(view.status).toBe(200);
    expect((await request(app).get("/api/focus")).body.digests[0].newCount).toBe(0);
    const audit = await tool("focus_audit_save", { objectId: event.id, title: "Too noisy", category: "false_positive", notes: "This item did not need attention" });
    expect((await request(app).get("/api/focus")).body.auditExceptions[0].id).toBe(audit.audit.id);
    expect((await request(app).patch(`/api/focus/audits/${audit.audit.id}`).send({ status: "resolved" })).status).toBe(400);
    expect((await request(app).patch(`/api/focus/audits/${audit.audit.id}`).send({ status: "resolved", outcome: "Classification fixed" })).status).toBe(200);
    expect((await request(app).get("/api/focus/metrics?days=91")).status).toBe(400);
    const metrics = (await request(app).get("/api/focus/metrics?days=7")).body;
    expect(metrics.counts.create).toBeGreaterThan(0);
    expect(metrics.counts.snapshot).toBeGreaterThan(0);
    expect((await request(app).get(`/api/focus/history/${event.id}/transitions`)).body.transitions).toHaveLength(1);
    expect((await request(app).get("/api/focus/notification-deliveries")).status).toBe(200);
  });

  it("supports optional Action keys/source URLs while keeping completion separate", async () => {
    const input = { text: "Accepted executable work", key: "accepted:api", sourceUrl: "https://example.test/concern" };
    const first = await request(app).post("/api/actions").send(input);
    const second = await request(app).post("/api/actions").send(input);
    expect(second.body.action.id).toBe(first.body.action.id);
    expect(first.body.action).toMatchObject({ stableKey: input.key, sourceUrl: input.sourceUrl, sources: [] });
    expect((await request(app).post("/api/actions").send({ ...input, unknown: true })).status).toBe(400);
  });

  it("preserves needs-input push with a linked Decision tag and disposes its subscription", async () => {
    const decision = ctx.focusMutationCoordinator.saveDecision({ ...decisionDetails, title: "Respond", sessionId: "needs-input-session" }).decision;
    const summary = { attempted: 1, sent: 1, failed: 0, pruned: 0 };
    const sendToAll = vi.fn(async (_payload: BridgePushPayload) => summary);
    const stop = initPushEventNotifications(ctx, { sendToAll, sendToEndpoint: async () => summary });
    ctx.globalBus.emit({ type: "session:user-input", sessionId: "needs-input-session", needsUserInput: true });
    await stop();
    expect(sendToAll).toHaveBeenCalledWith(expect.objectContaining({
      tag: "bridge-session-needs-input-session", data: expect.objectContaining({ focusObjectId: decision.id }),
    }));
    expect(ctx.focusAttentionStore.list({ objectId: decision.id }).map((event) => event.eventType))
      .toEqual(expect.arrayContaining(["notification_eligibility", "notification_delivery"]));
    ctx.globalBus.emit({ type: "session:user-input", sessionId: "needs-input-session", needsUserInput: true });
    expect(sendToAll).toHaveBeenCalledTimes(1);
  });
});
