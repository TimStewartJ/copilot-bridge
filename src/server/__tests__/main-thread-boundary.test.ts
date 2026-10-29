import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SERVER_DIR, SRC_DIR, display, walkImportGraph } from "./runtime-import-graph.js";

// Creating a process is a synchronous call on the calling thread (CreateProcessW on Windows),
// and under machine load it has taken tens of seconds. When the server's main thread made that
// call, its event loop served nothing for the duration: health probes failed, the launcher
// killed the server, and sessions lost their tool-permission acknowledgements. Every process
// creation in the server runtime therefore goes through process-host.ts, which performs it on
// a worker thread (the mechanism is the in-tree package src/packages/spawn-offthread). Deleting
// or copying a directory tree synchronously is the same kind of call:
// it holds its thread for the whole operation, and a worktree is tens of thousands of files.
// `staging_cleanup` froze the live server for 2.4 s that way. Opening a file another program keeps
// writing is a third: on Windows an antivirus scan holds the open until it is done, and
// node:sqlite is synchronous. Reading the Copilot CLI's session store on the main thread froze
// the live server for 12.2 s. This test walks the real import graph so no rule can erode silently.

const RUNTIME_ENTRY_POINTS = ["index.ts", "staging-preview-server.ts"].map((name) => join(SERVER_DIR, name));
const ONLY_PROCESS_CREATOR = join(SRC_DIR, "packages", "spawn-offthread", "src", "worker.ts");
const PROCESS_CREATING_EXPORTS = new Set(["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]);

// Modules the server loads that may still delete or copy a tree synchronously, and why that
// cannot stall the server. Everything else goes through getProcessHost().removeTree().
const SYNC_TREE_OPERATIONS_ALLOWED: Record<string, string> = {
  "packages/spawn-offthread/src/worker.ts": "the worker thread that performs the server's tree deletes",
  "server/dependency-sync.ts": "dependency installs run in the launcher and the job runner",
  "server/release-slots.ts": "release slots are pruned by the launcher",
  "server/validation-command-env.ts": "validation commands run in the job runner",
  "server/staging-backend-manager.ts": "copies docs while seeding preview data, which the job runner does",
  "server/docs-snapshot-store.ts": "bounded by the docs folder, inside one synchronous snapshot transaction",
  "server/task-agent-definition-store.ts": "a task's agent folder holds a handful of small files",
};
const SYNC_TREE_CALL = /\b(rmSync|cpSync|rmdirSync)\s*\(/g;

// Modules the server loads that may open a SQLite database themselves, and why that cannot stall
// the server. The Copilot CLI's session store goes through cli-session-store.ts instead.
const SQLITE_OPENERS_ALLOWED: Record<string, string> = {
  "server/db.ts": "the Bridge's own database, in its data directory, opened once at boot and kept open",
  "server/cli-session-store-worker.ts": "the worker thread that reads and writes the Copilot CLI's session store",
  "server/staging-backend-manager.ts": "reads the production database while seeding preview data, which the job runner does",
};

/** Synchronous calls in `source` that delete or copy a whole tree: cpSync, rmdirSync, and rmSync with `recursive`. */
function syncTreeOperations(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(SYNC_TREE_CALL)) {
    const lineStart = source.lastIndexOf("\n", match.index) + 1;
    if (/^\s*(\/\/|\*)/.test(source.slice(lineStart, match.index))) continue;
    let depth = 0;
    let end = match.index + match[0].length - 1;
    do {
      if (source[end] === "(") depth++;
      else if (source[end] === ")") depth--;
      end++;
    } while (depth > 0 && end < source.length);
    const call = source.slice(match.index, end);
    if (match[1] !== "rmSync" || /\brecursive\b/.test(call)) {
      found.push(`${match[1]} at line ${source.slice(0, match.index).split("\n").length}`);
    }
  }
  return found;
}

describe("server main-thread boundary", () => {
  const graph = walkImportGraph(RUNTIME_ENTRY_POINTS);

  it("walks the real server runtime graph", () => {
    const modules = new Set([...graph.keys()].map(display));
    for (const expected of [
      "server/session-manager.ts",
      "server/platform.ts",
      "server/git-command.ts",
      "server/staging-backend-manager.ts",
      "server/voice/voice-engine.ts",
      "server/process-host.ts",
      "packages/spawn-offthread/src/host.ts",
      "packages/spawn-offthread/src/worker.ts",
      "server/windows-process-table.ts",
      "server/cli-session-store.ts",
      "server/cli-session-store-worker.ts",
    ]) {
      expect(modules, `${expected} should be reachable from the server entry points`).toContain(expected);
    }
    expect(graph.size).toBeGreaterThan(150);
  });

  it("creates processes only in the process-host worker module", () => {
    const violations: string[] = [];
    for (const [file, imports] of graph) {
      if (file === ONLY_PROCESS_CREATOR) continue;
      for (const { specifier, valueNames } of imports) {
        if (specifier !== "node:child_process" && specifier !== "child_process") continue;
        const creating = valueNames.filter((name) => name === "*" || PROCESS_CREATING_EXPORTS.has(name));
        if (creating.length > 0) violations.push(`${display(file)} imports ${creating.join(", ")} from ${specifier}`);
      }
    }
    expect(
      violations,
      "Server runtime modules must start processes through getProcessHost() (src/server/process-host.ts), "
      + "which creates them on a worker thread. Creating a process on the main thread freezes the event loop.",
    ).toEqual([]);
  });

  it("deletes and copies directory trees only off the main thread", () => {
    const violations: string[] = [];
    const unusedExceptions = new Set(Object.keys(SYNC_TREE_OPERATIONS_ALLOWED));
    for (const file of graph.keys()) {
      const operations = syncTreeOperations(readFileSync(file, "utf-8"));
      if (operations.length === 0) continue;
      if (unusedExceptions.delete(display(file))) continue;
      violations.push(`${display(file)}: ${operations.join(", ")}`);
    }
    expect(
      violations,
      "Server runtime modules must delete directory trees with getProcessHost().removeTree(), which runs on a "
      + "worker thread. A synchronous tree delete or copy on the main thread freezes the event loop.",
    ).toEqual([]);
    expect([...unusedExceptions], "exceptions that no longer apply must be removed").toEqual([]);
  });

  it("opens SQLite databases only where a held open cannot stall the server", () => {
    const violations: string[] = [];
    const unusedExceptions = new Set(Object.keys(SQLITE_OPENERS_ALLOWED));
    for (const [file, imports] of graph) {
      if (!imports.some(({ specifier }) => specifier === "node:sqlite" || specifier === "sqlite")) continue;
      if (unusedExceptions.delete(display(file))) continue;
      violations.push(display(file));
    }
    expect(
      violations,
      "Server runtime modules must not open a SQLite database that another program writes. node:sqlite is "
      + "synchronous, and an antivirus scan can hold the open for seconds, which freezes the event loop. Use the "
      + "Bridge's own database (db.ts), or run the work on a worker thread as src/server/cli-session-store.ts does.",
    ).toEqual([]);
    expect([...unusedExceptions], "exceptions that no longer apply must be removed").toEqual([]);
  });

  it("keeps the launcher-only synchronous helpers out of the server runtime", () => {
    const modules = new Set([...graph.keys()].map(display));
    expect(modules).not.toContain("launcher-git.ts");
    expect(modules).not.toContain("server/sync-command-runner.ts");
    expect(modules).not.toContain("server/windows-process-table-worker.ts");
  });
});
