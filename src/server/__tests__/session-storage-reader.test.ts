import { describe, expect, it } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  createSessionStorageReader,
  type SessionStorageFileSystem,
} from "../session-storage-reader.js";
import { makeTestDir } from "./helpers.js";

describe("session storage reader", () => {
  it("returns recursive totals for nested session files", async () => {
    const sessionStateDir = makeTestDir("session-storage-nested");
    const sessionDir = join(sessionStateDir, "session-1");
    mkdirSync(join(sessionDir, "files", "deep"), { recursive: true });
    writeFileSync(join(sessionDir, "events.jsonl"), "events");
    writeFileSync(join(sessionDir, "files", "artifact.txt"), "artifact");
    writeFileSync(join(sessionDir, "files", "deep", "trace.json"), "trace");

    const measurement = await createSessionStorageReader(sessionStateDir).measureSession("session-1");

    expect(measurement).toEqual({
      status: "complete",
      diskSizeBytes: "events".length + "artifact".length + "trace".length,
    });
  });

  it("distinguishes a missing session directory from an empty one", async () => {
    const sessionStateDir = makeTestDir("session-storage-missing");

    const measurement = await createSessionStorageReader(sessionStateDir).measureSession("missing-session");

    expect(measurement).toEqual({
      status: "missing",
      diskSizeBytes: 0,
      warning: {
        code: "missing",
        message: "Session storage directory is missing.",
      },
    });
  });

  it("returns a partial lower bound when a file stat fails", async () => {
    const sessionStateDir = makeTestDir("session-storage-partial");
    const sessionDir = join(sessionStateDir, "session-1");
    const blockedPath = join(sessionDir, "blocked.bin");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "readable.bin"), "readable bytes");
    writeFileSync(blockedPath, "blocked bytes");

    const reader = createSessionStorageReader(sessionStateDir, {
      fs: {
        stat: async (filePath) => {
          if (filePath === blockedPath) {
            throw Object.assign(new Error("permission denied"), { code: "EACCES" });
          }
          return stat(filePath);
        },
      },
    });

    const measurement = await reader.measureSession("session-1");

    expect(measurement).toMatchObject({
      status: "partial",
      diskSizeBytes: "readable bytes".length,
      warning: {
        code: "partial",
        message: expect.stringContaining("EACCES"),
      },
    });
  });

  it("bounds filesystem concurrency across simultaneous session measurements", async () => {
    const sessionStateDir = makeTestDir("session-storage-concurrency");
    const sessionIds = Array.from({ length: 12 }, (_, index) => `session-${index}`);
    for (const sessionId of sessionIds) {
      const sessionDir = join(sessionStateDir, sessionId);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(join(sessionDir, "events.jsonl"), sessionId);
    }

    let activeOperations = 0;
    let maxActiveOperations = 0;
    async function trackOperation<T>(operation: () => Promise<T>): Promise<T> {
      activeOperations += 1;
      maxActiveOperations = Math.max(maxActiveOperations, activeOperations);
      await new Promise<void>((resolve) => setImmediate(resolve));
      try {
        return await operation();
      } finally {
        activeOperations -= 1;
      }
    }

    const trackedFileSystem: SessionStorageFileSystem = {
      readdir: (dirPath) => trackOperation(() => readdir(dirPath, { withFileTypes: true })),
      stat: (filePath) => trackOperation(() => stat(filePath)),
    };
    const reader = createSessionStorageReader(sessionStateDir, {
      concurrency: 3,
      fs: trackedFileSystem,
    });

    const measurements = await Promise.all(
      sessionIds.map((sessionId) => reader.measureSession(sessionId)),
    );

    expect(maxActiveOperations).toBe(3);
    expect(measurements.map((measurement) => measurement.diskSizeBytes)).toEqual(
      sessionIds.map((sessionId) => sessionId.length),
    );
  });
});
