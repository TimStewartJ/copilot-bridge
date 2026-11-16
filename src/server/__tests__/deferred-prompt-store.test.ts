import { DatabaseSync as NodeDatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import { makeTestDir, setupTestDb } from "./helpers.js";
import { createDeferredPromptStore } from "../deferred-prompt-store.js";
import type { DeferredPromptStore } from "../deferred-prompt-store.js";
import { openDatabase, type DatabaseSync } from "../db.js";
import { createTriggerResultDelivery, parseTriggerResultPrompt, type TriggerDelivery } from "../triggers/messages.js";

/** A result message in the format defers queued before triggers; such rows are still in outboxes. */
function legacyDeferResult(deferId: string, sessionId: string, deliveryId: string, message: string): TriggerDelivery {
  return {
    id: deliveryId,
    sessionId,
    sourceId: deferId,
    prompt: [
      "<deferred-work-result>",
      `deferId: ${deferId}`,
      "kind: interval",
      `deliveryId: ${deliveryId}`,
      "</deferred-work-result>",
      "",
      "A temporary deferred-work session returned this result. Continue from it:",
      "",
      message,
    ].join("\n"),
  };
}

let db: DatabaseSync;
let store: DeferredPromptStore;

beforeEach(() => {
  db = setupTestDb();
  store = createDeferredPromptStore(db);
});

describe("deferred-prompt-store", () => {
  describe("create/get", () => {
    it("lists only the session’s prompts in due order, including user-authored result-like text", () => {
      const t1 = "2030-01-01T00:01:00.000Z";
      const t2 = "2030-01-01T00:02:00.000Z";
      const resultLikeText = store.create("session-A", "<deferred-work-result>\nUser-authored test content.", t2);
      const first = store.create("session-A", "First", t1);
      store.create("session-B", "Other", t1);

      expect(store.listForSession("session-A")).toEqual([first, resultLikeText]);
      expect(first).toMatchObject({ prompt: "First", sessionId: "session-A", runAt: t1, status: "pending", attempts: 0 });
      expect(first.claimToken).toBeUndefined();

      expect(store.listDeliveriesForSession("session-A")).toEqual([]);
    });

    it("recognizes results queued by defers before triggers", () => {
      const legacy = legacyDeferResult("interval_1", "session-A", "delivery-1", "Still waiting.");
      expect(parseTriggerResultPrompt(legacy.prompt)).toEqual({ triggerId: "1", deliveryId: "delivery-1", continues: false });
      const current = createTriggerResultDelivery({ triggerId: "1", parentSessionId: "session-A" }, "Still waiting.", { deliveryId: "delivery-2", continues: true });
      expect(parseTriggerResultPrompt(current.prompt)).toEqual({ triggerId: "1", deliveryId: "delivery-2", continues: true });
    });
    it("keeps parent deliveries out of restart notices and their cancellation", () => {
      const delivery = store.enqueueDelivery(createTriggerResultDelivery(
        { triggerId: "1", parentSessionId: "session-A" },
        "Build completed.",
        { deliveryId: "delivery-1" },
      ));

      expect(store.listForSession("session-A")).toEqual([]);
      expect(store.listDeliveriesForSession("session-A")).toEqual([delivery]);
      expect(store.cancelForSession("session-A")).toBe(0);
      expect(store.get(delivery.id)?.status).toBe("pending");

      const claimed = store.claimDue(delivery.id, 60_000)!;
      expect(store.fail(delivery.id, "Parent unavailable", { claimToken: claimed.claimToken })).toBe(true);
      expect(store.reactivateFailedDeliveryForSource("session-A", "trigger:1")).toBe(1);
      expect(store.get(delivery.id)).toMatchObject({
        status: "pending",
        attempts: 0,
        lastError: undefined,
      });
    });
  });

  describe("listDue", () => {

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
        const delivery = legacyDeferResult("interval_1", "session-1", "delivery-1", "Done.");
        const overlappingDelivery = legacyDeferResult("interval_2", "session-2", "overlapping-delivery", "Still pending.");
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
        expect(parseTriggerResultPrompt(migratedDelivery.prompt)?.deliveryId)
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

  describe("getNextWakeAt", () => {
    it("returns the due work now and the earliest wake for the remaining prompts", () => {
      const now = "2030-01-01T00:00:00.000Z";
      expect(store.getNextWakeAt(now)).toBeUndefined();
      const due = store.create("s1", "Due", "2029-12-31T23:59:00.000Z");
      store.create("s1", "B", "2030-01-01T00:02:00.000Z");
      store.create("s1", "A", "2030-01-01T00:01:00.000Z");
      expect(store.listDue(now).map((prompt) => prompt.id)).toEqual([due.id]);
      expect(store.getNextWakeAt(now)).toBe("2030-01-01T00:01:00.000Z");
    });

    it("returns a running lease expiry that comes before the next due time", () => {
      const first = store.create("s1", "First", new Date().toISOString());
      const second = store.create("s2", "Second", new Date().toISOString());
      store.create("s3", "Later", new Date(Date.now() + 600_000).toISOString());

      store.claimDue(second.id, 120_000);
      store.claimDue(first.id, 60_000);

      expect(store.getNextWakeAt()).toBe(store.get(first.id)!.leaseExpiresAt);
    });
  });

  describe("claimDue / CAS semantics", () => {
    it("holds one claim, renews its lease and cancels the running prompt", () => {
      const prompt = store.create("s1", "Prompt", new Date().toISOString());
      const claim = store.claimDue(prompt.id, 60_000)!;
      expect(claim.claimToken).toBeTruthy();
      expect(claim.prompt).toMatchObject({ status: "running", attempts: 1 });
      expect(store.claimDue(prompt.id, 60_000)).toBeUndefined();
      expect(store.renewClaim(prompt.id, claim.claimToken, 120_000)).toBe(true);
      expect(Date.parse(store.get(prompt.id)!.leaseExpiresAt!)).toBeGreaterThan(Date.parse(claim.prompt.leaseExpiresAt!));
      expect(store.cancelById(prompt.id)).toBe(true);
      expect(store.get(prompt.id)?.status).toBe("cancelled");
    });
  });

  describe("complete", () => {
    it("returns false with wrong token (complete, fail, release, renewClaim)", () => {
      const dp1 = store.create("s1", "Prompt1", new Date().toISOString());
      store.claimDue(dp1.id, 60_000);
      expect(store.complete(dp1.id, { claimToken: "wrong-token" }), "complete wrong token").toBe(false);

      const dp2 = store.create("s1", "Prompt2", new Date().toISOString());
      store.claimDue(dp2.id, 60_000);
      expect(store.fail(dp2.id, "err", { claimToken: "bad" }), "fail wrong token").toBe(false);

      const dp3 = store.create("s1", "Prompt3", new Date().toISOString());
      store.claimDue(dp3.id, 60_000);
      expect(store.release(dp3.id, "wrong", { retryAt: new Date().toISOString() }), "retry wrong token").toBe(false);
      expect(store.release(dp3.id, "wrong"), "wait wrong token").toBe(false);
      expect(store.get(dp3.id)).toMatchObject({ status: "running", attempts: 1 });

      // renewClaim: wrong token returns false and does not extend lease
      const dp4 = store.create("s1", "Prompt4", new Date().toISOString());
      store.claimDue(dp4.id, 60_000);
      const firstLease = store.get(dp4.id)!.leaseExpiresAt;
      expect(store.renewClaim(dp4.id, "wrong-token", 120_000), "renewClaim wrong token").toBe(false);
      expect(store.get(dp4.id)!.leaseExpiresAt).toBe(firstLease);
    });

    it("can mark a pending prompt completed after delivery has already been accepted", () => {
      const dp = store.create("s1", "Prompt", new Date().toISOString());
      expect(store.complete(dp.id)).toBe(true);
      expect(store.get(dp.id)!.status).toBe("completed");
    });
  });

  describe("release", () => {
    it("re-queues a running prompt at retryAt and keeps the try counted", () => {
      const dp = store.create("s1", "Prompt", new Date().toISOString());
      const claimed = store.claimDue(dp.id, 60_000)!;
      const retryAt = new Date(Date.now() + 5_000).toISOString();
      expect(store.release(dp.id, claimed.claimToken, { retryAt, error: "worker failed" })).toBe(true);
      expect(store.get(dp.id)).toMatchObject({
        status: "pending",
        runAt: retryAt,
        attempts: 1,
        lastError: "worker failed",
      });
    });

    it("without retryAt gives the try back and leaves the prompt due", () => {
      const dp = store.create("s1", "Prompt", new Date().toISOString());
      const claimed = store.claimDue(dp.id, 60_000)!;

      expect(store.release(dp.id, claimed.claimToken, { error: "No free context" })).toBe(true);

      const updated = store.get(dp.id)!;
      expect(updated.status).toBe("pending");
      expect(updated.attempts).toBe(0);
      expect(updated.runAt).toBe(dp.runAt);
      expect(updated.lastError).toBe("No free context");
      expect(updated.claimToken).toBeUndefined();
      expect(updated.leaseExpiresAt).toBeUndefined();
    });
  });

  describe("retireUndeliveredFinalMessagesForSource", () => {
    it("withdraws a restarted trigger's final messages, waiting or failed, and keeps its updates", () => {
      const source = { triggerId: "loop", parentSessionId: "s1" };
      const waitingFinal = store.enqueueDelivery(createTriggerResultDelivery(
        source, "FINAL TRIGGER RESULT: Monitoring expired.", { deliveryId: "waiting-final" },
      ));
      const failedFinal = store.enqueueDelivery(createTriggerResultDelivery(
        source, "FINAL TRIGGER RESULT: Monitoring expired.", { deliveryId: "failed-final" },
      ));
      store.fail(failedFinal.id, "Parent chat could not be resumed");
      const failedUpdate = store.enqueueDelivery(createTriggerResultDelivery(
        source, "Build 123 turned red.", { deliveryId: "failed-update", continues: true },
      ));
      store.fail(failedUpdate.id, "Parent chat could not be resumed");
      const delivered = store.enqueueDelivery(createTriggerResultDelivery(
        source, "FINAL TRIGGER RESULT: an earlier round.", { deliveryId: "delivered-final" },
      ));
      store.complete(delivered.id);
      const otherTrigger = store.enqueueDelivery(createTriggerResultDelivery(
        { ...source, triggerId: "other" }, "FINAL TRIGGER RESULT: other.", { deliveryId: "other-final" },
      ));

      expect(store.retireUndeliveredFinalMessagesForSource("s1", "trigger:loop")).toBe(2);

      expect(store.get(waitingFinal.id)?.status).toBe("cancelled");
      expect(store.get(failedFinal.id)?.status).toBe("cancelled");
      expect(store.get(failedUpdate.id)?.status).toBe("failed");
      expect(store.get(delivered.id)?.status).toBe("completed");
      expect(store.get(otherTrigger.id)?.status).toBe("pending");
      // The update can still be sent again.
      expect(store.reactivateFailedDeliveryForSource("s1", "trigger:loop")).toBe(1);
    });
  });

  describe("noteWait", () => {
    it("records why a pending prompt is waiting, and only on pending rows", () => {
      const pending = store.create("s1", "Pending", new Date().toISOString());
      const running = store.create("s2", "Running", new Date().toISOString());
      store.claimDue(running.id, 60_000);

      store.noteWait(pending.id, "No free context");
      store.noteWait(running.id, "No free context");

      expect(store.get(pending.id)).toMatchObject({ status: "pending", lastError: "No free context" });
      expect(store.get(running.id)!.lastError).toBeUndefined();
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
      expect(reclaimed).toEqual(["s1"]);
      expect(store.get(dp.id)).toMatchObject({
        status: "pending",
        attempts: 1,
        lastError: "Deferred execution lease expired before completion.",
      });
      expect(store.reclaimExpiredRunning(expiredNow)).toEqual([]);
      // suppress unused variable warning
      void claimed;
    });
  });
});
