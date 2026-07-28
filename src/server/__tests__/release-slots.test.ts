import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { rename } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  getReleaseSlotsDir,
  prepareReleaseSlot,
  pruneReleaseSlots,
  readActiveRelease,
  resolveReleaseCandidate,
  writeActiveRelease,
} from "../release-slots.js";
import type { ValidationCommandOptions } from "../validation-pipeline.js";
import { makeTestDir } from "./helpers.js";

function writeSourceFixture(sourceDir: string): void {
  mkdirSync(join(sourceDir, "src", "server"), { recursive: true });
  mkdirSync(join(sourceDir, "src", "data"), { recursive: true });
  mkdirSync(join(sourceDir, ".github", "workflows"), { recursive: true });
  mkdirSync(join(sourceDir, "coverage"), { recursive: true });
  mkdirSync(join(sourceDir, "data"), { recursive: true });
  mkdirSync(join(sourceDir, "dist"), { recursive: true });
  mkdirSync(join(sourceDir, "node_modules", "left-pad"), { recursive: true });
  mkdirSync(join(sourceDir, ".git"), { recursive: true });
  writeFileSync(join(sourceDir, "package.json"), JSON.stringify({ scripts: { build: "echo build" } }));
  writeFileSync(join(sourceDir, "package-lock.json"), JSON.stringify({ lockfileVersion: 3 }));
  writeFileSync(join(sourceDir, "src", "server", "index.ts"), "console.log('source');\n");
  writeFileSync(join(sourceDir, "src", "data", "fixture.ts"), "export const fixture = true;\n");
  writeFileSync(join(sourceDir, ".github", "workflows", "ci.yml"), "name: ci\n");
  writeFileSync(join(sourceDir, "coverage", "coverage.json"), "do-not-copy");
  writeFileSync(join(sourceDir, "data", "bridge.db"), "do-not-copy");
  writeFileSync(join(sourceDir, "dist", "stale.txt"), "do-not-copy");
  writeFileSync(join(sourceDir, "node_modules", "left-pad", "index.js"), "do-not-copy");
  writeFileSync(join(sourceDir, ".git", "HEAD"), "do-not-copy");
  writeFileSync(join(sourceDir, ".env"), "SECRET=do-not-copy\n");
  writeFileSync(join(sourceDir, ".vitest-slowest.json"), "do-not-copy");
}

describe("release slots", () => {
  it("rejects the release-slots parent directory as a slot root", () => {
    const dataDir = makeTestDir("release-slot-parent-root");
    const releaseSlotsDir = getReleaseSlotsDir(dataDir);
    mkdirSync(join(releaseSlotsDir, "dist", "server"), { recursive: true });
    writeFileSync(join(releaseSlotsDir, "dist", "server", "index.js"), "console.log('unsafe');\n");
    writeFileSync(join(dataDir, "active-release.json"), JSON.stringify({
      version: 1,
      id: "release-slots",
      root: releaseSlotsDir,
      commitSha: "abcdef1234567890",
      source: "test",
      dependencyHash: "hash",
      createdAt: "2026-05-18T20:00:00.000Z",
      validationMode: "deploy",
    }));

    expect(readActiveRelease(dataDir)).toBeNull();
  });

  it("prepares an inactive slot and also when the data directory is inside the source tree", async () => {
    // Standard prepare: owned dependencies and copied source exclusions
    const sourceDir = makeTestDir("release-slot-source");
    const dataDir = makeTestDir("release-slot-data");
    writeSourceFixture(sourceDir);
    const commands: Array<{ command: string; cwd: string; options?: ValidationCommandOptions }> = [];

    const result = await prepareReleaseSlot({
      sourceDir,
      dataDir,
      commitSha: "abcdef1234567890",
      source: "staging_deploy",
      validationMode: "deploy",
      installCommand: "npm install --test",
      installTimeoutMs: 30_000,
      now: new Date("2026-05-18T20:00:00.000Z"),
      run: async (command, cwd, options) => {
        commands.push({ command, cwd, options });
        if (command === "npm install --test") {
          mkdirSync(join(cwd, "node_modules", "installed"), { recursive: true });
          writeFileSync(join(cwd, "node_modules", "installed", "index.js"), "installed");
        }
        if (command === "npm run build") {
          mkdirSync(join(cwd, "dist", "server"), { recursive: true });
          writeFileSync(join(cwd, "dist", "server", "index.js"), "console.log('built');\n");
        }
        return { ok: true, output: "" };
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.output);
    expect(commands.map((entry) => entry.command)).toEqual(["npm install --test", "npm run build"]);
    expect(commands[1]?.options).toMatchObject({ isolateRuntimeEnv: true });
    expect(existsSync(join(result.manifest.root, "src", "server", "index.ts"))).toBe(true);
    expect(existsSync(join(result.manifest.root, "src", "data", "fixture.ts"))).toBe(true);
    expect(existsSync(join(result.manifest.root, ".github", "workflows", "ci.yml"))).toBe(true);
    expect(existsSync(join(result.manifest.root, "node_modules", "installed", "index.js"))).toBe(true);
    expect(existsSync(join(result.manifest.root, "data"))).toBe(false);
    expect(existsSync(join(result.manifest.root, ".git"))).toBe(false);
    expect(existsSync(join(result.manifest.root, ".env"))).toBe(false);
    expect(existsSync(join(result.manifest.root, ".vitest-slowest.json"))).toBe(false);
    expect(existsSync(join(result.manifest.root, "coverage"))).toBe(false);
    expect(existsSync(join(result.manifest.root, "dist", "stale.txt"))).toBe(false);

    expect(resolveReleaseCandidate(dataDir, result.manifest)).toMatchObject({
      id: result.manifest.id,
      commitSha: "abcdef1234567890",
    });

    await writeActiveRelease(dataDir, result.manifest);
    expect(readActiveRelease(dataDir)).toMatchObject({
      id: result.manifest.id,
      root: result.manifest.root,
    });
    expect(JSON.parse(readFileSync(join(dataDir, "active-release.json"), "utf-8"))).toMatchObject({
      id: result.manifest.id,
    });

    // Data directory inside source tree: must still exclude the data dir and orphan tmps
    const sourceDir2 = makeTestDir("release-slot-source-with-nested-data");
    const dataDir2 = join(sourceDir2, "data");
    writeSourceFixture(sourceDir2);
    mkdirSync(join(dataDir2, "release-slots", ".orphan.tmp", "src"), { recursive: true });
    writeFileSync(join(dataDir2, "release-slots", ".orphan.tmp", "src", "stale.ts"), "do-not-copy");
    const commands2: Array<{ command: string; cwd: string }> = [];

    const result2 = await prepareReleaseSlot({
      sourceDir: sourceDir2,
      dataDir: dataDir2,
      commitSha: "fedcba9876543210",
      source: "release_update",
      validationMode: "deploy",
      installCommand: "npm install --test",
      installTimeoutMs: 30_000,
      now: new Date("2026-05-18T21:00:00.000Z"),
      run: async (command, cwd) => {
        commands2.push({ command, cwd });
        if (command === "npm run build") {
          mkdirSync(join(cwd, "dist", "server"), { recursive: true });
          writeFileSync(join(cwd, "dist", "server", "index.js"), "console.log('built');\n");
        }
        return { ok: true, output: "" };
      },
    });

    expect(result2.ok).toBe(true);
    if (!result2.ok) throw new Error(result2.output);
    expect(commands2.map((entry) => entry.command)).toEqual(["npm install --test", "npm run build"]);
    expect(existsSync(join(result2.manifest.root, "src", "server", "index.ts"))).toBe(true);
    expect(existsSync(join(result2.manifest.root, "src", "data", "fixture.ts"))).toBe(true);
    expect(existsSync(join(result2.manifest.root, ".github", "workflows", "ci.yml"))).toBe(true);
    expect(existsSync(join(result2.manifest.root, "data"))).toBe(false);
    expect(existsSync(join(result2.manifest.root, "coverage"))).toBe(false);
    expect(existsSync(join(result2.manifest.root, ".vitest-slowest.json"))).toBe(false);
    expect(existsSync(join(result2.manifest.root, ".git"))).toBe(false);
    expect(existsSync(join(result2.manifest.root, "dist", "stale.txt"))).toBe(false);
  });

  it("retries transient Windows rename failures and does not retry non-transient failures", async () => {
    // Transient (EPERM/EACCES/EBUSY) failures are retried
    const sourceDir1 = makeTestDir("release-slot-rename-retry-source");
    const dataDir1 = makeTestDir("release-slot-rename-retry-data");
    writeSourceFixture(sourceDir1);
    const waits: number[] = [];
    let attempts = 0;

    const result1 = await prepareReleaseSlot({
      sourceDir: sourceDir1,
      dataDir: dataDir1,
      commitSha: "abcdef1234567890",
      source: "staging_deploy",
      validationMode: "deploy",
      installCommand: "npm install --test",
      installTimeoutMs: 30_000,
      now: new Date("2026-05-18T22:00:00.000Z"),
      run: async (command, cwd) => {
        if (command === "npm run build") {
          mkdirSync(join(cwd, "dist", "server"), { recursive: true });
          writeFileSync(join(cwd, "dist", "server", "index.js"), "console.log('built');\n");
        }
        return { ok: true, output: "" };
      },
      renamePath: async (from, to) => {
        attempts++;
        if (attempts <= 3) {
          const error = new Error("temporarily locked") as NodeJS.ErrnoException;
          error.code = attempts === 1 ? "EPERM" : attempts === 2 ? "EACCES" : "EBUSY";
          throw error;
        }
        await rename(from, to);
      },
      wait: async (delayMs) => {
        waits.push(delayMs);
      },
    });

    expect(result1.ok).toBe(true);
    expect(attempts).toBe(4);
    expect(waits).toEqual([100, 250, 500]);

    // Non-transient (ENOENT) failures are not retried
    const sourceDir2 = makeTestDir("release-slot-rename-failure-source");
    const dataDir2 = makeTestDir("release-slot-rename-failure-data");
    writeSourceFixture(sourceDir2);
    let attempts2 = 0;

    const result2 = await prepareReleaseSlot({
      sourceDir: sourceDir2,
      dataDir: dataDir2,
      commitSha: "abcdef1234567890",
      source: "staging_deploy",
      validationMode: "deploy",
      installCommand: "npm install --test",
      installTimeoutMs: 30_000,
      now: new Date("2026-05-18T23:00:00.000Z"),
      run: async (command, cwd) => {
        if (command === "npm run build") {
          mkdirSync(join(cwd, "dist", "server"), { recursive: true });
          writeFileSync(join(cwd, "dist", "server", "index.js"), "console.log('built');\n");
        }
        return { ok: true, output: "" };
      },
      renamePath: async () => {
        attempts2++;
        const error = new Error("missing source") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      },
      wait: async () => {
        throw new Error("wait should not be called");
      },
    });

    expect(result2).toMatchObject({
      ok: false,
      command: "prepare release slot",
      output: "missing source",
    });
    expect(attempts2).toBe(1);
  });

  it("prunes stale dotted temp directories without removing finalized or live slots", () => {
    const dataDir = makeTestDir("release-slot-prune-temp");
    const releaseParent = getReleaseSlotsDir(dataDir);
    const finalizedSlot = join(releaseParent, "2026-05-18T20-00-00-000Z-abcdef123456-final");
    const staleTemp = join(releaseParent, ".orphan.tmp");
    const liveTemp = join(releaseParent, `.active.${process.pid}.tmp`);

    mkdirSync(join(finalizedSlot, "dist", "server"), { recursive: true });
    writeFileSync(join(finalizedSlot, "dist", "server", "index.js"), "console.log('built');\n");
    mkdirSync(join(staleTemp, "node_modules", "large-package"), { recursive: true });
    writeFileSync(join(staleTemp, "node_modules", "large-package", "index.js"), "stale");
    mkdirSync(join(liveTemp, "src"), { recursive: true });
    writeFileSync(join(liveTemp, "src", "index.ts"), "console.log('active');\n");

    expect(pruneReleaseSlots(dataDir, { keepRecent: 1 })).toBe(1);
    expect(existsSync(staleTemp)).toBe(false);
    expect(existsSync(finalizedSlot)).toBe(true);
    expect(existsSync(liveTemp)).toBe(true);
  });

  it("prunes a stale temp directory whose recorded PID was reused or is not alive", () => {
    // PID reuse: a live process that did not create this directory
    const dataDir1 = makeTestDir("release-slot-prune-pid-reuse");
    const releaseParent1 = getReleaseSlotsDir(dataDir1);
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    try {
      const reusedPidTemp = join(releaseParent1, `.abandoned.${child.pid}.tmp`);
      const recentTemp = join(releaseParent1, `.building.${child.pid}.tmp`);

      mkdirSync(join(reusedPidTemp, "node_modules"), { recursive: true });
      writeFileSync(join(reusedPidTemp, "node_modules", "big.js"), "abandoned");
      mkdirSync(join(recentTemp, "src"), { recursive: true });
      writeFileSync(join(recentTemp, "src", "index.ts"), "building");

      const staleSeconds = (Date.now() - 3 * 60 * 60_000) / 1000;
      utimesSync(reusedPidTemp, staleSeconds, staleSeconds);

      expect(pruneReleaseSlots(dataDir1, { keepRecent: 1 }), "reused PID").toBe(1);
      // PID liveness alone no longer pins an abandoned tree...
      expect(existsSync(reusedPidTemp)).toBe(false);
      // ...but a live PID with recent progress is still protected.
      expect(existsSync(recentTemp)).toBe(true);
    } finally {
      child.kill();
    }

    // Dead PID (above Linux pid_max, never allocated): pruned regardless of age
    const dataDir2 = makeTestDir("release-slot-prune-dead-pid");
    const releaseParent2 = getReleaseSlotsDir(dataDir2);
    // PID 2^22 is above the default Linux pid_max and never allocated here.
    const deadPidTemp = join(releaseParent2, ".crashed.4194303.tmp");
    mkdirSync(deadPidTemp, { recursive: true });
    writeFileSync(join(deadPidTemp, "marker"), "crashed");

    expect(pruneReleaseSlots(dataDir2, { keepRecent: 1 }), "dead PID").toBe(1);
    expect(existsSync(deadPidTemp)).toBe(false);
  });

  it("keeps a temp directory whose PID is alive and whose tree was touched recently", () => {
    const dataDir = makeTestDir("release-slot-prune-live-build");
    const releaseParent = getReleaseSlotsDir(dataDir);
    const liveTemp = join(releaseParent, `.building.${process.pid}.tmp`);
    mkdirSync(join(liveTemp, "src"), { recursive: true });
    writeFileSync(join(liveTemp, "src", "index.ts"), "building");

    expect(pruneReleaseSlots(dataDir, { keepRecent: 1 })).toBe(0);
    expect(existsSync(liveTemp)).toBe(true);
  });

  it("rejects candidate metadata outside the release slot directory", () => {
    const dataDir = makeTestDir("release-slot-invalid");
    expect(resolveReleaseCandidate(dataDir, {
      id: "outside",
      root: makeTestDir("release-slot-outside"),
      commitSha: "abc",
      source: "staging_deploy",
      dependencyHash: "hash",
    })).toBeNull();
  });

  it("accepts packaged update slot manifests from the release updater contract", () => {
    const dataDir = makeTestDir("release-slot-update");
    const id = "2026-05-18t20-00-00-0000000z-abcdef123456-deadbeef";
    const root = join(dataDir, "release-slots", id);
    const manifest = {
      version: 1,
      id,
      root,
      commitSha: "abcdef1234567890",
      source: "release_update",
      dependencyHash: `package-sha256:${"a".repeat(64)}`,
      createdAt: "2026-05-18T20:00:00.000Z",
      validationMode: "deploy",
    };
    mkdirSync(join(root, "dist", "server"), { recursive: true });
    writeFileSync(join(root, "dist", "server", "index.js"), "console.log('release');\n");
    writeFileSync(join(root, "release-slot.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(join(dataDir, "active-release.json"), `${JSON.stringify(manifest, null, 2)}\n`);

    expect(resolveReleaseCandidate(dataDir, {
      id,
      root,
      commitSha: "abcdef1234567890",
      source: "release_update",
      dependencyHash: `package-sha256:${"a".repeat(64)}`,
    })).toMatchObject({ id, root, source: "release_update" });
    expect(readActiveRelease(dataDir)).toMatchObject({ id, root, source: "release_update" });
  });
});
