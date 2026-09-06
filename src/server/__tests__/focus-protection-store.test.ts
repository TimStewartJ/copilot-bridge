import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, openMemoryDatabase, type DatabaseSync } from "../db.js";
import { createGlobalBus } from "../global-bus.js";
import { createFocusProtectionStore, FocusProtectionConflictError, normalizeFocusProtectionRequest, protectionRetryAt } from "../focus-protection-store.js";
import { initializeFocusSupplementalSchema } from "../focus-schema.js";
import { makeTestDir } from "./helpers.js";

const NOW = Date.parse("2026-09-05T12:00:00.000Z");
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();
const request = (updates: Record<string, unknown> = {}) => ({
  endsAt: at(120), timezone: "America/Los_Angeles", reason: "Write without interruption",
  allowNeedsInput: false, allowAuthorizedDeadlineOverride: false, ...updates,
});
const databases: DatabaseSync[] = [];
const stores: ReturnType<typeof createFocusProtectionStore>[] = [];
function fixture(db = openMemoryDatabase()) {
  databases.push(db);
  const bus = createGlobalBus();
  const store = createFocusProtectionStore(db, bus);
  stores.push(store);
  const emit = vi.spyOn(bus, "emit");
  return { db, bus, store, emit };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => {
  stores.splice(0).forEach((store) => store.stop());
  databases.splice(0).forEach((db) => db.close());
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("durable protected concentration windows", () => {
  it("creates the schema fresh and upgrades existing Focus data without persisted status", () => {
    const { db } = fixture();
    expect(db.prepare("PRAGMA table_info(focus_protection_windows)").all().map((row) => row.name))
      .toEqual(["id", "startsAt", "endsAt", "timezone", "reason", "allowNeedsInput", "allowAuthorizedDeadlineOverride", "cancelledAt", "createdAt", "updatedAt"]);
    db.exec("INSERT INTO focus_digest_views VALUES ('retained-source','2026-01-01T00:00:00.000Z'); DROP TABLE focus_protection_windows;");
    initializeFocusSupplementalSchema(db);
    initializeFocusSupplementalSchema(db);
    expect(db.prepare("SELECT lastViewedAt FROM focus_digest_views WHERE digestId='retained-source'").get()?.lastViewedAt)
      .toBe("2026-01-01T00:00:00.000Z");
    expect(createFocusProtectionStore(db, createGlobalBus()).create(request()).status).toBe("active");
  });

  it("derives scheduled/active/completed boundaries and emits expiry once after commit", async () => {
    const { db, store, bus, emit } = fixture();
    const window = store.create(request({ startsAt: at(30), endsAt: at(120) }));
    expect(window.status).toBe("scheduled");
    expect(store.current()).toBeNull();
    expect(store.upcoming()?.id).toBe(window.id);
    const observedTransactions: boolean[] = [];
    bus.subscribe((event) => {
      if (event.type === "focus:protection-cleared") {
        observedTransactions.push(db.isTransaction);
        store.reconcile();
      }
    });
    store.start();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(store.current()).toMatchObject({ id: window.id, status: "active" });
    await vi.advanceTimersByTimeAsync(90 * 60_000);
    expect(store.current()).toBeNull();
    expect(store.get(window.id)?.status).toBe("completed");
    store.reconcile();
    expect(emit.mock.calls.filter(([event]) => event.type === "focus:protection-cleared")).toHaveLength(1);
    expect(observedTransactions).toEqual([false]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM focus_attention_events WHERE eventType='protection_cleared'").get()?.n).toBe(1);
  });

  it("keeps synchronous admission reads pure even after expiry", () => {
    const { db, store, emit } = fixture();
    store.create(request());
    emit.mockClear();
    const before = db.prepare("SELECT COUNT(*) AS n FROM focus_attention_events").get()?.n;
    vi.setSystemTime(at(150));
    for (let index = 0; index < 10; index++) expect(store.current()).toBeNull();
    expect(emit).not.toHaveBeenCalled();
    expect(db.prepare("SELECT COUNT(*) AS n FROM focus_attention_events").get()?.n).toBe(before);
    store.reconcile();
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: "focus:protection-cleared", reason: "completed" }));
  });

  it("rejects all overlap transactionally, allows touching endpoints and ignores cancelled windows", () => {
    const { db, store } = fixture();
    const first = store.create(request({ startsAt: at(30), endsAt: at(60) }), () => expect(db.isTransaction).toBe(true));
    for (const [start, end] of [[0, 31], [45, 55], [59, 90], [0, 120]]) {
      expect(() => store.create(request({ startsAt: at(start), endsAt: at(end) }))).toThrow(FocusProtectionConflictError);
    }
    store.create(request({ startsAt: at(60), endsAt: at(90) }));
    store.cancel(first.id);
    expect(store.create(request({ startsAt: at(30), endsAt: at(60) })).status).toBe("scheduled");
    expect(store.list()).toHaveLength(3);
  });

  it("cancels idempotently and emits a single prompt-clear event", () => {
    const { store, emit } = fixture();
    const window = store.create(request());
    vi.setSystemTime(at(10));
    const cancelled = store.cancel(window.id);
    expect(cancelled).toMatchObject({ status: "cancelled", cancelledAt: at(10), updatedAt: at(10) });
    expect(store.cancel(window.id)).toEqual(cancelled);
    expect(store.current()).toBeNull();
    expect(emit.mock.calls.filter(([event]) => event.type === "focus:protection-cleared")).toHaveLength(1);
    expect(store.coveringSlot(at(5))?.id).toBe(window.id);
    expect(store.coveringSlot(at(11))).toBeNull();
  });

  it("restores persisted protection and offline expiry after reopening the database", () => {
    const dir = makeTestDir("protected-concentration-persistence");
    const firstDb = openDatabase(dir);
    const firstStore = createFocusProtectionStore(firstDb, createGlobalBus());
    const window = firstStore.create(request());
    firstDb.close();
    const { db, store, emit } = fixture(openDatabase(dir));
    expect(store.current()).toEqual(window);
    vi.setSystemTime(at(180));
    store.start();
    expect(store.get(window.id)?.status).toBe("completed");
    expect(store.coveringSlot(at(90))?.id).toBe(window.id);
    expect(emit.mock.calls.filter(([event]) => event.type === "focus:protection-cleared")).toHaveLength(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM focus_protection_windows").get()?.n).toBe(1);
  });

  it("arbitrates overlapping creation across database connections", () => {
    const dir = makeTestDir("protection-connections");
    const first = fixture(openDatabase(dir));
    const second = fixture(openDatabase(dir));
    first.store.create(request());
    expect(() => second.store.create(request())).toThrow(FocusProtectionConflictError);
    expect(second.store.list()).toHaveLength(1);
  });

  it("uses absolute instants and validates timezones, bounds, flags and unknown fields", () => {
    expect(normalizeFocusProtectionRequest(request({ endsAt: "2026-09-05T07:00:00-07:00" })))
      .toMatchObject({ endsAt: at(120), timezone: "America/Los_Angeles" });
    for (const update of [
      { startsAt: at(-1) }, { endsAt: at(0) }, { endsAt: "2026-09-05T15:00:00" },
      { endsAt: at(7 * 24 * 60 + 1) }, { timezone: "Not/AZone" },
      { reason: "" }, { allowNeedsInput: 1 }, { allowAuthorizedDeadlineOverride: "true" }, { status: "active" },
    ]) expect(() => normalizeFocusProtectionRequest(request(update))).toThrow();
  });

  it("dedupes durable holds/dispositions without an impacts table or a 500-row recovery cap", () => {
    const { db, store } = fixture();
    const window = store.create(request());
    for (let index = 0; index < 501; index++) {
      const work = { kind: "schedule" as const, workId: `schedule-${index}`, scheduledFor: at(10) };
      expect(store.hold(window, work)).toBe(true);
      expect(store.hold(window, work)).toBe(false);
    }
    expect(store.outstanding("schedule")).toHaveLength(501);
    for (const work of store.outstanding("schedule")) {
      store.settle(work, "started", { sessionId: `session-${work.workId}` });
      store.settle(work, "started");
    }
    expect(store.outstanding()).toHaveLength(0);
    expect(store.impacts(window.id)).toMatchObject({ postponed: 501, pending: 0, dispositions: { started: 501 } });
    expect(store.impacts(window.id).recent).toHaveLength(20);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%protection%'").all())
      .toEqual([{ name: "focus_protection_windows" }]);
  });

  it("does not announce rolled-back creates and never rearms after shutdown", async () => {
    const { db, store, emit } = fixture();
    expect(() => store.create(request(), () => { throw new Error("preview changed"); })).toThrow("preview changed");
    expect(store.list()).toEqual([]);
    expect(emit).not.toHaveBeenCalled();
    store.create(request());
    store.start();
    store.stop();
    emit.mockClear();
    await vi.advanceTimersByTimeAsync(180 * 60_000);
    expect(emit).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM focus_attention_events WHERE eventType='protection_cleared'").get()?.n).toBe(0);
  });

  it("bounds deterministic retry jitter at the absolute end", () => {
    const window = { endsAt: at(120) };
    expect(protectionRetryAt(window, "same")).toBe(protectionRetryAt(window, "same"));
    for (let index = 0; index < 100; index++) {
      expect(protectionRetryAt(window, `slot-${index}`) - Date.parse(window.endsAt)).toBeGreaterThan(0);
      expect(protectionRetryAt(window, `slot-${index}`) - Date.parse(window.endsAt)).toBeLessThanOrEqual(3_000);
    }
  });
});
