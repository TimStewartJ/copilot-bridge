import { describe, expect, it } from "vitest";
import type { ApiRouteTestState } from "./api-routes-test-helpers.js";
import { join } from "node:path";
import { installApiRouteTestHooks, makeTestDir, request } from "./api-routes-test-helpers.js";
import { normalizeLiveSessionContextEvent } from "../session-context-normalizer.js";
import { SessionBackendDeleteError } from "../session-manager.js";

let app: ApiRouteTestState["app"];
let ctx: ApiRouteTestState["ctx"];
let db: ApiRouteTestState["db"];

installApiRouteTestHooks((state) => {
  ({ app, ctx, db } = state);
});

const SESSION_ID = "11111111-2222-3333-4444-555555555555";
const OTHER_SESSION_ID = "99999999-8888-7777-6666-555555555555";

function countRows(table: string, sessionId: string): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE sessionId = ?`).get(sessionId) as any).count;
}

/** Populate all four session_context_* tables for a session. */
function seedSessionContext(sessionId: string): void {
  const store = ctx.sessionContextStore!;
  store.recordTurnStart({
    sessionId,
    provider: "copilot",
    providerSessionId: `provider-${sessionId}`,
    providerTurnId: `provider-turn-${sessionId}`,
    bridgeTurnId: `turn-${sessionId}`,
    startedAt: "2026-05-01T10:00:00.000Z",
  });
  const event = normalizeLiveSessionContextEvent({
    type: "usage_info",
    id: `usage-${sessionId}`,
    timestamp: "2026-05-01T10:00:01.000Z",
    data: {
      model: "gpt-5.4",
      contextWindow: 100_000,
      tokensUsed: 25_000,
      usage: { inputTokens: 20_000, outputTokens: 100, cacheReadTokens: 4_900 },
    },
  }, {
    sessionId,
    provider: "copilot",
    providerSessionId: `provider-${sessionId}`,
    bridgeTurnId: `turn-${sessionId}`,
  });
  expect(event).not.toBeNull();
  store.recordContextEvent(event!);

  // session_context_backfills has no public writer other than the file backfill,
  // so seed it directly to prove the delete covers all four tables.
  db.prepare(`
    INSERT INTO session_context_backfills (sessionId, provider, providerSessionId, eventsPath, fileSize, mtimeMs, backfilledAt)
    VALUES (?, 'copilot', ?, ?, 10, 1, '2026-05-01T10:00:00.000Z')
  `).run(sessionId, `provider-${sessionId}`, join(makeTestDir("session-context-backfill"), "events.jsonl"));
}

describe("session deletion cleans up every owned subsystem", () => {
  it("removes context rows, defers, and task links for the deleted session only", async () => {
    seedSessionContext(SESSION_ID);
    seedSessionContext(OTHER_SESSION_ID);

    const deferStore = ctx.deferredPromptStore!;
    const loopStore = ctx.deferLoopStore!;

    const activeOnce = deferStore.create(SESSION_ID, "future prompt", "2099-01-01T00:00:00.000Z");
    const terminalOnce = deferStore.create(SESSION_ID, "already ran", "2020-01-01T00:00:00.000Z");
    deferStore.markCompletedById(terminalOnce.id);
    const survivingOnce = deferStore.create(OTHER_SESSION_ID, "other session", "2099-01-01T00:00:00.000Z");

    const activeLoop = loopStore.create({
      sessionId: SESSION_ID,
      prompt: "loop",
      intervalSeconds: 600,
      nextRunAt: "2099-01-01T00:00:00.000Z",
    });
    const terminalLoop = loopStore.create({
      sessionId: SESSION_ID,
      prompt: "finished loop",
      intervalSeconds: 600,
      nextRunAt: "2099-01-01T00:00:00.000Z",
    });
    loopStore.markCompleted(terminalLoop.id);
    const survivingLoop = loopStore.create({
      sessionId: OTHER_SESSION_ID,
      prompt: "other loop",
      intervalSeconds: 600,
      nextRunAt: "2099-01-01T00:00:00.000Z",
    });

    const linkedA = ctx.taskStore.createTask("Linked A");
    const linkedB = ctx.taskStore.createTask("Linked B");
    const unlinked = ctx.taskStore.createTask("Unlinked");
    ctx.taskStore.linkSession(linkedA.id, SESSION_ID);
    ctx.taskStore.linkSession(linkedB.id, SESSION_ID);
    ctx.taskStore.linkSession(unlinked.id, OTHER_SESSION_ID);
    const unlinkedUpdatedAt = ctx.taskStore.getTask(unlinked.id)!.updatedAt;

    const changedTaskIds: string[] = [];
    ctx.globalBus.subscribe((event: any) => {
      if (event.type === "task:changed") changedTaskIds.push(event.taskId);
    });

    const res = await request(app).delete(`/api/sessions/${SESSION_ID}`);
    expect(res.status).toBe(200);

    // All four session_context_* families are gone for the deleted session.
    for (const table of [
      "session_context_summary",
      "session_context_turns",
      "session_context_events",
      "session_context_backfills",
    ]) {
      expect(countRows(table, SESSION_ID)).toBe(0);
      expect(countRows(table, OTHER_SESSION_ID)).toBeGreaterThan(0);
    }

    // Defers — active and terminal — are gone; the other session keeps its own.
    expect(deferStore.get(activeOnce.id)).toBeUndefined();
    expect(deferStore.get(terminalOnce.id)).toBeUndefined();
    expect(deferStore.listForSession(SESSION_ID)).toEqual([]);
    expect(deferStore.get(survivingOnce.id)).toMatchObject({ status: "pending" });

    expect(loopStore.get(activeLoop.id)).toBeUndefined();
    expect(loopStore.get(terminalLoop.id)).toBeUndefined();
    expect(loopStore.listForSession(SESSION_ID)).toEqual([]);
    expect(loopStore.get(survivingLoop.id)).toMatchObject({ status: "active" });

    // Only the linked tasks lost the link, and each emitted exactly one event.
    expect(ctx.taskStore.getTask(linkedA.id)!.sessionIds).not.toContain(SESSION_ID);
    expect(ctx.taskStore.getTask(linkedB.id)!.sessionIds).not.toContain(SESSION_ID);
    expect(ctx.taskStore.getTask(unlinked.id)!.sessionIds).toEqual([OTHER_SESSION_ID]);
    expect(ctx.taskStore.getTask(unlinked.id)!.updatedAt).toBe(unlinkedUpdatedAt);
    expect(changedTaskIds.filter((id) => id === linkedA.id)).toHaveLength(1);
    expect(changedTaskIds.filter((id) => id === linkedB.id)).toHaveLength(1);
    expect(changedTaskIds).not.toContain(unlinked.id);
  });

  it("does not touch any task when the deleted session had no links", async () => {
    const task = ctx.taskStore.createTask("Untouched");
    const updatedAt = ctx.taskStore.getTask(task.id)!.updatedAt;
    const changedTaskIds: string[] = [];
    ctx.globalBus.subscribe((event: any) => {
      if (event.type === "task:changed") changedTaskIds.push(event.taskId);
    });

    await request(app).delete(`/api/sessions/${SESSION_ID}`).expect(200);

    expect(changedTaskIds).toEqual([]);
    expect(ctx.taskStore.getTask(task.id)!.updatedAt).toBe(updatedAt);
  });

  it("still cleans Bridge-owned state when only the backend delete fails", async () => {
    seedSessionContext(SESSION_ID);
    const deferStore = ctx.deferredPromptStore!;
    const prompt = deferStore.create(SESSION_ID, "future", "2099-01-01T00:00:00.000Z");
    const task = ctx.taskStore.createTask("Linked");
    ctx.taskStore.linkSession(task.id, SESSION_ID);

    ctx.sessionManager.deleteSession = async (sessionId: string) => {
      // Local deletion succeeded; only the agent backend rejected.
      throw new SessionBackendDeleteError(sessionId, new Error("permission denied"));
    };

    const res = await request(app).delete(`/api/sessions/${SESSION_ID}`);
    expect(res.status).toBe(500);

    // Owned rows are gone even though the request reported the backend failure.
    expect(countRows("session_context_events", SESSION_ID)).toBe(0);
    expect(deferStore.get(prompt.id)).toBeUndefined();
    expect(ctx.taskStore.getTask(task.id)!.sessionIds).not.toContain(SESSION_ID);
  });

  it("leaves owned state alone when local deletion itself fails", async () => {
    seedSessionContext(SESSION_ID);
    const deferStore = ctx.deferredPromptStore!;
    const prompt = deferStore.create(SESSION_ID, "future", "2099-01-01T00:00:00.000Z");

    ctx.sessionManager.deleteSession = async () => {
      throw new Error("eviction failed before local cleanup");
    };

    const res = await request(app).delete(`/api/sessions/${SESSION_ID}`);
    expect(res.status).toBe(500);

    expect(countRows("session_context_events", SESSION_ID)).toBeGreaterThan(0);
    expect(deferStore.get(prompt.id)).toBeDefined();
  });

  it("rolls back session-context deletion when one table delete fails", () => {
    seedSessionContext(SESSION_ID);
    const store = ctx.sessionContextStore!;
    expect(countRows("session_context_events", SESSION_ID)).toBeGreaterThan(0);

    // Force the final statement in the transaction to fail. Deletes run
    // events → turns → backfills → summary, so dropping the summary table makes
    // the last statement throw after the first three already ran.
    db.exec("DROP TABLE session_context_summary");

    expect(() => store.deleteSessionContext(SESSION_ID)).toThrow();

    // Rolled back: the earlier deletes did not survive the failure.
    expect(countRows("session_context_events", SESSION_ID)).toBeGreaterThan(0);
    expect(countRows("session_context_turns", SESSION_ID)).toBeGreaterThan(0);
    expect(countRows("session_context_backfills", SESSION_ID)).toBe(1);
  });
});
