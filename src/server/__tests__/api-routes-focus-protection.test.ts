import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createTestApp } from "./test-app.js";
import { getBridgeToolDefinitions } from "../agent-tools-mcp/register.js";
import { RESTART_RECOVERY_CONTINUE_PROMPT } from "../restart-resume.js";
import { createReturnedDeferDelivery } from "../defer-result-message.js";
import { FEED_GUIDANCE } from "../session-instructions.js";
import { createFocusProtectionService } from "../focus-protection-service.js";
import { FOCUS_NOTIFICATION_CLAIM_GRACE_MS } from "../focus-notification-delivery-store.js";
import { decisionDetails, alertDetails } from "./focus-test-fixtures.js";
import type { FocusProtectionPreview } from "../../shared/focus-protection.js";

const NOW = Date.parse("2026-09-05T12:01:00.000Z");
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();
const draft = (updates: Record<string, unknown> = {}) => ({
  endsAt: at(90), timezone: "UTC", reason: "Finish the design",
  allowNeedsInput: false, allowAuthorizedDeadlineOverride: false, ...updates,
});
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("user-controlled protection API", () => {
  it("previews, creates, reloads derived state, lists and cancels without an agent mutation", async () => {
    const { app, ctx } = createTestApp();
    const body = draft();
    expect((await request(app).post("/api/focus/protection").send(body)).status).toBe(400);
    const preview = await request(app).post("/api/focus/protection/preview").send(body);
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ request: body, needsInput: [], defers: [], schedules: [], interventions: [] });
    expect(ctx.focusProtectionStore.list()).toHaveLength(0);
    const created = await request(app).post("/api/focus/protection").send({
      ...body, confirmationToken: preview.body.confirmationToken, confirmInterventionConflicts: false,
    });
    expect(created.status).toBe(201);
    expect(created.body.window).toMatchObject({ status: "active", startsAt: at(0), endsAt: at(90), reason: body.reason });
    const reloaded = await request(app).get("/api/focus/protection/current");
    expect(reloaded.status).toBe(200);
    expect(reloaded.body.current).toEqual(created.body.window);
    expect(reloaded.body.impacts).toMatchObject({ postponed: 0, pending: 0 });
    expect((await request(app).get("/api/focus/protection?limit=1")).body.windows).toEqual([created.body.window]);
    const id = created.body.window.id;
    expect((await request(app).post(`/api/focus/protection/${id}/cancel`).send({})).body.window.status).toBe("cancelled");
    expect((await request(app).get("/api/focus/protection/current")).body.current).toBeNull();
    expect((await request(app).post(`/api/focus/protection/${id}/cancel`).send({})).status).toBe(200);
    expect((await request(app).post(`/api/focus/protection/${id}/cancel`).send({ endsAt: at(200) })).status).toBe(400);
  });

  it("accurately previews due slots, one-shots, recurring expiry, current input and in-flight work", async () => {
    const { app, ctx } = createTestApp();
    const task = ctx.taskStore.createTask("Paused work");
    const createSchedule = (name: string, type: "once" | "cron", minutes = 20) => ctx.scheduleStore.createSchedule({
      taskId: task.id, name, prompt: "Check", type,
      ...(type === "cron" ? { cron: "*/15 * * * *", timezone: "UTC" } : { runAt: at(minutes) }),
    });
    const cron = createSchedule("Quarter-hour checks", "cron");
    const once = createSchedule("One shot", "once", 30);
    createSchedule("End-exclusive", "once", 60);
    const disabled = createSchedule("Disabled", "once");
    ctx.scheduleStore.updateSchedule(disabled.id, { enabled: false });
    const running = createSchedule("Already admitted", "once", -1);
    ctx.scheduleStore.claimScheduleRun(running.id, "once");
    ctx.scheduleStore.claimAutomaticRun(running.id, at(-1), "once");
    const expired = createSchedule("Expired", "cron");
    ctx.scheduleStore.updateSchedule(expired.id, { expiresAt: at(-1) });
    const exhausted = createSchedule("Exhausted", "cron");
    ctx.scheduleStore.updateSchedule(exhausted.id, { maxRuns: 1 });
    ctx.scheduleStore.recordRun(exhausted.id, "last-run");
    const prompt = ctx.deferredPromptStore!.create("parent", "Check later", at(5));
    ctx.deferredPromptStore!.create("parent", "At end", at(60));
    ctx.deferredPromptStore!.create("parent", RESTART_RECOVERY_CONTINUE_PROMPT, at(10));
    ctx.deferredPromptStore!.create("parent", createReturnedDeferDelivery({
      kind: "once", deferId: "once_worker", parentSessionId: "parent",
    }, "Already running worker returned").prompt, at(10));
    const runningPrompt = ctx.deferredPromptStore!.create("working", "Claimed", at(-1));
    ctx.deferredPromptStore!.claimDue(runningPrompt.id, 60_000);
    const loop = ctx.deferLoopStore!.create({
      sessionId: "parent", name: "Expiring watch", prompt: "Check", intervalSeconds: 300,
      nextRunAt: at(5), expiresAt: at(40),
    });
    ctx.taskStore.linkSession(task.id, "muted-input");
    ctx.taskStore.updateTask(task.id, { muted: true });
    vi.spyOn(ctx.sessionManager, "getActiveSessions").mockReturnValue(["busy"]);
    vi.spyOn(ctx.sessionManager, "getPendingInputSessionIds").mockReturnValue(["input", "muted-input"]);
    vi.spyOn(ctx.sessionManager, "getPendingUserInputCount").mockImplementation((id) => id.includes("input") ? 1 : 0);
    vi.spyOn(ctx.sessionManager, "isSessionBusy").mockImplementation((id) => id === "busy");
    vi.spyOn(ctx.sessionManager, "getLifecycleBlockingSessionCount").mockReturnValue(2);
    ctx.sessionTitles.setTitle("input", "Choose the approach");
    const result = await request(app).post("/api/focus/protection/preview").send(draft({ endsAt: at(60) }));
    expect(result.status).toBe(200);
    const preview: FocusProtectionPreview = result.body;
    expect(preview.schedules).toHaveLength(2);
    expect(preview.schedules).toContainEqual(expect.objectContaining({
      id: cron.id, slotsDue: 4, firstScheduledFor: "2026-09-05T12:15:00.000Z", lastScheduledFor: "2026-09-05T13:00:00.000Z",
    }));
    expect(preview.schedules).toContainEqual(expect.objectContaining({ id: once.id, slotsDue: 1 }));
    expect(preview.defers).toHaveLength(2);
    expect(preview.defers).toContainEqual(expect.objectContaining({ id: prompt.id, kind: "defer" }));
    expect(preview.defers).toContainEqual(expect.objectContaining({ id: loop.id, expiresDuringProtection: true, expiresAt: at(40) }));
    expect(preview.continuingRecoveryPrompts).toBe(2);
    expect(preview.needsInput).toEqual([
      expect.objectContaining({ sessionId: "input", title: "Choose the approach", muted: false }),
      expect.objectContaining({ sessionId: "muted-input", muted: true }),
    ]);
    expect(preview.inFlight).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "session", id: "busy" }),
      expect.objectContaining({ kind: "schedule", id: running.id }),
      expect.objectContaining({ kind: "defer", id: runningPrompt.id }),
      expect.objectContaining({ kind: "session-creation", name: "1 session creation(s) in flight" }),
    ]));
    expect(ctx.deferredPromptStore!.get(prompt.id)?.attempts).toBe(0);
    expect(ctx.deferLoopStore!.get(loop.id)?.attempts).toBe(0);
  });

  it("shows quiet and overdue intervention conflicts and requires explicit confirmation even with bypass allowed", async () => {
    const { app, ctx } = createTestApp();
    const task = ctx.taskStore.createTask("Quiet deadline");
    ctx.taskStore.updateTask(task.id, { muted: true });
    const decision = ctx.focusMutationCoordinator.saveDecision({
      ...decisionDetails, title: "Choose before expiry", taskId: task.id, interventionBy: at(20),
      consequenceOfDelay: "The option expires",
    }).decision;
    const alert = ctx.focusMutationCoordinator.saveAlert({ ...alertDetails(), title: "Time-sensitive condition", interventionBy: at(30) }).alert;
    const closed = ctx.focusMutationCoordinator.saveDecision({
      ...decisionDetails, title: "Already answered", interventionBy: at(10), consequenceOfDelay: "No need",
    }).decision;
    ctx.focusMutationCoordinator.updateDecision(closed.id, { lifecycle: "resolved", outcome: "Answered", resolutionReason: "User chose" });
    const body = draft({ allowAuthorizedDeadlineOverride: true });
    const preview = (await request(app).post("/api/focus/protection/preview").send(body)).body as FocusProtectionPreview;
    expect(preview.interventions.map((item) => item.objectId)).toEqual([decision.id, alert.id]);
    expect(preview.interventions[0].taskState).toBe("muted");
    const input = { ...body, confirmationToken: preview.confirmationToken, confirmInterventionConflicts: false };
    expect((await request(app).post("/api/focus/protection").send(input)).status).toBe(409);
    expect(ctx.focusProtectionStore.list()).toHaveLength(0);
    const allowed = await request(app).post("/api/focus/protection").send({ ...input, confirmInterventionConflicts: true });
    expect(allowed.status).toBe(201);
    expect(allowed.body.window.allowAuthorizedDeadlineOverride).toBe(true);
  });

  it("rejects stale conflict/impact previews and tampered inputs instead of blindly accepting a confirmation flag", async () => {
    const { app, ctx } = createTestApp();
    const body = draft();
    const preview = (await request(app).post("/api/focus/protection/preview").send(body)).body as FocusProtectionPreview;
    const input = { ...body, confirmationToken: preview.confirmationToken, confirmInterventionConflicts: true };
    expect((await request(app).post("/api/focus/protection").send({ ...input, endsAt: at(120) })).status).toBe(409);
    ctx.focusMutationCoordinator.saveDecision({
      ...decisionDetails, title: "New conflict", interventionBy: at(5), consequenceOfDelay: "Irreversible loss",
    });
    const stale = await request(app).post("/api/focus/protection").send(input);
    expect(stale.status).toBe(409);
    expect(stale.body.error).toContain("Refresh the preview");
    expect(ctx.focusProtectionStore.list()).toHaveLength(0);
    const fresh = (await request(app).post("/api/focus/protection/preview").send(body)).body as FocusProtectionPreview;
    expect((await request(app).post("/api/focus/protection").send({ ...input, confirmationToken: fresh.confirmationToken })).status).toBe(201);
  });

  it("binds canonical instants/default flags but not the preview generation clock", async () => {
    const { app } = createTestApp();
    const body = { endsAt: "2026-09-05T06:31:00-07:00", timezone: "UTC", reason: "  Write  " };
    const preview = (await request(app).post("/api/focus/protection/preview").send(body)).body as FocusProtectionPreview;
    expect(preview.request).toEqual({ endsAt: at(90), timezone: "UTC", reason: "Write", allowNeedsInput: true, allowAuthorizedDeadlineOverride: false });
    vi.setSystemTime(NOW + 5_000);
    const created = await request(app).post("/api/focus/protection").send({
      ...preview.request, confirmationToken: preview.confirmationToken, confirmInterventionConflicts: false,
    });
    expect(created.status).toBe(201);
    expect(created.body.window.startsAt).toBe(new Date(NOW + 5_000).toISOString());
  });

  it("discloses active recurring expiry even when its next scheduled check is after the window", async () => {
    const { app, ctx } = createTestApp();
    const loop = ctx.deferLoopStore!.create({
      sessionId: "parent", name: "No remaining opportunity", prompt: "Check",
      intervalSeconds: 7_200, nextRunAt: at(120), expiresAt: at(30),
    });
    const preview = (await request(app).post("/api/focus/protection/preview").send(draft({ endsAt: at(60) }))).body as FocusProtectionPreview;
    expect(preview.defers).toEqual([expect.objectContaining({
      id: loop.id, scheduledFor: at(120), expiresAt: at(30), expiresDuringProtection: true,
    })]);
  });

  it("keeps an admitted cron slot in flight while its live schedule lock outlasts the slot lease", async () => {
    const { app, ctx } = createTestApp();
    const task = ctx.taskStore.createTask("Slow creation");
    const schedule = ctx.scheduleStore.createSchedule({
      taskId: task.id, name: "Still being created", prompt: "Run", type: "cron", cron: "* * * * *", timezone: "UTC",
    });
    ctx.scheduleStore.updateNextRunAt(schedule.id, at(0));
    const lock = ctx.scheduleStore.claimScheduleRun(schedule.id, "cron");
    expect(lock.acquired).toBe(true);
    if (!lock.acquired) throw new Error("Test schedule lock was not acquired");
    ctx.scheduleStore.claimAutomaticRun(schedule.id, at(0), "cron");
    vi.setSystemTime(at(1.5));
    expect(ctx.scheduleStore.renewClaimedAutomaticRun(schedule.id, lock.claim)).toBe(true);
    vi.setSystemTime(at(3));
    const preview = (await request(app).post("/api/focus/protection/preview").send(draft())).body as FocusProtectionPreview;
    expect(preview.schedules[0].firstScheduledFor).not.toBe(at(0));
    expect(preview.inFlight).toContainEqual(expect.objectContaining({ kind: "schedule", id: schedule.id }));
  });

  it("reports future status and exact expiry after reload, rejecting overlap and late cancellation", async () => {
    const { app, ctx, db } = createTestApp();
    const body = draft({ startsAt: at(30), endsAt: at(120) });
    const preview = (await request(app).post("/api/focus/protection/preview").send(body)).body as FocusProtectionPreview;
    const input = { ...body, confirmationToken: preview.confirmationToken, confirmInterventionConflicts: false };
    const created = (await request(app).post("/api/focus/protection").send(input)).body.window;
    expect(created.status).toBe("scheduled");
    expect((await request(app).post("/api/focus/protection").send(input)).status).toBe(409);
    expect((await request(app).get("/api/focus/protection/current")).body.upcoming.id).toBe(created.id);
    vi.setSystemTime(at(30));
    ctx.focusProtectionService = createFocusProtectionService(db, ctx.focusProtectionStore, ctx);
    expect((await request(app).get("/api/focus/protection/current")).body.current.status).toBe("active");
    vi.setSystemTime(at(120));
    const ended = (await request(app).get("/api/focus/protection/current")).body;
    expect(ended.current).toBeNull();
    expect(ended.latest.status).toBe("completed");
    expect((await request(app).post(`/api/focus/protection/${created.id}/cancel`).send({})).status).toBe(409);
  });

  it("shows unavailable impact domains as errors, never zero or a false all-clear", async () => {
    const { app, ctx } = createTestApp();
    vi.spyOn(ctx.sessionManager, "getBackendCreatedAt").mockReturnValue(null);
    expect((await request(app).post("/api/focus/protection/preview").send(draft())).status).toBe(503);
    expect((await request(app).get("/api/focus/protection/current")).body.current).toBeNull();
    vi.restoreAllMocks();
    ctx.deferredPromptStore = undefined;
    expect((await request(app).post("/api/focus/protection/preview").send(draft())).status).toBe(503);
    expect((await request(app).get("/api/focus/protection?limit=101")).status).toBe(400);
    expect((await request(app).get("/api/focus/protection?offset=bad")).status).toBe(400);
    expect((await request(app).post("/api/focus/protection/unknown/cancel").send({})).status).toBe(404);
    expect((await request(app).patch("/api/focus/protection/unknown").send({ endsAt: at(120) })).status).toBe(404);
  });

  it("registers only read-only protection tools and gives static limitations without warm-session claims", async () => {
    const { ctx } = createTestApp();
    const tools = getBridgeToolDefinitions(ctx).filter((tool) => tool.name.startsWith("focus_protection_"));
    expect(tools.map((tool) => tool.name).sort()).toEqual(["focus_protection_current", "focus_protection_list"]);
    const window = ctx.focusProtectionStore.create(draft());
    const current = tools.find((tool) => tool.name === "focus_protection_current")!;
    expect(await current.handler({}, {})).toMatchObject({ current: { id: window.id, status: "active" } });
    expect(await tools.find((tool) => tool.name === "focus_protection_list")!.handler({ limit: 10 }, {}))
      .toMatchObject({ windows: [{ id: window.id }] });
    expect(await current.handler({ endsAt: at(200) }, {})).toMatchObject({ resultType: "failure" });
    expect(ctx.focusProtectionStore.get(window.id)?.endsAt).toBe(at(90));
    for (const text of ["Agents cannot infer protection", "new automatic schedule and defer starts",
      "External systems are not frozen", "Already-warm sessions are not automatically updated", "focus_protection_current"]) {
      expect(FEED_GUIDANCE).toContain(text);
    }
  });

  it.each(["metrics", "current", "tool"] as const)("reconciles stale delivery impacts through %s inspection without session hydration or retries", async (surface) => {
    const { app, ctx } = createTestApp();
    const window = ctx.focusProtectionStore.create(draft());
    const identity = { objectId: "held-alert", activationId: "held-episode", reason: "immediate-alert" };
    ctx.focusProtectionStore.hold(window, {
      kind: "notification", workId: JSON.stringify([identity.objectId, identity.activationId]), scheduledFor: at(0),
    });
    const claimed = ctx.focusNotificationDeliveryStore.claim(identity, null)!;
    vi.spyOn(ctx.sessionManager, "getBackendCreatedAt").mockReturnValue(null);
    vi.setSystemTime(NOW + FOCUS_NOTIFICATION_CLAIM_GRACE_MS + 1);
    if (surface === "tool") {
      const tool = getBridgeToolDefinitions(ctx).find((entry) => entry.name === "focus_quality_metrics")!;
      expect(await tool.handler({}, {})).toMatchObject({ days: 7 });
    } else {
      const response = await request(app).get(surface === "current" ? "/api/focus/protection/current" : "/api/focus/metrics");
      expect(response.status).toBe(200);
    }
    expect(ctx.focusProtectionStore.impacts(window.id)).toMatchObject({ pending: 0, dispositions: { failed: 1 } });
    expect(ctx.focusNotificationDeliveryStore.get(identity)).toMatchObject({
      status: "failed", claimToken: claimed.claimToken, error: expect.stringContaining("outcome unknown"),
    });
    expect(ctx.focusNotificationDeliveryStore.claim(identity, null)).toBeUndefined();
  });
});
