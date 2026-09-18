import { describe, expect, it } from "vitest";
import { setupTestDb } from "../../__tests__/helpers.js";
import { createHelmStore } from "../helm-store.js";

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";

describe("helm store", () => {
  it("creates conversations and keeps exactly one current", () => {
    const store = createHelmStore(setupTestDb());
    expect(store.getCurrent()).toBeUndefined();
    expect(store.isHelmSession(A)).toBe(false);

    store.create(A, "2026-09-18T10:00:00.000Z");
    expect(store.isHelmSession(A)).toBe(true);
    expect(store.getCurrent()).toMatchObject({ sessionId: A, isCurrent: true, turnCount: 0, kept: false });

    store.create(B, "2026-09-18T11:00:00.000Z");
    expect(store.getCurrent()?.sessionId).toBe(B);
    expect(store.list().map((record) => [record.sessionId, record.isCurrent])).toEqual([[B, true], [A, false]]);

    store.setCurrent(A);
    expect(store.list().filter((record) => record.isCurrent).map((record) => record.sessionId)).toEqual([A]);
    store.setCurrent(null);
    expect(store.getCurrent()).toBeUndefined();
  });

  it("records turns and activity without moving activity backwards", () => {
    const store = createHelmStore(setupTestDb());
    store.create(A, "2026-09-18T10:00:00.000Z");
    store.recordTurn(A, "2026-09-18T10:05:00.000Z");
    store.recordTurn(A, "2026-09-18T10:06:00.000Z");
    expect(store.get(A)).toMatchObject({ turnCount: 2, lastActiveAt: "2026-09-18T10:06:00.000Z" });
    store.touch(A, "2026-09-18T10:01:00.000Z");
    expect(store.get(A)?.lastActiveAt).toBe("2026-09-18T10:06:00.000Z");
    store.touch(A, "2026-09-18T10:09:00.000Z");
    expect(store.get(A)?.lastActiveAt).toBe("2026-09-18T10:09:00.000Z");
  });

  it("keeps, removes and survives a new store over the same database", () => {
    const db = setupTestDb();
    const store = createHelmStore(db);
    store.create(A, "2026-09-18T10:00:00.000Z");
    expect(store.setKept(A, true)?.kept).toBe(true);
    expect(store.setKept(B, true)).toBeUndefined();

    const reopened = createHelmStore(db);
    expect(reopened.isHelmSession(A)).toBe(true);
    expect(reopened.get(A)).toMatchObject({ kept: true, isCurrent: true });

    expect(store.remove(A)).toBe(true);
    expect(store.remove(A)).toBe(false);
    expect(store.isHelmSession(A)).toBe(false);
    expect(store.list()).toEqual([]);
  });
});
