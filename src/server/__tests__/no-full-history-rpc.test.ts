import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AgentSession } from "../agent-backend/types.js";

// Guardrail for the 2026-08-24 production outages: a single full-history RPC
// (`session.getEvents()` -> `session.getMessages`) for a ~96 MB transcript tore
// down the shared stdio JSON-RPC connection and froze every live session. The
// capability was removed from the AgentSession contract; history is read from
// events.jsonl on disk (session-disk-reader.ts). This test keeps it removed.

const SERVER_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWED_FILES = new Set([
  // The SDK fake may implement getEvents to prove the wrapper never forwards it.
  join("agent-backend", "__tests__", "copilot-backend.test.ts"),
  join("__tests__", "no-full-history-rpc.test.ts"),
]);
const FORBIDDEN_PATTERNS = [
  /\.getEvents\s*\(/,
  /\bgetEvents\s*\(\s*\)\s*[:{]/,
  /\bgetEvents\??\s*:/,
  /session\.getMessages/,
];

function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...listSourceFiles(full));
    } else if (/\.(ts|tsx|js|mjs)$/.test(entry)) {
      files.push(full);
    }
  }
  return files;
}

describe("no full-history RPC", () => {
  it("AgentSession has no getEvents member", () => {
    type HasGetEvents = "getEvents" extends keyof AgentSession ? true : false;
    const hasGetEvents: HasGetEvents = false;
    expect(hasGetEvents).toBe(false);
  });

  it("no server source calls or declares a getEvents history read", () => {
    const offenders: string[] = [];
    for (const file of listSourceFiles(SERVER_ROOT)) {
      const rel = relative(SERVER_ROOT, file).split(sep).join(sep);
      if (ALLOWED_FILES.has(rel)) continue;
      const source = readFileSync(file, "utf-8");
      const lines = source.split(/\r?\n/);
      lines.forEach((line, index) => {
        if (line.trimStart().startsWith("//")) return;
        if (FORBIDDEN_PATTERNS.some((pattern) => pattern.test(line))) {
          offenders.push(`${rel}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders, "History must be read from events.jsonl via session-disk-reader.ts, never over RPC").toEqual([]);
  });
});
