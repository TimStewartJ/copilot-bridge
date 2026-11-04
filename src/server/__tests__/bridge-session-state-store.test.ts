import { describe, expect, it } from "vitest";
import { setupTestDb } from "./helpers.js";
import { createBridgeSessionStateStore } from "../bridge-session-state-store.js";

describe("bridge session state store", () => {
  it("preserves independent chat overrides until the last one is cleared", () => {
    const store = createBridgeSessionStateStore(setupTestDb());

    store.setTitleOverride("session-1", "Manual title");
    store.setArchived("session-1", true);
    store.setArchived("session-1", false);
    expect(store.getState("session-1")).toMatchObject({ archived: false, archivedAt: undefined, titleOverride: "Manual title" });

    store.setPlaybook("session-1", "watch", "schedule");
    store.clearAllTitleOverrides();
    store.setPinnedCwd("session-1", "/repo");
    store.clearPinnedCwd("session-1");
    expect(store.getState("session-1")).toMatchObject({ playbook: "watch", playbookSource: "schedule" });

    store.setPlaybook("session-1", "research", "user");
    expect(store.getState("session-1")).toMatchObject({ playbook: "research", playbookSource: "user" });
    store.clearPlaybook("session-1");
    expect(store.getState("session-1")).toBeUndefined();
  });

  it("lists only rows with a pinned cwd for the session-list workspace preload", () => {
    const store = createBridgeSessionStateStore(setupTestDb());

    store.setPinnedCwd("pinned-1", "D:\\repo-a");
    store.setPinnedCwd("pinned-2", "D:\\repo-b");
    store.setArchived("archived-only", true);
    store.setTitleOverride("titled-only", "Manual title");
    store.setPinnedCwd("cleared", "D:\\repo-c");
    store.clearPinnedCwd("cleared");

    const pinned = store.listPinnedCwdStates();
    expect(Object.keys(pinned).sort()).toEqual(["pinned-1", "pinned-2"]);
    expect(pinned["pinned-1"]).toEqual(store.getState("pinned-1"));
    expect(Object.keys(store.listStates()).sort()).toEqual(["archived-only", "pinned-1", "pinned-2", "titled-only"]);
  });

  it("keeps the latest visible activity until a rewind replaces or clears it", () => {
    const store = createBridgeSessionStateStore(setupTestDb());
    const latest = "2026-05-07T10:00:00.000Z";
    const older = "2026-05-07T09:00:00.000Z";
    store.setLastVisibleActivityAt("session-1", latest);
    store.setLastVisibleActivityAt("session-1", older);
    expect(store.getState("session-1")?.lastVisibleActivityAt).toBe(latest);
    store.replaceLastVisibleActivityAt("session-1", older);
    expect(store.getState("session-1")?.lastVisibleActivityAt).toBe(older);
    store.replaceLastVisibleActivityAt("session-1", undefined);
    expect(store.getState("session-1")).toBeUndefined();
  });
  it("keeps attention through older events and other clears until history is rewound", () => {
    const store = createBridgeSessionStateStore(setupTestDb());
    const latest = "2026-05-07T10:00:00.000Z";
    const older = "2026-05-07T09:00:00.000Z";
    store.setLastAttentionAt("session-1", latest);
    store.setLastAttentionAt("session-1", older);
    store.setPinnedCwd("session-1", "D:\\repo");
    store.clearPinnedCwd("session-1");
    expect(store.getState("session-1")?.lastAttentionAt).toBe(latest);
    store.replaceLastAttentionAt("session-1", older);
    expect(store.getState("session-1")?.lastAttentionAt).toBe(older);
    store.replaceLastAttentionAt("session-1", undefined);
    expect(store.getState("session-1")).toBeUndefined();
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
