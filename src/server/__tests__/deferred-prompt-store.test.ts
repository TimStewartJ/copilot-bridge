import { DatabaseSync as NodeDatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import { makeTestDir, setupTestDb } from "./helpers.js";
import { createDeferredPromptStore } from "../deferred-prompt-store.js";
import type { DeferredPromptStore } from "../deferred-prompt-store.js";
import { openDatabase, type DatabaseSync } from "../db.js";
import {
  createReturnedDeferDelivery,
  parseReturnedDeferPrompt,
} from "../defer-result-message.js";

let db: DatabaseSync;
let store: DeferredPromptStore;

beforeEach(() => {
  db = setupTestDb();
  store = createDeferredPromptStore(db);
});

describe("deferred-prompt-store", () => {
  describe("create/get", () => {
    it("creates a pending prompt and retrieves it", () => {
      const runAt = new Date(Date.now() + 60_000).toISOString();
      const dp = store.create("session-1", "Hello world", runAt);
      expect(dp.id).toBeTruthy();
      expect(dp.sessionId).toBe("session-1");
      expect(dp.prompt).toBe("Hello world");
      expect(dp.runAt).toBe(runAt);
      expect(dp.status).toBe("pending");
      expect(dp.attempts).toBe(0);
      expect(dp.claimToken).toBeUndefined();
    });

    it("returns only prompts for the given session, ordered by runAt", () => {
      const t1 = "2030-01-01T00:01:00.000Z";
      const t2 = "2030-01-01T00:02:00.000Z";
      store.create("session-A", "First", t1);
      store.create("session-A", "Second", t2);
      store.create("session-B", "Other", t1);
      const results = store.listForSession("session-A");
      expect(results).toHaveLength(2);
      expect(results[0].prompt).toBe("First");
      expect(results[1].prompt).toBe("Second");
    });

    it("does not classify user-authored result-like text as a delivery", () => {
      const prompt = store.create(
        "session-A",
        "<deferred-work-result>\nUser-authored test content.",
        "2030-01-01T00:01:00.000Z",
      );
      expect(store.listForSession("session-A")).toEqual([prompt]);
      expect(store.listDeliveriesForSession("session-A")).toEqual([]);
    });

    it("keeps parent deliveries out of defer summaries and cancellation", () => {
      const delivery = store.enqueueDelivery(createReturnedDeferDelivery(
        { deferId: "interval_1", kind: "interval", parentSessionId: "session-A" },
        "Build completed.",
        { deliveryId: "delivery-1" },
      ));

      expect(store.listForSession("session-A")).toEqual([]);
      expect(store.listDeliveriesForSession("session-A")).toEqual([delivery]);
      expect(store.getSummaryForSession("session-A")).toEqual({ count: 0, nextRunAt: null });
      expect(store.cancelForSession("session-A")).toBe(0);
      expect(store.get(delivery.id)?.status).toBe("pending");

      const claimed = store.claimDue(delivery.id, 60_000)!;
      expect(store.markFailed(delivery.id, claimed.claimToken, "Parent unavailable")).toBe(true);
      expect(store.reactivateFailedDeliveryForSource("session-A", "interval_1")).toBe(1);
      expect(store.get(delivery.id)).toMatchObject({
        status: "pending",
        attempts: 0,
        lastError: undefined,
      });
    });
  });

  describe("listDue", () => {
    it("returns only pending rows with runAt <= now", () => {
      const past = new Date(Date.now() - 1000).toISOString();
      const future = new Date(Date.now() + 60_000).toISOString();
      const dp1 = store.create("s1", "Past", past);
      store.create("s1", "Future", future);
      const due = store.listDue();
      expect(due.map((d) => d.id)).toContain(dp1.id);
      expect(due.every((d) => d.runAt <= new Date().toISOString())).toBe(true);
    });

    describe("deferred delivery migration", () => {
      it("moves the deployed outbox table into the shared deferred prompt queue", () => {
        const dataDir = makeTestDir("deferred-delivery-migration");
        const legacy = new NodeDatabaseSync(join(dataDir, "bridge.db"));
        legacy.exec(`
          CREATE TABLE deferred_prompts (
            id TEXT PRIMARY KEY,
            sessionId TEXT NOT NULL,
            prompt TEXT NOT NULL,
            runAt TEXT NOT NULL,
            status TEXT NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            claimToken TEXT,
            leaseExpiresAt TEXT,
            createdAt TEXT NOT NULL,
            updatedAt TEXT NOT NULL,
            lastError TEXT
          );
          CREATE TABLE session_message_outbox (
            id TEXT PRIMARY KEY,
            sessionId TEXT NOT NULL,
            prompt TEXT NOT NULL,
            source TEXT NOT NULL,
            sourceId TEXT,
            availableAt TEXT NOT NULL,
            status TEXT NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            claimToken TEXT,
            leaseExpiresAt TEXT,
            createdAt TEXT NOT NULL,
            updatedAt TEXT NOT NULL,
            lastError TEXT
          )
        `);
        legacy.prepare(`
          INSERT INTO deferred_prompts
            (id, sessionId, prompt, runAt, status, createdAt, updatedAt)
          VALUES ('delivery-1', 'session-source', 'Scheduled work',
                  '2026-09-03T00:00:00.000Z', 'pending',
                  '2026-09-03T00:00:00.000Z', '2026-09-03T00:00:00.000Z')
        `).run();
        const delivery = createReturnedDeferDelivery(
          { deferId: "interval_1", kind: "interval", parentSessionId: "session-1" },
          "Done.",
          { deliveryId: "delivery-1" },
        );
        const overlappingDelivery = createReturnedDeferDelivery(
          { deferId: "interval_2", kind: "interval", parentSessionId: "session-2" },
          "Still pending.",
          { deliveryId: "overlapping-delivery" },
        );
        legacy.prepare(`
          INSERT INTO deferred_prompts
            (id, sessionId, prompt, runAt, status, createdAt, updatedAt)
          VALUES (?, ?, ?, '2026-09-03T00:00:00.000Z', 'completed',
                  '2026-09-03T00:00:00.000Z', '2026-09-03T00:00:00.000Z')
        `).run(
          overlappingDelivery.id,
          overlappingDelivery.sessionId,
          overlappingDelivery.prompt,
        );
        legacy.prepare(`
          INSERT INTO session_message_outbox
            (id, sessionId, prompt, source, sourceId, availableAt, status, attempts,
             createdAt, updatedAt)
          VALUES (?, ?, ?, 'defer_result', 'interval_1', ?, 'pending', 0, ?, ?)
        `).run(
          delivery.id,
          delivery.sessionId,
          delivery.prompt,
          "2026-09-03T00:00:00.000Z",
          "2026-09-03T00:00:00.000Z",
          "2026-09-03T00:00:00.000Z",
        );
        legacy.prepare(`
          INSERT INTO session_message_outbox
            (id, sessionId, prompt, source, sourceId, availableAt, status, attempts,
             createdAt, updatedAt)
          VALUES (?, ?, ?, 'defer_result', 'interval_2', ?, 'pending', 0, ?, ?)
        `).run(
          overlappingDelivery.id,
          overlappingDelivery.sessionId,
          overlappingDelivery.prompt,
          "2026-09-03T00:00:00.000Z",
          "2026-09-03T00:00:00.000Z",
          "2026-09-03T00:00:00.000Z",
        );
        legacy.close();

        const migrated = openDatabase(dataDir);
        const migratedStore = createDeferredPromptStore(migrated);
        expect(migratedStore.listDeliveriesForSession("session-1")).toEqual([
          expect.objectContaining({
            status: "pending",
            sourceId: "interval_1",
          }),
        ]);
        const migratedDelivery = migratedStore.listDeliveriesForSession("session-1")[0]!;
        expect(migratedDelivery.id).not.toBe("delivery-1");
        expect(parseReturnedDeferPrompt(migratedDelivery.prompt)?.deliveryId)
          .toBe(migratedDelivery.id);
        expect(migratedStore.get("delivery-1")).toMatchObject({
          sessionId: "session-source",
          purpose: "defer",
        });
        expect(migratedStore.get(overlappingDelivery.id)).toMatchObject({
          purpose: "delivery",
          sourceId: "interval_2",
          status: "pending",
        });
        expect(migrated.prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_message_outbox'",
        ).get()).toBeUndefined();
        migrated.close();

        const reopened = openDatabase(dataDir);
        expect(createDeferredPromptStore(reopened).get(migratedDelivery.id)?.status).toBe("pending");
        reopened.close();
      });
    });

  });

  describe("getNextPending", () => {
    it("returns the earliest pending row", () => {
      const t1 = "2030-01-01T00:01:00.000Z";
      const t2 = "2030-01-01T00:02:00.000Z";
      store.create("s1", "B", t2);
      const a = store.create("s1", "A", t1);
      const next = store.getNextPending();
      expect(next?.id).toBe(a.id);
    });
  });

  describe("getSummaryForSession", () => {
    it("counts pending prompts for a session and returns the earliest run time", () => {
      const earliest = "2030-01-01T00:01:00.000Z";
      const later = "2030-01-01T00:02:00.000Z";
      const runningAt = "2030-01-01T00:00:30.000Z";
      store.create("session-1", "Later", later);
      store.create("session-1", "Earliest", earliest);
      const running = store.create("session-1", "Running", runningAt);
      store.claimDue(running.id, 60_000);
      store.create("session-2", "Other", "2030-01-01T00:00:00.000Z");

      expect(store.getSummaryForSession("session-1")).toEqual({
        count: 2,
        nextRunAt: earliest,
      });
      expect(store.getSummaryForSession("missing-session")).toEqual({
        count: 0,
        nextRunAt: null,
      });
    });
  });

  describe("listSummariesBySession", () => {
    it("matches the per-session summary for every session with pending work in one query", () => {
      const earliest = "2030-01-01T00:01:00.000Z";
      const later = "2030-01-01T00:02:00.000Z";
      store.create("session-1", "Later", later);
      store.create("session-1", "Earliest", earliest);
      const running = store.create("session-1", "Running", "2030-01-01T00:00:30.000Z");
      store.claimDue(running.id, 60_000);
      store.create("session-2", "Other", "2030-01-01T00:00:00.000Z");
      const completed = store.create("session-3", "Done", "2030-01-01T00:00:00.000Z");
      const claimed = store.claimDue(completed.id, 60_000);
      store.markCompleted(completed.id, claimed!.claimToken);

      const summaries = store.listSummariesBySession();
      expect(summaries.get("session-1")).toEqual(store.getSummaryForSession("session-1"));
      expect(summaries.get("session-1")).toEqual({ count: 2, nextRunAt: earliest });
      expect(summaries.get("session-2")).toEqual({ count: 1, nextRunAt: "2030-01-01T00:00:00.000Z" });
      expect(summaries.has("session-3")).toBe(false);
      expect(summaries.has("missing-session")).toBe(false);
    });
  });

  describe("claimDue / CAS semantics", () => {
    it("claims a pending row and returns claimToken", () => {
      const dp = store.create("s1", "Prompt", new Date().toISOString());
      const claimed = store.claimDue(dp.id, 60_000);
      expect(claimed).toBeDefined();
      expect(claimed!.claimToken).toBeTruthy();
      expect(claimed!.prompt.status).toBe("running");
      expect(claimed!.prompt.attempts).toBe(1);
    });

    it("second claim on same row fails (CAS)", () => {
      const dp = store.create("s1", "Prompt", new Date().toISOString());
      store.claimDue(dp.id, 60_000);
      const second = store.claimDue(dp.id, 60_000);
      expect(second).toBeUndefined();
    });

    it("returns the running prompt with the earliest lease expiry", () => {
      const first = store.create("s1", "First", new Date().toISOString());
      const second = store.create("s2", "Second", new Date().toISOString());

      store.claimDue(second.id, 120_000);
      store.claimDue(first.id, 60_000);

      expect(store.getNextRunningLeaseExpiry()?.id).toBe(first.id);
    });
  });

  describe("markCompleted", () => {
    it("marks running prompt completed with correct token", () => {
      const dp = store.create("s1", "Prompt", new Date().toISOString());
      const claimed = store.claimDue(dp.id, 60_000)!;
      expect(store.markCompleted(dp.id, claimed.claimToken)).toBe(true);
      const row = store.get(dp.id)!;
      expect(row.status).toBe("completed");
    });

    it("returns false with wrong token (markCompleted, markFailed, retry, renewClaim)", () => {
      // markCompleted: wrong token returns false
      const dp1 = store.create("s1", "Prompt1", new Date().toISOString());
      store.claimDue(dp1.id, 60_000);
      expect(store.markCompleted(dp1.id, "wrong-token"), "markCompleted wrong token").toBe(false);

      // markFailed: wrong token returns false
      const dp2 = store.create("s1", "Prompt2", new Date().toISOString());
      store.claimDue(dp2.id, 60_000);
      expect(store.markFailed(dp2.id, "bad", "err"), "markFailed wrong token").toBe(false);

      // retry: wrong token returns false
      const dp3 = store.create("s1", "Prompt3", new Date().toISOString());
      store.claimDue(dp3.id, 60_000);
      expect(store.retry(dp3.id, "wrong", new Date().toISOString()), "retry wrong token").toBe(false);

      // renewClaim: wrong token returns false and does not extend lease
      const dp4 = store.create("s1", "Prompt4", new Date().toISOString());
      store.claimDue(dp4.id, 60_000);
      const firstLease = store.get(dp4.id)!.leaseExpiresAt;
      expect(store.renewClaim(dp4.id, "wrong-token", 120_000), "renewClaim wrong token").toBe(false);
      expect(store.get(dp4.id)!.leaseExpiresAt).toBe(firstLease);
    });

    it("can mark a pending prompt completed after delivery has already been accepted", () => {
      const dp = store.create("s1", "Prompt", new Date().toISOString());
      expect(store.markCompletedById(dp.id)).toBe(true);
      expect(store.get(dp.id)!.status).toBe("completed");
    });
  });

  describe("markFailed", () => {
    it("marks running prompt failed and records lastError", () => {
      const dp = store.create("s1", "Prompt", new Date().toISOString());
      const claimed = store.claimDue(dp.id, 60_000)!;
      store.markFailed(dp.id, claimed.claimToken, "Oops");
      const row = store.get(dp.id)!;
      expect(row.status).toBe("failed");
      expect(row.lastError).toBe("Oops");
    });

    it("marks a claimed deferral failed and queues its parent message atomically", () => {
      const dp = store.create("s1", "Prompt", new Date().toISOString());
      const claimed = store.claimDue(dp.id, 60_000)!;
      const delivery = createReturnedDeferDelivery(
        { deferId: dp.deferId, kind: "once", parentSessionId: dp.sessionId },
        "The one-shot defer stopped.",
        { deliveryId: "failure-delivery" },
      );

      expect(store.failWithMessage(dp.id, "wrong", delivery, {
        claimToken: "wrong-token",
      })).toBe(false);
      expect(store.listDeliveriesForSession(dp.sessionId)).toEqual([]);

      expect(store.failWithMessage(dp.id, "worker failed", delivery, {
        claimToken: claimed.claimToken,
      })).toBe(true);
      expect(store.get(dp.id)).toMatchObject({
        status: "failed",
        attempts: 1,
        lastError: "worker failed",
      });
      expect(store.listDeliveriesForSession(dp.sessionId)).toEqual([
        expect.objectContaining({ id: delivery.id, sourceId: dp.deferId }),
      ]);
    });
  });

  describe("retry", () => {
    it("re-queues a running prompt with new runAt", () => {
      const dp = store.create("s1", "Prompt", new Date().toISOString());
      const claimed = store.claimDue(dp.id, 60_000)!;
      const retryAt = new Date(Date.now() + 5_000).toISOString();
      expect(store.retry(dp.id, claimed.claimToken, retryAt)).toBe(true);
      const row = store.get(dp.id)!;
      expect(row.status).toBe("pending");
      expect(row.runAt).toBe(retryAt);
    });

  });

  describe("releaseClaimWithoutAttempt", () => {
    it("re-queues a running prompt and restores the attempt count", () => {
      const dp = store.create("s1", "Prompt", new Date().toISOString());
      const claimed = store.claimDue(dp.id, 60_000)!;

      expect(store.releaseClaimWithoutAttempt(dp.id, claimed.claimToken)).toBe(true);

      const updated = store.get(dp.id)!;
      expect(updated.status).toBe("pending");
      expect(updated.attempts).toBe(0);
      expect(updated.claimToken).toBeUndefined();
      expect(updated.leaseExpiresAt).toBeUndefined();
    });

    it("requires the matching claim token", () => {
      const dp = store.create("s1", "Prompt", new Date().toISOString());
      store.claimDue(dp.id, 60_000);
      expect(store.releaseClaimWithoutAttempt(dp.id, "wrong-token")).toBe(false);
      expect(store.get(dp.id)!.status).toBe("running");
      expect(store.get(dp.id)!.attempts).toBe(1);
    });
  });

  describe("renewClaim", () => {
    it("extends a running prompt lease with the matching token", () => {
      const dp = store.create("s1", "Prompt", new Date().toISOString());
      const claimed = store.claimDue(dp.id, 60_000)!;
      const firstLease = Date.parse(store.get(dp.id)!.leaseExpiresAt!);

      expect(store.renewClaim(dp.id, claimed.claimToken, 120_000)).toBe(true);
      expect(Date.parse(store.get(dp.id)!.leaseExpiresAt!)).toBeGreaterThan(firstLease);
    });

  });

  describe("cancelById", () => {
    it("cancels a pending prompt", () => {
      const dp = store.create("s1", "Prompt", new Date().toISOString());
      expect(store.cancelById(dp.id)).toBe(true);
      expect(store.get(dp.id)!.status).toBe("cancelled");
    });

    it("cancels a running prompt", () => {
      const dp = store.create("s1", "Prompt", new Date().toISOString());
      store.claimDue(dp.id, 60_000);
      expect(store.cancelById(dp.id)).toBe(true);
      expect(store.get(dp.id)!.status).toBe("cancelled");
    });

  });

  describe("cancelForSession", () => {
    it("cancels all pending and running deferrals for a session", () => {
      const dp1 = store.create("s1", "A", new Date().toISOString());
      const dp2 = store.create("s1", "B", new Date().toISOString());
      const running = store.create("s1", "Running", new Date().toISOString());
      store.claimDue(running.id, 60_000);
      store.create("s2", "Other", new Date().toISOString());
      const count = store.cancelForSession("s1");
      expect(count).toBe(3);
      expect(store.get(dp1.id)!.status).toBe("cancelled");
      expect(store.get(dp2.id)!.status).toBe("cancelled");
      expect(store.get(running.id)!.status).toBe("cancelled");
    });

  });

  describe("reclaimExpiredRunning", () => {
    it("moves expired running rows back to pending with an interruption error", () => {
      const dp = store.create("s1", "Prompt", new Date().toISOString());
      // Claim with a lease that already expired
      const claimed = store.claimDue(dp.id, 1)!; // 1ms lease
      // Wait a tick so leaseExpiresAt is in the past
      const expiredNow = new Date(Date.now() + 10).toISOString();
      const reclaimed = store.reclaimExpiredRunning(expiredNow);
      expect(reclaimed).toBe(1);
      expect(store.get(dp.id)).toMatchObject({
        status: "pending",
        lastError: "Deferred execution lease expired before completion.",
      });
      // suppress unused variable warning
      void claimed;
    });

  });
});
