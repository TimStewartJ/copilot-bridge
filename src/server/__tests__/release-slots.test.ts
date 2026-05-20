import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  it("prepares an inactive slot with owned dependencies and copied source exclusions", async () => {
    const sourceDir = makeTestDir("release-slot-source");
    const dataDir = makeTestDir("release-slot-data");
    writeSourceFixture(sourceDir);
    const commands: Array<{ command: string; cwd: string }> = [];

    const result = await prepareReleaseSlot({
      sourceDir,
      dataDir,
      commitSha: "abcdef1234567890",
      source: "staging_deploy",
      validationMode: "deploy",
      installCommand: "npm install --test",
      installTimeoutMs: 30_000,
      now: new Date("2026-05-18T20:00:00.000Z"),
      run: async (command, cwd) => {
        commands.push({ command, cwd });
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
  });

  it("prepares when the data directory is inside the source tree", async () => {
    const sourceDir = makeTestDir("release-slot-source-with-nested-data");
    const dataDir = join(sourceDir, "data");
    writeSourceFixture(sourceDir);
    mkdirSync(join(dataDir, "release-slots", ".orphan.tmp", "src"), { recursive: true });
    writeFileSync(join(dataDir, "release-slots", ".orphan.tmp", "src", "stale.ts"), "do-not-copy");
    const commands: Array<{ command: string; cwd: string }> = [];

    const result = await prepareReleaseSlot({
      sourceDir,
      dataDir,
      commitSha: "fedcba9876543210",
      source: "release_update",
      validationMode: "deploy",
      installCommand: "npm install --test",
      installTimeoutMs: 30_000,
      now: new Date("2026-05-18T21:00:00.000Z"),
      run: async (command, cwd) => {
        commands.push({ command, cwd });
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
    expect(existsSync(join(result.manifest.root, "src", "server", "index.ts"))).toBe(true);
    expect(existsSync(join(result.manifest.root, "src", "data", "fixture.ts"))).toBe(true);
    expect(existsSync(join(result.manifest.root, ".github", "workflows", "ci.yml"))).toBe(true);
    expect(existsSync(join(result.manifest.root, "data"))).toBe(false);
    expect(existsSync(join(result.manifest.root, "coverage"))).toBe(false);
    expect(existsSync(join(result.manifest.root, ".vitest-slowest.json"))).toBe(false);
    expect(existsSync(join(result.manifest.root, ".git"))).toBe(false);
    expect(existsSync(join(result.manifest.root, "dist", "stale.txt"))).toBe(false);
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
