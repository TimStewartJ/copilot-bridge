import { describe, it, expect, beforeEach } from "vitest";
import { setupTestDb } from "./helpers.js";
import { createDeferredPromptStore } from "../deferred-prompt-store.js";
import type { DeferredPromptStore } from "../deferred-prompt-store.js";
import type { DatabaseSync } from "../db.js";

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

    it("get returns undefined for unknown id", () => {
      expect(store.get("does-not-exist")).toBeUndefined();
    });

    it("get returns the created row", () => {
      const dp = store.create("session-1", "Test", new Date().toISOString());
      const fetched = store.get(dp.id);
      expect(fetched).toBeDefined();
      expect(fetched!.id).toBe(dp.id);
    });
  });

  describe("listForSession", () => {
    it("returns empty for session with no prompts", () => {
      expect(store.listForSession("none")).toEqual([]);
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

    it("returns empty when nothing is due", () => {
      store.create("s1", "Future", new Date(Date.now() + 60_000).toISOString());
      expect(store.listDue()).toHaveLength(0);
    });
  });

  describe("getNextPending", () => {
    it("returns undefined when no pending rows", () => {
      expect(store.getNextPending()).toBeUndefined();
    });

    it("returns the earliest pending row", () => {
      const t1 = "2030-01-01T00:01:00.000Z";
      const t2 = "2030-01-01T00:02:00.000Z";
      store.create("s1", "B", t2);
      const a = store.create("s1", "A", t1);
      const next = store.getNextPending();
      expect(next?.id).toBe(a.id);
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

    it("claim on non-existent row fails", () => {
      expect(store.claimDue("bogus-id", 60_000)).toBeUndefined();
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

    it("returns false with wrong token", () => {
      const dp = store.create("s1", "Prompt", new Date().toISOString());
      store.claimDue(dp.id, 60_000);
      expect(store.markCompleted(dp.id, "wrong-token")).toBe(false);
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

    it("returns false with wrong token", () => {
      const dp = store.create("s1", "Prompt", new Date().toISOString());
      store.claimDue(dp.id, 60_000);
      expect(store.markFailed(dp.id, "bad", "err")).toBe(false);
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

    it("returns false with wrong token", () => {
      const dp = store.create("s1", "Prompt", new Date().toISOString());
      store.claimDue(dp.id, 60_000);
      expect(store.retry(dp.id, "wrong", new Date().toISOString())).toBe(false);
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

    it("does not renew without the matching token", () => {
      const dp = store.create("s1", "Prompt", new Date().toISOString());
      store.claimDue(dp.id, 60_000);
      const firstLease = store.get(dp.id)!.leaseExpiresAt;

      expect(store.renewClaim(dp.id, "wrong-token", 120_000)).toBe(false);
      expect(store.get(dp.id)!.leaseExpiresAt).toBe(firstLease);
    });
  });

  describe("cancelById", () => {
    it("cancels a pending prompt", () => {
      const dp = store.create("s1", "Prompt", new Date().toISOString());
      expect(store.cancelById(dp.id)).toBe(true);
      expect(store.get(dp.id)!.status).toBe("cancelled");
    });

    it("does not cancel a running prompt", () => {
      const dp = store.create("s1", "Prompt", new Date().toISOString());
      store.claimDue(dp.id, 60_000);
      expect(store.cancelById(dp.id)).toBe(false);
      expect(store.get(dp.id)!.status).toBe("running");
    });

    it("returns false for unknown id", () => {
      expect(store.cancelById("nope")).toBe(false);
    });
  });

  describe("cancelForSession", () => {
    it("cancels all pending deferrals for a session without cancelling running deliveries", () => {
      const dp1 = store.create("s1", "A", new Date().toISOString());
      const dp2 = store.create("s1", "B", new Date().toISOString());
      const running = store.create("s1", "Running", new Date().toISOString());
      store.claimDue(running.id, 60_000);
      store.create("s2", "Other", new Date().toISOString());
      const count = store.cancelForSession("s1");
      expect(count).toBe(2);
      expect(store.get(dp1.id)!.status).toBe("cancelled");
      expect(store.get(dp2.id)!.status).toBe("cancelled");
      expect(store.get(running.id)!.status).toBe("running");
    });

    it("returns 0 when no rows match", () => {
      expect(store.cancelForSession("no-session")).toBe(0);
    });
  });

  describe("reclaimExpiredRunning", () => {
    it("moves expired running rows back to pending", () => {
      const dp = store.create("s1", "Prompt", new Date().toISOString());
      // Claim with a lease that already expired
      const claimed = store.claimDue(dp.id, 1)!; // 1ms lease
      // Wait a tick so leaseExpiresAt is in the past
      const expiredNow = new Date(Date.now() + 10).toISOString();
      const reclaimed = store.reclaimExpiredRunning(expiredNow);
      expect(reclaimed).toBe(1);
      expect(store.get(dp.id)!.status).toBe("pending");
      // suppress unused variable warning
      void claimed;
    });

    it("does not reclaim rows with valid leases", () => {
      const dp = store.create("s1", "Prompt", new Date().toISOString());
      store.claimDue(dp.id, 60_000); // long lease
      expect(store.reclaimExpiredRunning()).toBe(0);
    });
  });
});
