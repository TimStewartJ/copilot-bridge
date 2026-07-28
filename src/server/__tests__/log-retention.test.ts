import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createRetentionSweepScheduler,
  pruneRetainedLogFiles,
  removeRetainedFiles,
  resolveLogRetentionPolicy,
  RETENTION_DAY_MS,
  selectRetentionDeletions,
} from "../log-retention.js";
import { makeTestDir } from "./helpers.js";

const NOW_MS = Date.parse("2026-07-01T00:00:00.000Z");
const POLICY_ENV = {
  maxAgeDaysEnvKey: "BRIDGE_TEST_MAX_AGE_DAYS",
  maxCountEnvKey: "BRIDGE_TEST_MAX_COUNT",
  defaultMaxAgeDays: 14,
  defaultMaxCount: 100,
};

function seedFile(dir: string, name: string, ageMs: number): string {
  const path = join(dir, name);
  writeFileSync(path, name);
  const modified = new Date(NOW_MS - ageMs);
  utimesSync(path, modified, modified);
  return path;
}

function entry(id: string, ageMs: number, isProtected = false) {
  return { id, timestampMs: NOW_MS - ageMs, protected: isProtected };
}

describe("log retention policy", () => {
  it("resolves defaults, env overrides, and explicit overrides", () => {
    expect(resolveLogRetentionPolicy({ ...POLICY_ENV, env: {} })).toEqual({
      maxAgeMs: 14 * RETENTION_DAY_MS,
      maxCount: 100,
    });

    expect(resolveLogRetentionPolicy({
      ...POLICY_ENV,
      env: { BRIDGE_TEST_MAX_AGE_DAYS: "3", BRIDGE_TEST_MAX_COUNT: "25" },
    })).toEqual({ maxAgeMs: 3 * RETENTION_DAY_MS, maxCount: 25 });

    expect(resolveLogRetentionPolicy({
      ...POLICY_ENV,
      env: { BRIDGE_TEST_MAX_AGE_DAYS: "0", BRIDGE_TEST_MAX_COUNT: "not-a-number" },
    })).toEqual({ maxAgeMs: 14 * RETENTION_DAY_MS, maxCount: 100 });

    expect(resolveLogRetentionPolicy({
      ...POLICY_ENV,
      env: { BRIDGE_TEST_MAX_COUNT: "25" },
      overrides: { maxCount: 5 },
    }).maxCount).toBe(5);
  });

  it("selects artifacts past the age cap and past the newest count", () => {
    const entries = [
      entry("newest", 0),
      entry("recent", RETENTION_DAY_MS),
      entry("older", 2 * RETENTION_DAY_MS),
      entry("ancient", 30 * RETENTION_DAY_MS),
    ];

    expect(selectRetentionDeletions(entries, {
      maxAgeMs: 10 * RETENTION_DAY_MS,
      maxCount: Number.POSITIVE_INFINITY,
    }, NOW_MS).map((item) => item.id)).toEqual(["ancient"]);

    expect(selectRetentionDeletions(entries, {
      maxAgeMs: Number.POSITIVE_INFINITY,
      maxCount: 2,
    }, NOW_MS).map((item) => item.id)).toEqual(["older", "ancient"]);
  });

  it("never deletes protected artifacts and keeps them out of the count budget", () => {
    const entries = [
      entry("active-old", 90 * RETENTION_DAY_MS, true),
      entry("terminal-new", 0),
      entry("terminal-old", RETENTION_DAY_MS),
    ];

    const deletions = selectRetentionDeletions(entries, {
      maxAgeMs: 10 * RETENTION_DAY_MS,
      maxCount: 1,
    }, NOW_MS);

    expect(deletions.map((item) => item.id)).toEqual(["terminal-old"]);
  });

  it("orders ties deterministically by id", () => {
    const deletions = selectRetentionDeletions(
      [entry("b", 0), entry("a", 0), entry("c", 0)],
      { maxAgeMs: Number.POSITIVE_INFINITY, maxCount: 1 },
      NOW_MS,
    );

    expect(deletions.map((item) => item.id)).toEqual(["b", "a"]);
  });
});

describe("pruneRetainedLogFiles", () => {
  it("returns an empty result for a missing directory", async () => {
    const result = await pruneRetainedLogFiles({
      dir: join(makeTestDir("retention-missing"), "absent"),
      policy: { maxAgeMs: 0, maxCount: 0 },
    });

    expect(result).toMatchObject({ scanned: 0, deleted: [], failed: 0 });
  });

  it("surfaces unexpected directory read failures instead of reporting a clean sweep", async () => {
    await expect(pruneRetainedLogFiles({
      dir: join(makeTestDir("retention-unreadable"), "bad\u0000dir"),
      policy: { maxAgeMs: 0, maxCount: 0 },
    })).rejects.toMatchObject({ code: "ERR_INVALID_ARG_VALUE" });
  });

  it("deletes aged and excess files while keeping ineligible entries and subdirectories", async () => {
    const dir = makeTestDir("retention-sweep");
    mkdirSync(join(dir, ".tmp"));
    const nested = seedFile(join(dir, ".tmp"), "nested.log", 90 * RETENTION_DAY_MS);
    const keepNotALog = seedFile(dir, "notes.txt", 90 * RETENTION_DAY_MS);
    const ancient = seedFile(dir, "ancient.log", 90 * RETENTION_DAY_MS);
    const newest = seedFile(dir, "newest.log", RETENTION_DAY_MS);
    const middle = seedFile(dir, "middle.log", 2 * RETENTION_DAY_MS);
    const oldest = seedFile(dir, "oldest.log", 3 * RETENTION_DAY_MS);

    const result = await pruneRetainedLogFiles({
      dir,
      policy: { maxAgeMs: 30 * RETENTION_DAY_MS, maxCount: 2 },
      nowMs: NOW_MS,
      graceMs: 0,
      isEligible: (name) => name.endsWith(".log"),
    });

    expect(result.scanned).toBe(4);
    expect(result.deleted.sort()).toEqual([ancient, oldest].sort());
    expect(existsSync(newest)).toBe(true);
    expect(existsSync(middle)).toBe(true);
    expect(existsSync(keepNotALog)).toBe(true);
    expect(existsSync(nested)).toBe(true);
  });

  it("protects named files and files modified inside the grace window", async () => {
    const dir = makeTestDir("retention-protect");
    const active = seedFile(dir, "active.log", 90 * RETENTION_DAY_MS);
    const stillWriting = seedFile(dir, "writing.log", 60_000);
    const stale = seedFile(dir, "stale.log", 90 * RETENTION_DAY_MS);

    const result = await pruneRetainedLogFiles({
      dir,
      policy: { maxAgeMs: RETENTION_DAY_MS, maxCount: 0 },
      nowMs: NOW_MS,
      graceMs: 15 * 60_000,
      isProtected: (name) => name === "active.log",
    });

    expect(result.deleted).toEqual([stale]);
    expect(result.skippedRecent).toBe(1);
    expect(existsSync(active)).toBe(true);
    expect(existsSync(stillWriting)).toBe(true);
  });

  it("prefers the name timestamp over stat when one is provided", async () => {
    const dir = makeTestDir("retention-named");
    const aged = seedFile(dir, "aged.log", 0);
    const fresh = seedFile(dir, "fresh.log", 90 * RETENTION_DAY_MS);

    const result = await pruneRetainedLogFiles({
      dir,
      policy: { maxAgeMs: RETENTION_DAY_MS, maxCount: Number.POSITIVE_INFINITY },
      nowMs: NOW_MS,
      graceMs: 0,
      timestampFromName: (name) => (name === "aged.log" ? NOW_MS - 90 * RETENTION_DAY_MS : NOW_MS),
    });

    expect(result.deleted).toEqual([aged]);
    expect(existsSync(fresh)).toBe(true);
  });
});

describe("removeRetainedFiles", () => {
  it("ignores missing paths and reports recent skips", async () => {
    const dir = makeTestDir("retention-remove");
    const stale = seedFile(dir, "stale.log", RETENTION_DAY_MS);
    const recent = seedFile(dir, "recent.log", 1_000);

    const result = await removeRetainedFiles(
      [stale, recent, join(dir, "missing.log")],
      { nowMs: NOW_MS, graceMs: 60_000 },
    );

    expect(result.deleted).toEqual([stale]);
    expect(result.skippedRecent).toBe(1);
    expect(result.failed).toBe(0);
    expect(existsSync(recent)).toBe(true);
  });
});

describe("createRetentionSweepScheduler", () => {
  it("throttles per key, shares in-flight sweeps, and honors force plus reset", async () => {
    let nowMs = NOW_MS;
    let sweeps = 0;
    let gate: Promise<void> | null = null;
    const scheduler = createRetentionSweepScheduler(
      async (key: string) => {
        sweeps++;
        if (gate) await gate;
        return key;
      },
      { minIntervalMs: 60_000, now: () => nowMs },
    );

    expect(await scheduler.run("dir-a")).toBe("dir-a");
    expect(sweeps).toBe(1);
    expect(await scheduler.run("dir-a")).toBeNull();
    expect(await scheduler.run("dir-b")).toBe("dir-b");
    expect(sweeps).toBe(2);

    expect(await scheduler.run("dir-a", { force: true })).toBe("dir-a");
    expect(sweeps).toBe(3);

    nowMs += 60_000;
    expect(await scheduler.run("dir-a")).toBe("dir-a");
    expect(sweeps).toBe(4);

    scheduler.reset("dir-b");
    expect(await scheduler.run("dir-b")).toBe("dir-b");
    expect(sweeps).toBe(5);

    let openGate = (): void => {};
    gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const first = scheduler.run("dir-c");
    const joined = scheduler.run("dir-c", { force: true });
    expect(sweeps).toBe(6);
    openGate();
    await expect(first).resolves.toBe("dir-c");
    await expect(joined).resolves.toBe("dir-c");
    expect(sweeps).toBe(6);
  });
});
