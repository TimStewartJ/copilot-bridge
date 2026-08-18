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

  it("preserves the latest visible and attention timestamps", () => {
    // visible activity
    {
    const store = createBridgeSessionStateStore(setupTestDb());

    store.setLastVisibleActivityAt("session-1", "2026-05-07T10:00:00.000Z");
    store.setLastVisibleActivityAt("session-1", "2026-05-07T09:00:00.000Z");

    expect(store.getState("session-1")?.lastVisibleActivityAt).toBe("2026-05-07T10:00:00.000Z");
    }

    // attention
    {
    const store = createBridgeSessionStateStore(setupTestDb());

    store.setLastAttentionAt("session-1", "2026-05-07T10:00:00.000Z");
    store.setLastAttentionAt("session-1", "2026-05-07T09:00:00.000Z");

    expect(store.getState("session-1")?.lastAttentionAt).toBe("2026-05-07T10:00:00.000Z");
    }
  });
  it("can replace or clear visible and attention activity after history is rewound", () => {
    // visible activity
    {
    const store = createBridgeSessionStateStore(setupTestDb());

    store.setLastVisibleActivityAt("session-1", "2026-05-07T10:00:00.000Z");
    store.replaceLastVisibleActivityAt("session-1", "2026-05-07T09:00:00.000Z");
    expect(store.getState("session-1")?.lastVisibleActivityAt).toBe("2026-05-07T09:00:00.000Z");

    store.replaceLastVisibleActivityAt("session-1", undefined);
    expect(store.getState("session-1")).toBeUndefined();
    }

    // attention
    {
    const store = createBridgeSessionStateStore(setupTestDb());

    store.setLastAttentionAt("session-1", "2026-05-07T10:00:00.000Z");
    store.replaceLastAttentionAt("session-1", "2026-05-07T09:00:00.000Z");
    expect(store.getState("session-1")?.lastAttentionAt).toBe("2026-05-07T09:00:00.000Z");

    store.replaceLastAttentionAt("session-1", undefined);
    expect(store.getState("session-1")).toBeUndefined();
    }
  });
  it("keeps attention-only rows when other fields are cleared", () => {
    const store = createBridgeSessionStateStore(setupTestDb());

    store.setLastAttentionAt("session-1", "2026-05-07T10:00:00.000Z");
    store.setPinnedCwd("session-1", "D:\\repo");
    store.clearPinnedCwd("session-1");

    expect(store.getState("session-1")?.lastAttentionAt).toBe("2026-05-07T10:00:00.000Z");
  });

  it("persists and clears pending fork auto-name state independently", () => {
    const store = createBridgeSessionStateStore(setupTestDb());

    store.setPendingAutoName("session-1", "Fork of Original session");
    store.setLastAttentionAt("session-1", "2026-05-07T10:00:00.000Z");

    expect(store.getState("session-1")).toMatchObject({
      pendingAutoName: true,
      pendingAutoNameReplaceTitle: "Fork of Original session",
    });

    store.clearPendingAutoName("session-1");

    expect(store.getState("session-1")).toMatchObject({
      pendingAutoName: false,
      pendingAutoNameReplaceTitle: undefined,
      lastAttentionAt: "2026-05-07T10:00:00.000Z",
    });
  });

  it("prunes a pending fork auto-name-only row when it is cleared", () => {
    const store = createBridgeSessionStateStore(setupTestDb());

    store.setPendingAutoName("session-1");
    store.clearPendingAutoName("session-1");

    expect(store.getState("session-1")).toBeUndefined();
  });
});
