import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  prepareReleaseSlot,
  readActiveRelease,
  resolveReleaseCandidate,
  writeActiveRelease,
} from "../release-slots.js";
import { makeTestDir } from "./helpers.js";

function writeSourceFixture(sourceDir: string): void {
  mkdirSync(join(sourceDir, "src", "server"), { recursive: true });
  mkdirSync(join(sourceDir, "data"), { recursive: true });
  mkdirSync(join(sourceDir, "dist"), { recursive: true });
  mkdirSync(join(sourceDir, "node_modules", "left-pad"), { recursive: true });
  mkdirSync(join(sourceDir, ".git"), { recursive: true });
  writeFileSync(join(sourceDir, "package.json"), JSON.stringify({ scripts: { build: "echo build" } }));
  writeFileSync(join(sourceDir, "package-lock.json"), JSON.stringify({ lockfileVersion: 3 }));
  writeFileSync(join(sourceDir, "src", "server", "index.ts"), "console.log('source');\n");
  writeFileSync(join(sourceDir, "data", "bridge.db"), "do-not-copy");
  writeFileSync(join(sourceDir, "dist", "stale.txt"), "do-not-copy");
  writeFileSync(join(sourceDir, "node_modules", "left-pad", "index.js"), "do-not-copy");
  writeFileSync(join(sourceDir, ".git", "HEAD"), "do-not-copy");
  writeFileSync(join(sourceDir, ".env"), "SECRET=do-not-copy\n");
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
    expect(existsSync(join(result.manifest.root, "node_modules", "installed", "index.js"))).toBe(true);
    expect(existsSync(join(result.manifest.root, "data"))).toBe(false);
    expect(existsSync(join(result.manifest.root, ".git"))).toBe(false);
    expect(existsSync(join(result.manifest.root, ".env"))).toBe(false);
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
});
