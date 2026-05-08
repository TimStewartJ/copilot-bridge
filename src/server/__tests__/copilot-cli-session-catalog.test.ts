import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeTestDir } from "./helpers.js";
import { createCopilotCliSessionCatalog } from "../copilot-cli-session-catalog.js";

describe("copilot CLI session catalog", () => {
  it("returns undefined when the CLI session store is missing", () => {
    const copilotHome = makeTestDir("missing-cli-catalog");
    const catalog = createCopilotCliSessionCatalog({ copilotHome });

    expect(catalog.listSessions()).toBeUndefined();
  });

  it("lists sessions from the CLI session store without reading workspace files", () => {
    const copilotHome = makeTestDir("cli-catalog");
    mkdirSync(copilotHome, { recursive: true });
    const db = new DatabaseSync(join(copilotHome, "session-store.db"));
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        cwd TEXT,
        repository TEXT,
        branch TEXT,
        summary TEXT,
        created_at TEXT,
        updated_at TEXT,
        host_type TEXT
      );
      INSERT INTO sessions (id, cwd, repository, branch, summary, created_at, updated_at, host_type)
      VALUES (
        'session-1',
        'D:\\repo',
        'owner/repo',
        'main',
        'Review catalog adapter',
        '2026-05-07T10:00:00.000Z',
        '2026-05-07T11:00:00.000Z',
        'github'
      );
      INSERT INTO sessions (id, cwd, repository, branch, summary, created_at, updated_at, host_type)
      VALUES (
        'b17e1000-0000-4000-8000-000000000001',
        'D:\\repo',
        'owner/repo',
        'main',
        'Disposable helper',
        '2026-05-07T10:00:00.000Z',
        '2026-05-07T12:00:00.000Z',
        'github'
      );
    `);
    db.close();
    const catalog = createCopilotCliSessionCatalog({ copilotHome });

    expect(catalog.listSessions()).toEqual([
      {
        sessionId: "session-1",
        summary: "Review catalog adapter",
        startTime: "2026-05-07T10:00:00.000Z",
        modifiedTime: "2026-05-07T11:00:00.000Z",
        context: { cwd: "D:\\repo" },
        repository: "owner/repo",
        branch: "main",
        hostType: "github",
      },
    ]);
  });
});
