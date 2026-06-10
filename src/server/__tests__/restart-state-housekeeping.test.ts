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
  it("removes orphaned temp files older than the age threshold", () => {
    const dataDir = freshDataDir();
    const old1 = writeTempArtifact(dataDir, "aaaaaaaa", 120_000);
    const old2 = writeTempArtifact(dataDir, "bbbbbbbb", 120_000);

    const removed = sweepStaleRestartStateTempFiles(stateFile(dataDir));

    expect(removed).toBe(2);
    expect(() => rmSync(old1)).toThrow();
    expect(() => rmSync(old2)).toThrow();
  });

  it("never deletes a fresh in-flight temp (age guard)", () => {
    const dataDir = freshDataDir();
    const fresh = writeTempArtifact(dataDir, "cccccccc", 0);

    const removed = sweepStaleRestartStateTempFiles(stateFile(dataDir));

    expect(removed).toBe(0);
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

  it("returns true when the queued restart signal file is present", () => {
    const dataDir = freshDataDir();
    writeFileSync(join(dataDir, "restart.signal"), "{}", "utf8");
    expect(isRestartAlreadyInFlight(dataDir)).toBe(true);
  });

  it("returns true when the in-progress marker is present", () => {
    const dataDir = freshDataDir();
    writeFileSync(join(dataDir, "restart-in-progress.json"), "{}", "utf8");
    expect(isRestartAlreadyInFlight(dataDir)).toBe(true);
  });

  it("returns true when restart-state.json reports a non-idle phase", () => {
    const dataDir = freshDataDir();
    writeFileSync(
      stateFile(dataDir),
      JSON.stringify({ phase: "queued", requestId: "r1", waitingSessions: 0 }),
      "utf8",
    );
    expect(isRestartAlreadyInFlight(dataDir)).toBe(true);
  });

  it("returns false when restart-state.json reports idle", () => {
    const dataDir = freshDataDir();
    writeFileSync(stateFile(dataDir), JSON.stringify({ phase: "idle" }), "utf8");
    expect(isRestartAlreadyInFlight(dataDir)).toBe(false);
  });
});
