import { describe, expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createMockSessionManager } from "./helpers.js";
import { createTestApp } from "./test-app.js";
import { repairDanglingTaskSessionLinks } from "../task-session-link-repair.js";

const OLD_ISO = "2026-01-01T00:00:00.000Z";

function setup(options: {
  known?: string[];
  catalogUnavailable?: boolean;
  activeSessions?: string[];
  restoredDuringLookup?: string;
} = {}) {
  const { ctx, db } = createTestApp({
    sessionManager: { ...createMockSessionManager(), getActiveSessions: () => options.activeSessions ?? [] },
    cliSessionCatalog: {
      hasSession: async (sessionId: string) => {
        if (sessionId === options.restoredDuringLookup) makeFolder(sessionId);
        return options.catalogUnavailable ? undefined : (options.known ?? []).includes(sessionId);
      },
    } as any,
  });
  const task = ctx.taskStore.createTask("Linked");
  const link = (sessionId: string, linkedAt = OLD_ISO) => {
    ctx.taskStore.linkSession(task.id, sessionId);
    db.prepare("UPDATE task_sessions SET linkedAt = ? WHERE sessionId = ?").run(linkedAt, sessionId);
  };
  const makeFolder = (sessionId: string) => mkdirSync(join(ctx.copilotHome!, "session-state", sessionId), { recursive: true });
  const linkedIds = () => ctx.taskStore.getTask(task.id)!.sessionIds;
  return { ctx, link, makeFolder, linkedIds };
}

describe("repairDanglingTaskSessionLinks", () => {
  it("removes old links to conversations that are gone and keeps every other link", async () => {
    const { ctx, link, makeFolder, linkedIds } = setup({
      known: ["catalog-known"], activeSessions: ["gone-active"], restoredDuringLookup: "restored",
    });
    const present = Array.from({ length: 6 }, (_, index) => `present-${index}`);
    for (const sessionId of [...present, "gone", "gone-archived", "gone-recent", "catalog-known", "gone-active", "restored"]) {
      link(sessionId, sessionId === "gone-recent" ? new Date().toISOString() : OLD_ISO);
    }
    for (const sessionId of present) makeFolder(sessionId);
    ctx.sessionMetaStore.setArchived("gone-archived", true);

    const result = await repairDanglingTaskSessionLinks(ctx);

    expect(result).toEqual({ removedLinks: 2, goneSessionIds: ["gone", "gone-archived"] });
    expect(linkedIds().sort()).toEqual(["catalog-known", "gone-active", "gone-recent", ...present, "restored"]);
  });

  it.each([
    ["the catalog cannot be read", { catalogUnavailable: true }, ["present"], "catalog_unavailable", 1],
    ["the session-state folder is empty", {}, [], "session_state_unreadable", 1],
    ["most linked conversations are missing", {}, ["present"], "mass_loss", 2],
  ] as const)("removes nothing when %s", async (_name, options, folders, skipped, goneCount) => {
    const { link, makeFolder, linkedIds, ctx } = setup(options);
    const gone = Array.from({ length: goneCount }, (_, index) => `gone-${index}`);
    for (const sessionId of ["present", ...gone]) link(sessionId);
    for (const sessionId of folders) makeFolder(sessionId);

    const result = await repairDanglingTaskSessionLinks(ctx);

    expect(result).toEqual({ removedLinks: 0, goneSessionIds: [], skipped });
    expect(linkedIds()).toHaveLength(1 + goneCount);
  });
});
