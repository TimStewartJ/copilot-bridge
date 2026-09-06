import { describe, expect, it } from "vitest";
import { createFocusProtectionStore, initializeFocusProtectionSchema } from "../focus-protection-store.js";
import { createTestBus, setupTestDb } from "./helpers.js";

describe("Focus protection row hydration", () => {
  it("retains request telemetry and hydrates pending and settled hold projections", () => {
    const db = setupTestDb();
    initializeFocusProtectionSchema(db);
    const store = createFocusProtectionStore(db, createTestBus());
    const request = {
      endsAt: new Date(Date.now() + 60_000).toISOString(),
      timezone: "UTC",
      reason: "Protect focused work",
      allowNeedsInput: true,
      allowAuthorizedDeadlineOverride: false,
    };
    const window = store.create(request);
    const telemetry = db.prepare(`SELECT detailsJson FROM focus_attention_events
      WHERE eventType='protection_created' AND objectId=?`).get(window.id);
    expect(telemetry).toBeDefined();
    expect(JSON.parse(String(telemetry!.detailsJson))).toEqual(request);

    const work = { kind: "schedule" as const, workId: "scheduled-work", scheduledFor: new Date().toISOString() };
    expect(store.hold(window, work)).toBe(true);
    const [held] = store.outstanding("schedule");
    expect(held).toEqual({
      ...work, id: expect.any(String), windowId: window.id, endsAt: window.endsAt, createdAt: expect.any(String),
    });
    expect(store.impacts(window.id)).toEqual({
      postponed: 1, pending: 1, dispositions: {},
      recent: [{ ...held, disposition: null, settledAt: null }],
    });

    store.settle(work, "started", { sessionId: "started-session" });
    expect(store.outstanding("schedule")).toEqual([]);
    expect(store.impacts(window.id)).toEqual({
      postponed: 1, pending: 0, dispositions: { started: 1 },
      recent: [{ ...held, disposition: "started", settledAt: expect.any(String) }],
    });
  });
});
