import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  consumeRestartSignalFile,
  parseRestartSignalContent,
  serializeRestartSignal,
  writeRestartSignalFile,
} from "../restart-signal.js";
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
      requestId: "restart-request-1",
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
      requestId: "restart-request-1",
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

  it("rejects every present malformed release candidate instead of downgrading it", () => {
    const releaseCandidate = {
      id: "slot-a",
      root: "/release-slots/slot-a",
      commitSha: "abc123",
      source: "self_update",
      dependencyHash: "deps123",
    };
    for (const field of Object.keys(releaseCandidate) as (keyof typeof releaseCandidate)[]) {
      expect(
        () => parseRestartSignalContent(JSON.stringify({
          validationMode: "deploy",
          releaseCandidate: { ...releaseCandidate, [field]: " " },
        })),
        field,
      ).toThrow(/releaseCandidate must include non-empty/);
    }
    expect(() => parseRestartSignalContent(JSON.stringify({
      validationMode: "deploy",
      releaseCandidate: null,
    }))).toThrow("Restart signal releaseCandidate must be an object");
  });

  it("ignores additive candidate fields while preserving required metadata", () => {
    expect(parseRestartSignalContent(JSON.stringify({
      validationMode: "deploy",
      releaseCandidate: {
        id: "slot-a",
        root: "/release-slots/slot-a",
        commitSha: "abc123",
        source: "self_update",
        dependencyHash: "deps123",
        createdAt: "2026-05-18T20:00:00.000Z",
      },
    })).releaseCandidate).toEqual({
      id: "slot-a",
      root: "/release-slots/slot-a",
      commitSha: "abc123",
      source: "self_update",
      dependencyHash: "deps123",
    });
  });

  it("claims a signal by renaming to the in-progress file and classifies invalid claims", () => {
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
      status: "claimed",
      signal: {
        requestedAt: "2026-05-18T20:00:00.000Z",
        validationMode: "operational",
        source: "self_restart",
      },
    });
    expect(existsSync(signalFile)).toBe(false);
    expect(parseRestartSignalContent(readFileSync(inProgressFile, "utf-8"))).toEqual({
      requestedAt: "2026-05-18T20:00:00.000Z",
      validationMode: "operational",
      source: "self_restart",
    });

    // Invalid claim: identity remains available for request-scoped terminal cleanup.
    const dir2 = makeTestDir("restart-signal-invalid-claim");
    const signalFile2 = join(dir2, "restart.signal");
    const inProgressFile2 = join(dir2, "restart-in-progress.json");
    writeFileSync(signalFile2, JSON.stringify({
      requestId: "restart-request-invalid",
      validationMode: "deploy",
      releaseCandidate: {
        id: "slot-invalid",
        root: "",
        commitSha: "abc123",
        source: "self_update",
        dependencyHash: "deps123",
      },
    }));

    expect(consumeRestartSignalFile(signalFile2, inProgressFile2)).toMatchObject({
      status: "invalid",
      requestId: "restart-request-invalid",
      releaseCandidateId: "slot-invalid",
      error: expect.objectContaining({ message: expect.stringContaining("releaseCandidate") }),
    });
    expect(existsSync(signalFile2)).toBe(false);
    expect(existsSync(inProgressFile2)).toBe(true);
  });

  it("returns none when there is no signal to claim", () => {
    const dir = makeTestDir("restart-signal-missing");
    const signalFile = join(dir, "restart.signal");
    const inProgressFile = join(dir, "restart-in-progress.json");

    expect(consumeRestartSignalFile(signalFile, inProgressFile)).toEqual({ status: "none" });
    expect(existsSync(inProgressFile)).toBe(false);
  });

  it("retries reading an already claimed in-progress signal without a new rename", () => {
    const dir = makeTestDir("restart-signal-existing-claim");
    const signalFile = join(dir, "restart.signal");
    const inProgressFile = join(dir, "restart-in-progress.json");
    writeFileSync(inProgressFile, serializeRestartSignal({
      validationMode: "operational",
      requestId: "restart-request-existing-claim",
      source: "self_restart",
    }));

    expect(consumeRestartSignalFile(signalFile, inProgressFile)).toMatchObject({
      status: "claimed",
      signal: {
        requestId: "restart-request-existing-claim",
        validationMode: "operational",
      },
    });
    expect(existsSync(inProgressFile)).toBe(true);
  });

  it("keeps pre-claim filesystem failures retryable without consuming the signal", () => {
    const dir = makeTestDir("restart-signal-preclaim-error");
    const signalFile = join(dir, "restart.signal");
    const blockedParent = join(dir, "not-a-directory");
    writeFileSync(blockedParent, "blocked");
    writeFileSync(signalFile, serializeRestartSignal({
      validationMode: "operational",
      source: "self_restart",
    }));

    expect(consumeRestartSignalFile(
      signalFile,
      join(blockedParent, "restart-in-progress.json"),
    )).toMatchObject({
      status: "retryable-error",
      stage: "claim",
    });
    expect(existsSync(signalFile)).toBe(true);
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
      status: "claimed",
      signal: {
        requestedAt: "2026-05-18T20:01:00.000Z",
        validationMode: "operational",
        source: "new",
      },
    });
    expect(existsSync(signalFile)).toBe(false);
    expect(parseRestartSignalContent(readFileSync(inProgressFile, "utf-8")).source).toBe("new");
  });

  it("publishes through a same-directory temp and cleans it after success or failure", () => {
    const dir = makeTestDir("restart-signal-atomic-publish");
    const signalFile = join(dir, "restart.signal");
    writeRestartSignalFile(signalFile, {
      validationMode: "operational",
      requestId: "restart-request-atomic",
      source: "self_restart",
    });

    expect(parseRestartSignalContent(readFileSync(signalFile, "utf8"))).toMatchObject({
      requestId: "restart-request-atomic",
      validationMode: "operational",
      source: "self_restart",
    });
    expect(readdirSync(dir).filter((entry) => entry.startsWith(".restart.signal."))).toEqual([]);

    const failureDir = makeTestDir("restart-signal-atomic-cleanup");
    const blockedSignalFile = join(failureDir, "restart.signal");
    mkdirSync(blockedSignalFile);
    expect(() => writeRestartSignalFile(blockedSignalFile, {
      validationMode: "operational",
      requestId: "restart-request-failure",
      source: "self_restart",
    })).toThrow();
    expect(readdirSync(failureDir).filter((entry) => entry.startsWith(".restart.signal."))).toEqual([]);
    expect(existsSync(blockedSignalFile)).toBe(true);
  });
});
