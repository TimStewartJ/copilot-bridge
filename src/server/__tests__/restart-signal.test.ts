import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { consumeRestartSignalFile, parseRestartSignalContent, serializeRestartSignal } from "../restart-signal.js";
import { makeTestDir } from "./helpers.js";

describe("restart signal parsing", () => {
  it("round-trips operational and deploy restart signals", () => {
    const content1 = serializeRestartSignal({
      validationMode: "operational",
      source: "self_restart",
      requestedAt: "2026-05-14T20:00:00.000Z",
    });
    expect(parseRestartSignalContent(content1)).toEqual({
      requestedAt: "2026-05-14T20:00:00.000Z",
      validationMode: "operational",
      source: "self_restart",
    });

    const candidateRoot = join(makeTestDir("restart-signal-candidate"), "release-slots", "slot-a");
    const content2 = serializeRestartSignal({
      validationMode: "deploy",
      source: "staging_deploy",
      requestedAt: "2026-05-18T20:00:00.000Z",
      releaseCandidate: {
        id: "slot-a",
        root: candidateRoot,
        commitSha: "abc123",
        source: "staging_deploy",
        dependencyHash: "deps123",
      },
    });
    expect(parseRestartSignalContent(content2)).toEqual({
      requestedAt: "2026-05-18T20:00:00.000Z",
      validationMode: "deploy",
      source: "staging_deploy",
      releaseCandidate: {
        id: "slot-a",
        root: candidateRoot,
        commitSha: "abc123",
        source: "staging_deploy",
        dependencyHash: "deps123",
      },
    });
  });

  it("rejects legacy plain timestamps and malformed or untyped signals", () => {
    expect(() => parseRestartSignalContent("2026-05-14T20:00:00.000Z\n"))
      .toThrow(/Unexpected non-whitespace character/);
    expect(() => parseRestartSignalContent('{"validationMode":"oper')).toThrow();
    expect(() => parseRestartSignalContent('{"validationMode":"unknown"}'))
      .toThrow("Restart signal must be typed JSON with a valid validationMode");
  });

  it("claims a signal by renaming to the in-progress file and removes invalid claims", () => {
    // Valid claim: renames signal to in-progress and parses it
    const dir = makeTestDir("restart-signal-claim");
    const signalFile = join(dir, "restart.signal");
    const inProgressFile = join(dir, "restart-in-progress.json");
    writeFileSync(signalFile, serializeRestartSignal({
      validationMode: "operational",
      source: "self_restart",
      requestedAt: "2026-05-18T20:00:00.000Z",
    }));

    expect(consumeRestartSignalFile(signalFile, inProgressFile)).toEqual({
      requestedAt: "2026-05-18T20:00:00.000Z",
      validationMode: "operational",
      source: "self_restart",
    });
    expect(existsSync(signalFile)).toBe(false);
    expect(parseRestartSignalContent(readFileSync(inProgressFile, "utf-8"))).toEqual({
      requestedAt: "2026-05-18T20:00:00.000Z",
      validationMode: "operational",
      source: "self_restart",
    });

    // Invalid claim: signal is removed but in-progress is not written
    const dir2 = makeTestDir("restart-signal-invalid-claim");
    const signalFile2 = join(dir2, "restart.signal");
    const inProgressFile2 = join(dir2, "restart-in-progress.json");
    writeFileSync(signalFile2, "2026-05-14T20:00:00.000Z\n");

    expect(() => consumeRestartSignalFile(signalFile2, inProgressFile2)).toThrow();
    expect(existsSync(signalFile2)).toBe(false);
    expect(existsSync(inProgressFile2)).toBe(false);
  });

  it("returns null when there is no signal to claim", () => {
    const dir = makeTestDir("restart-signal-missing");
    const signalFile = join(dir, "restart.signal");
    const inProgressFile = join(dir, "restart-in-progress.json");

    expect(consumeRestartSignalFile(signalFile, inProgressFile)).toBeNull();
    expect(existsSync(inProgressFile)).toBe(false);
  });

  it("replaces a stale in-progress signal when claiming a new signal", () => {
    const dir = makeTestDir("restart-signal-stale-in-progress");
    const signalFile = join(dir, "restart.signal");
    const inProgressFile = join(dir, "restart-in-progress.json");
    writeFileSync(inProgressFile, serializeRestartSignal({
      validationMode: "deploy",
      source: "stale",
    }));
    writeFileSync(signalFile, serializeRestartSignal({
      validationMode: "operational",
      source: "new",
      requestedAt: "2026-05-18T20:01:00.000Z",
    }));

    expect(consumeRestartSignalFile(signalFile, inProgressFile)).toEqual({
      requestedAt: "2026-05-18T20:01:00.000Z",
      validationMode: "operational",
      source: "new",
    });
    expect(existsSync(signalFile)).toBe(false);
    expect(parseRestartSignalContent(readFileSync(inProgressFile, "utf-8")).source).toBe("new");
  });
});
