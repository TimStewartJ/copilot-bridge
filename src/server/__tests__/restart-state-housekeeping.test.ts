import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTestDir } from "./helpers.js";
import {
  isRestartAlreadyInFlight,
  sweepStaleRestartStateTempFiles,
} from "../restart-state.js";

const created: string[] = [];

function freshDataDir(): string {
  const dir = join(makeTestDir("restart-state-housekeeping"), "data");
  mkdirSync(dir, { recursive: true });
  created.push(dir);
  return dir;
}

function stateFile(dataDir: string): string {
  return join(dataDir, "restart-state.json");
}

function writeTempArtifact(dataDir: string, uuid: string, ageMs: number): string {
  const file = join(dataDir, `.restart-state.json.${uuid}.tmp`);
  writeFileSync(file, "{}", "utf8");
  if (ageMs > 0) {
    const when = new Date(Date.now() - ageMs);
    utimesSync(file, when, when);
  }
  return file;
}

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("sweepStaleRestartStateTempFiles", () => {
  it("removes orphaned temp files older than the age threshold but never deletes fresh in-flight temps", () => {
    // Stale temps are removed
    const dataDir1 = freshDataDir();
    const old1 = writeTempArtifact(dataDir1, "aaaaaaaa", 120_000);
    const old2 = writeTempArtifact(dataDir1, "bbbbbbbb", 120_000);

    const removed = sweepStaleRestartStateTempFiles(stateFile(dataDir1));

    expect(removed).toBe(2);
    expect(() => rmSync(old1)).toThrow();
    expect(() => rmSync(old2)).toThrow();

    // Fresh temp is preserved (age guard)
    const dataDir2 = freshDataDir();
    const fresh = writeTempArtifact(dataDir2, "cccccccc", 0);

    const removedFresh = sweepStaleRestartStateTempFiles(stateFile(dataDir2));

    expect(removedFresh).toBe(0);
    // Still present — removable without throwing.
    expect(() => rmSync(fresh)).not.toThrow();
  });

  it("only matches the restart-state temp naming pattern", () => {
    const dataDir = freshDataDir();
    const unrelated = join(dataDir, ".some-other-file.tmp");
    writeFileSync(unrelated, "x", "utf8");
    const old = new Date(Date.now() - 120_000);
    utimesSync(unrelated, old, old);
    writeTempArtifact(dataDir, "dddddddd", 120_000);

    const removed = sweepStaleRestartStateTempFiles(stateFile(dataDir));

    expect(removed).toBe(1);
    expect(() => rmSync(unrelated)).not.toThrow();
  });

  it("returns 0 when the directory does not exist", () => {
    const removed = sweepStaleRestartStateTempFiles(
      join(makeTestDir("restart-state-missing"), "nope", "restart-state.json"),
    );
    expect(removed).toBe(0);
  });
});

describe("isRestartAlreadyInFlight", () => {
  it("returns false for a clean data dir (no signals, idle state)", () => {
    const dataDir = freshDataDir();
    expect(isRestartAlreadyInFlight(dataDir)).toBe(false);
  });

  it("returns true when the queued restart signal file or the in-progress marker is present", () => {
    const dataDir1 = freshDataDir();
    writeFileSync(join(dataDir1, "restart.signal"), "{}", "utf8");
    expect(isRestartAlreadyInFlight(dataDir1), "signal file").toBe(true);

    const dataDir2 = freshDataDir();
    writeFileSync(join(dataDir2, "restart-in-progress.json"), "{}", "utf8");
    expect(isRestartAlreadyInFlight(dataDir2), "in-progress file").toBe(true);
  });

  it("returns true for non-idle restart-state.json and false for idle", () => {
    const dataDir1 = freshDataDir();
    writeFileSync(
      stateFile(dataDir1),
      JSON.stringify({ phase: "queued", requestId: "r1", waitingSessions: 0 }),
      "utf8",
    );
    expect(isRestartAlreadyInFlight(dataDir1), "queued phase").toBe(true);

    const dataDir2 = freshDataDir();
    writeFileSync(stateFile(dataDir2), JSON.stringify({ phase: "idle" }), "utf8");
    expect(isRestartAlreadyInFlight(dataDir2), "idle phase").toBe(false);
  });
});
