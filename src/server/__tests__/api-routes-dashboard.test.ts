import { describe, expect, it, vi } from "vitest";
import type { ApiRouteTestState } from "./api-routes-test-helpers.js";
import {
  createMockSessionManager,
  createTestApp,
  installApiRouteTestHooks,
  providers,
  request,
} from "./api-routes-test-helpers.js";

let app: ApiRouteTestState["app"];
let ctx: ApiRouteTestState["ctx"];
let db: ApiRouteTestState["db"];

installApiRouteTestHooks((state) => {
  ({ app, ctx, db } = state);
});

describe("Dashboard routes", () => {
  it("GET /api/dashboard includes schedules array", async () => {
    const res = await request(app).get("/api/dashboard");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("schedules");
    expect(Array.isArray(res.body.schedules)).toBe(true);
  });

  it("GET /api/dashboard requests active-only sessions from disk", async () => {
    const sessionManager = createMockSessionManager();
    const listSessionsFromDisk = vi.fn(async (opts?: { includeArchived?: boolean }) => {
      if (opts?.includeArchived !== false) {
        throw new Error("dashboard should not scan archived sessions");
      }
      return [
        {
          sessionId: "active-session",
          summary: "Active session",
          lastVisibleActivityAt: "2026-04-16T12:00:00.000Z",
        },
      ];
    });
    sessionManager.listSessionsFromDisk = listSessionsFromDisk;
    ({ app, ctx } = createTestApp({ sessionManager }));

    const res = await request(app).get("/api/dashboard");

    expect(res.status).toBe(200);
    expect(listSessionsFromDisk).toHaveBeenCalledWith({ includeArchived: false });
    expect(res.body.orphanSessions).toEqual([
      expect.objectContaining({ sessionId: "active-session", title: "Active session" }),
    ]);
  });

  it("GET /api/dashboard surfaces attention-only activity on orphan sessions", async () => {
    const sessionManager = createMockSessionManager();
    sessionManager.listSessionsFromDisk = vi.fn().mockResolvedValue([
      {
        sessionId: "attention-session",
        summary: "Attention session",
        modifiedTime: "2026-04-16T12:00:00.000Z",
      },
    ]);
    ({ app, ctx, db } = createTestApp({ sessionManager }));
    ctx.sessionMetaStore.setLastAttentionAt("attention-session", "2026-04-16T13:00:00.000Z");
    db.prepare("INSERT INTO read_state (sessionId, lastReadAt) VALUES (?, ?)")
      .run("attention-session", "2026-04-16T12:59:00.000Z");

    const res = await request(app).get("/api/dashboard");

    expect(res.status).toBe(200);
    expect(res.body.orphanSessions).toEqual([
      expect.objectContaining({
        sessionId: "attention-session",
        lastAttentionAt: "2026-04-16T13:00:00.000Z",
        lastActivityAt: "2026-04-16T13:00:00.000Z",
        unread: true,
      }),
    ]);
  });

  it("GET /api/dashboard reuses the warmed active session cache", async () => {
    const sessionManager = createMockSessionManager();
    const listSessionsFromDisk = vi.fn(async () => [
      {
        sessionId: "cached-dashboard-session",
        summary: "Cached dashboard session",
        lastVisibleActivityAt: "2026-04-16T12:00:00.000Z",
      },
    ]);
    sessionManager.listSessionsFromDisk = listSessionsFromDisk;
    ({ app, ctx } = createTestApp({ sessionManager }));

    const sessionsRes = await request(app).get("/api/sessions");
    const dashboardRes = await request(app).get("/api/dashboard");

    expect(sessionsRes.status).toBe(200);
    expect(dashboardRes.status).toBe(200);
    expect(dashboardRes.body.orphanSessions).toEqual([
      expect.objectContaining({ sessionId: "cached-dashboard-session", title: "Cached dashboard session" }),
    ]);
    expect(listSessionsFromDisk).toHaveBeenCalledTimes(1);
  });

  it("GET /api/dashboard fails clearly when dashboard stores are missing", async () => {
    ({ app, ctx } = createTestApp({
      taskGroupStore: undefined as any,
      scheduleStore: undefined as any,
      checklistStore: undefined as any,
      voiceJobManager: {} as any,
    }));
    ctx.taskStore.createTask("Dashboard Task");

    const res = await request(app).get("/api/dashboard");

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("Dashboard stores are not configured.");
  });

  it("GET /api/dashboard keeps sessions visible when a CLI-owned summary exists", async () => {
    const sessionManager = createMockSessionManager();
    sessionManager.listSessionsFromDisk = vi.fn().mockResolvedValue([
      {
        sessionId: "fork-session",
        summary: "Fork of Original session",
        modifiedTime: "2026-04-16T12:00:00.000Z",
        lastVisibleActivityAt: "2026-04-16T12:00:00.000Z",
      },
    ]);
    ({ app, ctx } = createTestApp({ sessionManager }));

    const res = await request(app).get("/api/dashboard");

    expect(res.status).toBe(200);
    expect(res.body.orphanSessions).toEqual([
      expect.objectContaining({
        sessionId: "fork-session",
        title: "Fork of Original session",
      }),
    ]);
  });

  it("GET /api/dashboard enriches schedules with task title", async () => {
    // Create a task and schedule via stores
    const task = await request(app).post("/api/tasks").send({ title: "Dashboard Task" });
    const taskId = task.body.task.id;
    ctx.scheduleStore.createSchedule({
      taskId, name: "Dash Sched", prompt: "test", type: "cron", cron: "0 0 * * *",
    });

    const res = await request(app).get("/api/dashboard");
    expect(res.status).toBe(200);
    const sched = res.body.schedules.find((s: any) => s.name === "Dash Sched");
    expect(sched).toBeDefined();
    expect(sched.taskTitle).toBe("Dashboard Task");
  });

  it("GET /api/dashboard treats stalled sessions as active in orphan sessions", async () => {
    ctx.sessionManager.listSessionsFromDisk = async () => [
      {
        sessionId: "stall-1",
        summary: "Stalled session",
        lastVisibleActivityAt: "2026-04-19T01:00:00.000Z",
        context: { branch: "main" },
      } as any,
    ];
    ctx.sessionManager.getSessionRunState = vi.fn().mockImplementation((sessionId: string) => (
      sessionId === "stall-1" ? "stalled" : "idle"
    ));
    ctx.sessionManager.isSessionBusy = vi.fn().mockImplementation((sessionId: string) => sessionId === "stall-1");

    const res = await request(app).get("/api/dashboard");

    expect(res.status).toBe(200);
    expect(res.body.busySessions).toEqual([
      expect.objectContaining({ sessionId: "stall-1", runState: "stalled", busy: true }),
    ]);
    expect(res.body.orphanSessions).toEqual([
      expect.objectContaining({ sessionId: "stall-1", runState: "stalled", busy: true, unread: true }),
    ]);
  });

  it("GET /api/dashboard treats tasks with input-waiting sessions as busy", async () => {
    ctx.sessionManager.listSessionsFromDisk = async () => [
      {
        sessionId: "ask-1",
        summary: "Awaiting decision",
        lastVisibleActivityAt: "2026-04-19T01:00:00.000Z",
      } as any,
    ];
    ctx.sessionManager.getSessionRunState = vi.fn().mockImplementation((sessionId: string) => (
      sessionId === "ask-1" ? "busy" : "idle"
    ));
    ctx.sessionManager.getPendingUserInputCount = vi.fn().mockImplementation((sessionId: string) => (
      sessionId === "ask-1" ? 1 : 0
    ));
    const task = ctx.taskStore.createTask("Needs user choice");
    ctx.taskStore.linkSession(task.id, "ask-1");

    const res = await request(app).get("/api/dashboard");

    expect(res.status).toBe(200);
    expect(res.body.lastActiveTask).toEqual(expect.objectContaining({
      task: expect.objectContaining({ id: task.id }),
      hasBusySession: true,
    }));
  });

  it("GET /api/dashboard omits legacy unread aggregation fields", async () => {
    ctx.sessionManager.listSessionsFromDisk = async () => [
      {
        sessionId: "legacy-unread-1",
        summary: "Legacy unread",
        lastVisibleActivityAt: "2026-04-19T01:00:00.000Z",
      } as any,
    ];
    const task = ctx.taskStore.createTask("Linked task");
    ctx.taskStore.linkSession(task.id, "legacy-unread-1");

    const res = await request(app).get("/api/dashboard");

    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty("unreadSessions");
    expect(res.body.lastActiveTask).not.toHaveProperty("hasUnread");
  });

  it("GET /api/dashboard returns derived task momentum queues", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T12:00:00.000Z"));

    try {
      const testApp = createTestApp();
      app = testApp.app;
      ctx = testApp.ctx;
      const { db } = testApp;

      const decisionTask = ctx.taskStore.createTask("Needs a decision");
      const followUpTask = ctx.taskStore.createTask("Follow up now");
      const waitingTask = ctx.taskStore.createTask("Waiting on someone");
      const closeTask = ctx.taskStore.createTask("Candidate to close");
      const staleTask = ctx.taskStore.createTask("Stale task");

      ctx.taskStore.updateTask(followUpTask.id, {
        nextAction: "Reply to the thread",
        nextTouchAt: "2026-05-01T11:00:00.000Z",
      });
      ctx.taskStore.updateTask(waitingTask.id, {
        nextAction: "Review when it lands",
        waitingOn: "Design feedback",
      });
      ctx.taskStore.updateTask(closeTask.id, {
        nextAction: "Close it out",
      });
      ctx.taskStore.updateTask(staleTask.id, {
        nextAction: "Revisit later",
      });
      ctx.checklistStore.createChecklistItem(staleTask.id, "Still blocked");
      db.prepare("UPDATE tasks SET updatedAt = ? WHERE id = ?").run("2026-04-20T09:00:00.000Z", staleTask.id);

      const res = await request(app).get("/api/dashboard");
      const needsDecisionIds = res.body.taskMomentum.needsDecision.map((entry: any) => entry.task.id);
      const followUpNowIds = res.body.taskMomentum.followUpNow.map((entry: any) => entry.task.id);
      const waitingIds = res.body.taskMomentum.waiting.map((entry: any) => entry.task.id);
      const candidateToCloseIds = res.body.taskMomentum.candidateToClose.map((entry: any) => entry.task.id);
      const staleIds = res.body.taskMomentum.stale.map((entry: any) => entry.task.id);

      expect(res.status).toBe(200);
      expect(res.body.taskMomentum.summary).toEqual({
        needsDecision: 1,
        followUpNow: 1,
        waiting: 1,
        candidateToClose: res.body.taskMomentum.candidateToClose.length,
        stale: 1,
      });
      expect(needsDecisionIds).toEqual([decisionTask.id]);
      expect(followUpNowIds).toEqual([followUpTask.id]);
      expect(waitingIds).toEqual([waitingTask.id]);
      expect(candidateToCloseIds).toContain(closeTask.id);
      expect(candidateToCloseIds).not.toContain(staleTask.id);
      expect(staleIds).toEqual([staleTask.id]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("GET /api/dashboard taskMomentum.summary counts match queue lengths", async () => {
    const res = await request(app).get("/api/dashboard");
    expect(res.status).toBe(200);
    const { summary, needsDecision, followUpNow, waiting, candidateToClose, stale } = res.body.taskMomentum;
    expect(summary.needsDecision).toBe(needsDecision.length);
    expect(summary.followUpNow).toBe(followUpNow.length);
    expect(summary.waiting).toBe(waiting.length);
    expect(summary.candidateToClose).toBe(candidateToClose.length);
    expect(summary.stale).toBe(stale.length);
  });

  it("GET /api/dashboard taskMomentum.followUpNow excludes tasks with future nextTouchAt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T12:00:00.000Z"));

    try {
      const testApp = createTestApp();
      app = testApp.app;
      ctx = testApp.ctx;

      const futureTask = ctx.taskStore.createTask("Future reminder");
      ctx.taskStore.updateTask(futureTask.id, {
        nextAction: "Check in",
        nextTouchAt: "2026-05-01T13:00:00.000Z", // 1 hour in the future
      });
      const pastTask = ctx.taskStore.createTask("Past reminder");
      ctx.taskStore.updateTask(pastTask.id, {
        nextAction: "Already due",
        nextTouchAt: "2026-05-01T11:00:00.000Z", // 1 hour in the past
      });

      const res = await request(app).get("/api/dashboard");
      const followUpNowIds = res.body.taskMomentum.followUpNow.map((e: any) => e.task.id);

      expect(res.status).toBe(200);
      expect(followUpNowIds).not.toContain(futureTask.id);
      expect(followUpNowIds).toContain(pastTask.id);
    } finally {
      vi.useRealTimers();
    }
  });

  it("GET /api/dashboard taskMomentum.needsDecision excludes deferred tasks with nextTouchAt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T12:00:00.000Z"));

    try {
      const testApp = createTestApp();
      app = testApp.app;
      ctx = testApp.ctx;

      const deferredTask = ctx.taskStore.createTask("Deferred");
      ctx.taskStore.updateTask(deferredTask.id, {
        nextTouchAt: "2026-05-02T12:00:00.000Z",
      });
      const undecidedTask = ctx.taskStore.createTask("Needs decision");

      const res = await request(app).get("/api/dashboard");
      const needsDecisionIds = res.body.taskMomentum.needsDecision.map((e: any) => e.task.id);

      expect(res.status).toBe(200);
      expect(needsDecisionIds).toContain(undecidedTask.id);
      expect(needsDecisionIds).not.toContain(deferredTask.id);
    } finally {
      vi.useRealTimers();
    }
  });

  it("GET /api/dashboard taskMomentum.candidateToClose excludes tasks with open checklist items", async () => {
    const testApp = createTestApp();
    app = testApp.app;
    ctx = testApp.ctx;

    const clean = ctx.taskStore.createTask("Ready to close");
    const blocked = ctx.taskStore.createTask("Has open checklist");
    ctx.checklistStore.createChecklistItem(blocked.id, "Unfinished item");

    const res = await request(app).get("/api/dashboard");
    const candidateIds = res.body.taskMomentum.candidateToClose.map((e: any) => e.task.id);

    expect(res.status).toBe(200);
    expect(candidateIds).toContain(clean.id);
    expect(candidateIds).not.toContain(blocked.id);
  });

  it("GET /api/dashboard taskMomentum.candidateToClose excludes tasks with busy sessions", async () => {
    const sessionManager = createMockSessionManager();
    sessionManager.listSessionsFromDisk = vi.fn().mockResolvedValue([
      {
        sessionId: "busy-sess",
        summary: "Active work",
        lastVisibleActivityAt: new Date().toISOString(),
      },
    ]);
    sessionManager.getSessionRunState = vi.fn().mockImplementation((id: string) =>
      id === "busy-sess" ? "running" : "idle",
    );

    const testApp = createTestApp({ sessionManager });
    app = testApp.app;
    ctx = testApp.ctx;

    const busyTask = ctx.taskStore.createTask("Has busy session");
    ctx.taskStore.linkSession(busyTask.id, "busy-sess");
    const idleTask = ctx.taskStore.createTask("No busy session");

    const res = await request(app).get("/api/dashboard");
    const candidateIds = res.body.taskMomentum.candidateToClose.map((e: any) => e.task.id);

    expect(res.status).toBe(200);
    expect(candidateIds).not.toContain(busyTask.id);
    expect(candidateIds).toContain(idleTask.id);
  });

  it("GET /api/dashboard taskMomentum.candidateToClose excludes tasks with unknown PR status", async () => {
    const enrichPullRequestsSpy = vi.spyOn(providers, "enrichPullRequests").mockResolvedValue([
      {
        repoId: "repo-1",
        repoName: "repo-1",
        prId: 42,
        provider: "github",
        title: null,
        status: null,
        createdBy: null,
        reviewerCount: 0,
        url: "https://example.test/repo-1/pull/42",
      },
    ]);

    try {
      const testApp = createTestApp();
      app = testApp.app;
      ctx = testApp.ctx;

      const unknownPrTask = ctx.taskStore.createTask("PR status unavailable");
      ctx.taskStore.linkPR(unknownPrTask.id, {
        repoId: "repo-1",
        repoName: "repo-1",
        prId: 42,
        provider: "github",
      });

      const cleanTask = ctx.taskStore.createTask("Ready to close");

      const res = await request(app).get("/api/dashboard");
      const candidateIds = res.body.taskMomentum.candidateToClose.map((e: any) => e.task.id);

      expect(res.status).toBe(200);
      expect(candidateIds).toContain(cleanTask.id);
      expect(candidateIds).not.toContain(unknownPrTask.id);
    } finally {
      enrichPullRequestsSpy.mockRestore();
    }
  });

  it("GET /api/dashboard keeps ongoing tasks in open queues but out of candidateToClose", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T12:00:00.000Z"));

    try {
      const testApp = createTestApp();
      app = testApp.app;
      ctx = testApp.ctx;
      const { db } = testApp;

      const ongoingDecision = ctx.taskStore.createTask("Ongoing decision");
      ctx.taskStore.updateTask(ongoingDecision.id, { kind: "ongoing" });

      const ongoingFollowUp = ctx.taskStore.createTask("Ongoing follow-up");
      ctx.taskStore.updateTask(ongoingFollowUp.id, {
        kind: "ongoing",
        nextAction: "Check in",
        nextTouchAt: "2026-05-01T11:00:00.000Z",
      });

      const ongoingWaiting = ctx.taskStore.createTask("Ongoing waiting");
      ctx.taskStore.updateTask(ongoingWaiting.id, {
        kind: "ongoing",
        nextAction: "Review update",
        waitingOn: "External input",
      });

      const ongoingStale = ctx.taskStore.createTask("Ongoing stale");
      ctx.taskStore.updateTask(ongoingStale.id, {
        kind: "ongoing",
        nextAction: "Keep monitoring",
      });
      db.prepare("UPDATE tasks SET updatedAt = ? WHERE id = ?").run("2026-04-20T09:00:00.000Z", ongoingStale.id);

      const closeableTask = ctx.taskStore.createTask("One-off task");
      ctx.taskStore.updateTask(closeableTask.id, {
        nextAction: "Wrap it up",
      });

      const res = await request(app).get("/api/dashboard");
      const needsDecisionIds = res.body.taskMomentum.needsDecision.map((e: any) => e.task.id);
      const followUpNowIds = res.body.taskMomentum.followUpNow.map((e: any) => e.task.id);
      const waitingIds = res.body.taskMomentum.waiting.map((e: any) => e.task.id);
      const candidateIds = res.body.taskMomentum.candidateToClose.map((e: any) => e.task.id);
      const staleIds = res.body.taskMomentum.stale.map((e: any) => e.task.id);

      expect(res.status).toBe(200);
      expect(res.body.taskMomentum.summary).toEqual({
        needsDecision: 1,
        followUpNow: 1,
        waiting: 1,
        candidateToClose: 1,
        stale: 1,
      });
      expect(needsDecisionIds).toContain(ongoingDecision.id);
      expect(followUpNowIds).toContain(ongoingFollowUp.id);
      expect(waitingIds).toContain(ongoingWaiting.id);
      expect(staleIds).toContain(ongoingStale.id);
      expect(candidateIds).toContain(closeableTask.id);
      expect(candidateIds).not.toContain(ongoingDecision.id);
      expect(candidateIds).not.toContain(ongoingFollowUp.id);
      expect(candidateIds).not.toContain(ongoingWaiting.id);
      expect(candidateIds).not.toContain(ongoingStale.id);
    } finally {
      vi.useRealTimers();
    }
  });

  it("GET /api/dashboard taskMomentum.stale excludes tasks with nextTouchAt set", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T12:00:00.000Z"));

    try {
      const testApp = createTestApp();
      app = testApp.app;
      ctx = testApp.ctx;
      const { db } = testApp;

      // Both tasks are "old" (last touched > 7 days ago)
      const trueStale = ctx.taskStore.createTask("Truly stale");
      const touchedStale = ctx.taskStore.createTask("Stale but scheduled");
      ctx.taskStore.updateTask(touchedStale.id, {
        nextTouchAt: "2026-06-01T00:00:00.000Z",
      });

      const staleTs = "2026-04-20T09:00:00.000Z";
      db.prepare("UPDATE tasks SET updatedAt = ? WHERE id = ?").run(staleTs, trueStale.id);
      db.prepare("UPDATE tasks SET updatedAt = ? WHERE id = ?").run(staleTs, touchedStale.id);

      const res = await request(app).get("/api/dashboard");
      const staleIds = res.body.taskMomentum.stale.map((e: any) => e.task.id);

      expect(res.status).toBe(200);
      expect(staleIds).toContain(trueStale.id);
      expect(staleIds).not.toContain(touchedStale.id);
    } finally {
      vi.useRealTimers();
    }
  });
});
