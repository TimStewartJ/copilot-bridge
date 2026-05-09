import { describe, expect, it } from "vitest";
import { setupTestDb } from "./helpers.js";
import { createSessionTitlesStore } from "../session-titles.js";
import { createBridgeSessionStateStore } from "../bridge-session-state-store.js";

describe("session title overrides", () => {
  it("stores explicit Bridge title overrides without prompt cleanup", () => {
    const db = setupTestDb();
    const sessionTitles = createSessionTitlesStore(db);
    const bridgeSessionState = createBridgeSessionStateStore(db);

    sessionTitles.setTitle("session-1", "Generate a concise changelog for release");

    expect(sessionTitles.getTitle("session-1")).toBe("Generate a concise changelog for release");
    expect(bridgeSessionState.getState("session-1")?.titleOverride).toBe("Generate a concise changelog for release");
    expect((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_titles'").get() as any)).toBeUndefined();
  });
});
