import { describe, expect, it } from "vitest";
import { setupTestDb } from "./helpers.js";
import { createBridgeSessionStateStore } from "../bridge-session-state-store.js";

describe("bridge session state store", () => {
  it("keeps independent fields when clearing archive state", () => {
    const store = createBridgeSessionStateStore(setupTestDb());

    store.setTitleOverride("session-1", "Manual title");
    store.setArchived("session-1", true);
    store.setArchived("session-1", false);

    const state = store.getState("session-1");
    expect(state?.archived).toBe(false);
    expect(state?.archivedAt).toBeUndefined();
    expect(state?.titleOverride).toBe("Manual title");
  });

  it("prunes default rows after the last override is cleared", () => {
    const store = createBridgeSessionStateStore(setupTestDb());

    store.setPinnedCwd("session-1", "D:\\repo");
    store.clearPinnedCwd("session-1");

    expect(store.getState("session-1")).toBeUndefined();
  });

  it("preserves the latest visible activity timestamp", () => {
    const store = createBridgeSessionStateStore(setupTestDb());

    store.setLastVisibleActivityAt("session-1", "2026-05-07T10:00:00.000Z");
    store.setLastVisibleActivityAt("session-1", "2026-05-07T09:00:00.000Z");

    expect(store.getState("session-1")?.lastVisibleActivityAt).toBe("2026-05-07T10:00:00.000Z");
  });
});
