import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "../db.js";
import { createFocusNotificationDeliveryStore } from "../focus-notification-delivery-store.js";
import { setupTestDb } from "./helpers.js";

let db: DatabaseSync;
beforeEach(() => { db = setupTestDb(); });
afterEach(() => { db.close(); });

describe("durable needs-input summary coverage", () => {
  it.each([
    { label: "thrown", outcome: { attempted: 0, sent: 0, failed: 0, pruned: 0 }, error: "Transport unavailable" },
    { label: "empty", outcome: { attempted: 0, sent: 0, failed: 0, pruned: 0 }, error: undefined },
    { label: "partial", outcome: { attempted: 2, sent: 1, failed: 1, pruned: 0 }, error: undefined },
  ])("releases session coverage after a $label failure without replaying the summary claim", ({ outcome, error }) => {
    const store = createFocusNotificationDeliveryStore(db);
    const identity = { objectId: "window", activationId: "window", reason: "protected-needs-input" };
    const claimed = store.claim(identity, null, Date.now(), {
      sessionIds: ["waiting"], pendingSessionIds: ["waiting"],
    })!;
    expect(store.reconcileSessionCoverage(identity.reason, ["waiting"])).toEqual(["waiting"]);
    expect(store.claim(identity, null)).toBeUndefined();
    expect(store.finish(claimed, outcome, error)).toBe(true);
    expect(store.get(identity)?.status).toBe("failed");
    expect(store.reconcileSessionCoverage(identity.reason, ["waiting"])).toEqual([]);
    const restarted = createFocusNotificationDeliveryStore(db);
    expect(restarted.reconcileSessionCoverage(identity.reason, ["waiting"])).toEqual([]);
    expect(restarted.claim(identity, null)).toBeUndefined();
    expect(restarted.pending(100, identity.reason)).toEqual([]);
    expect(JSON.parse(restarted.get(identity)!.outcomeJson!)).toMatchObject({
      sessionIds: ["waiting"], ...outcome,
    });
  });
});
