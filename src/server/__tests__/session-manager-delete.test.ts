import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventBusRegistry } from "../event-bus.js";
import { configureRestartStateStore, SessionManager } from "../session-manager.js";
import { createSessionTitlesStore } from "../session-titles.js";
import { createSessionWorkspaceStore } from "../session-workspace-store.js";
import { createSettingsStore } from "../settings-store.js";
import { createTaskStore } from "../task-store.js";
import { createTaskGroupStore } from "../task-group-store.js";
import type { RuntimePaths } from "../runtime-paths.js";
import { createTestBus, makeTestRuntimePaths, setupTestDb } from "./helpers.js";

function createCliSession(copilotHome: string, sessionId: string): void {
  mkdirSync(copilotHome, { recursive: true });
  const cwd = join(copilotHome, "work");
  mkdirSync(cwd, { recursive: true });
  const cliDb = new DatabaseSync(join(copilotHome, "session-store.db"));
  try {
    cliDb.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        cwd TEXT,
        summary TEXT,
        created_at TEXT,
        updated_at TEXT
      );
      CREATE TABLE turns (
        session_id TEXT,
        turn_index INTEGER,
        user_message TEXT,
        assistant_response TEXT
      );
      CREATE VIRTUAL TABLE search_index USING fts5(
        content,
        session_id UNINDEXED,
        source_type UNINDEXED,
        source_id UNINDEXED
      );
    `);
    cliDb.prepare(`
      INSERT INTO sessions (id, cwd, summary, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(sessionId, cwd, "Catalog session", "2026-05-08T12:00:00.000Z", "2026-05-08T12:01:00.000Z");
    cliDb.prepare(`
      INSERT INTO turns (session_id, turn_index, user_message, assistant_response)
      VALUES (?, 0, 'hello', 'hi')
    `).run(sessionId);
    cliDb.prepare(`
      INSERT INTO search_index (content, session_id, source_type, source_id)
      VALUES ('hello hi', ?, 'turn', '0')
    `).run(sessionId);
  } finally {
    cliDb.close();
  }
}

function readCliSessionCounts(copilotHome: string, sessionId: string): { sessions: number; turns: number; searchIndex: number } {
  const cliDb = new DatabaseSync(join(copilotHome, "session-store.db"), { readOnly: true });
  try {
    const sessions = cliDb.prepare("SELECT COUNT(*) AS count FROM sessions WHERE id = ?").get(sessionId) as { count: number };
    const turns = cliDb.prepare("SELECT COUNT(*) AS count FROM turns WHERE session_id = ?").get(sessionId) as { count: number };
    const searchIndex = cliDb.prepare("SELECT COUNT(*) AS count FROM search_index WHERE session_id = ?").get(sessionId) as { count: number };
    return { sessions: sessions.count, turns: turns.count, searchIndex: searchIndex.count };
  } finally {
    cliDb.close();
  }
}

type TestSessionManager = Pick<SessionManager, "deleteSession"> & {
  backend: { deleteSession: ReturnType<typeof vi.fn> };
};

function requireCopilotHome(runtimePaths: RuntimePaths): string {
  if (!runtimePaths.copilotHome) throw new Error("Test runtime paths must include copilotHome");
  return runtimePaths.copilotHome;
}

function createManager(copilotHome: string): TestSessionManager {
  const db = setupTestDb();
  const globalBus = createTestBus();
  const runtimePaths = makeTestRuntimePaths("session-delete", { copilotHome });
  configureRestartStateStore(runtimePaths);
  const manager = new SessionManager({
    tools: [],
    globalBus,
    eventBusRegistry: createEventBusRegistry(),
    sessionTitles: createSessionTitlesStore(db),
    sessionWorkspaceStore: createSessionWorkspaceStore(db),
    taskStore: createTaskStore(db, globalBus, { runtimePaths }),
    taskGroupStore: createTaskGroupStore(db),
    settingsStore: createSettingsStore(db),
    config: { sessionMcpServers: {} },
    clientEnv: runtimePaths.env,
    copilotHome,
    runtimePaths,
  });
  return manager as unknown as TestSessionManager;
}

describe("SessionManager.deleteSession", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    configureRestartStateStore(undefined);
  });

  it("removes catalog-only sessions when the SDK reports the session is missing", async () => {
    const runtimePaths = makeTestRuntimePaths("delete-missing-sdk");
    const copilotHome = requireCopilotHome(runtimePaths);
    const sessionId = "catalog-orphan";
    const sessionDir = join(copilotHome, "session-state", sessionId);
    createCliSession(copilotHome, sessionId);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "workspace.yaml"), "created_at: 2026-05-08T12:00:00.000Z\n");
    const manager = createManager(copilotHome);
    manager.backend = { deleteSession: vi.fn().mockRejectedValue(new Error("Session does not exist")) };

    await expect(manager.deleteSession(sessionId)).resolves.toBeUndefined();

    expect(manager.backend.deleteSession).toHaveBeenCalledWith(sessionId);
    expect(existsSync(sessionDir)).toBe(false);
    expect(readCliSessionCounts(copilotHome, sessionId)).toEqual({ sessions: 0, turns: 0, searchIndex: 0 });
  });

  it("cleans local catalog rows before surfacing unexpected SDK delete errors", async () => {
    const runtimePaths = makeTestRuntimePaths("delete-sdk-error");
    const copilotHome = requireCopilotHome(runtimePaths);
    const sessionId = "delete-error-session";
    const sessionDir = join(copilotHome, "session-state", sessionId);
    createCliSession(copilotHome, sessionId);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "workspace.yaml"), "created_at: 2026-05-08T12:00:00.000Z\n");
    const manager = createManager(copilotHome);
    const error = new Error("permission denied");
    manager.backend = { deleteSession: vi.fn().mockRejectedValue(error) };

    await expect(manager.deleteSession(sessionId)).rejects.toThrow("permission denied");

    expect(existsSync(sessionDir)).toBe(false);
    expect(readCliSessionCounts(copilotHome, sessionId)).toEqual({ sessions: 0, turns: 0, searchIndex: 0 });
  });
});
