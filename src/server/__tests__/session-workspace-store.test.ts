import { beforeEach, describe, expect, it } from "vitest";
import { openMemoryDatabase, type DatabaseSync } from "../db.js";
import { createSessionWorkspaceStore, type SessionWorkspaceStore } from "../session-workspace-store.js";

let db: DatabaseSync;
let store: SessionWorkspaceStore;

beforeEach(() => {
  db = openMemoryDatabase();
  store = createSessionWorkspaceStore(db);
});

describe("session-workspace-store", () => {
  it("stores and updates pinned session workspaces", () => {
    const created = store.setWorkspace("session-1", "/workspace/one");
    const updated = store.setWorkspace("session-1", "/workspace/two");

    expect(created.cwd).toBe("/workspace/one");
    expect(store.getWorkspace("session-1")).toMatchObject({
      cwd: "/workspace/two",
      updatedAt: updated.updatedAt,
    });
    expect((db.prepare("SELECT COUNT(*) AS count FROM session_workspace").get() as any).count).toBe(0);
  });

  it("deletes stored workspaces", () => {
    store.setWorkspace("session-1", "/workspace/one");
    store.deleteWorkspace("session-1");
    expect(store.getWorkspace("session-1")).toBeUndefined();
  });
});
