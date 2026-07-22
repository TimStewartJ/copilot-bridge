import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyBuildStamp, writeBuildStamp } from "../build-stamp.js";
import { makeTestDir } from "./helpers.js";

function createBuildFixture(): string {
  const rootDir = makeTestDir("build-stamp");
  for (const path of [
    "src",
    "public",
    join("dist", "client"),
    join("dist", "server"),
  ]) {
    mkdirSync(join(rootDir, path), { recursive: true });
  }
  writeFileSync(join(rootDir, "src", "index.ts"), "export const value = 1;\n");
  writeFileSync(join(rootDir, "public", "manifest.json"), "{}\n");
  writeFileSync(join(rootDir, "package.json"), "{}\n");
  writeFileSync(join(rootDir, "package-lock.json"), "{}\n");
  writeFileSync(join(rootDir, "tsconfig.json"), "{}\n");
  writeFileSync(join(rootDir, "tsconfig.client.json"), "{}\n");
  writeFileSync(join(rootDir, "vite.config.ts"), "export default {};\n");
  writeFileSync(join(rootDir, "dist", "client", "index.html"), "<main></main>\n");
  writeFileSync(join(rootDir, "dist", "server", "index.js"), "export {};\n");
  return rootDir;
}

describe("build stamps", () => {
  it("verifies unchanged inputs and outputs", () => {
    const rootDir = createBuildFixture();
    const stamp = writeBuildStamp(rootDir, "commit-a");

    expect(verifyBuildStamp(rootDir, "commit-a")).toEqual(stamp);
  });

  it("rejects changed build inputs", () => {
    const rootDir = createBuildFixture();
    writeBuildStamp(rootDir, "commit-a");
    writeFileSync(join(rootDir, "src", "index.ts"), "export const value = 2;\n");

    expect(() => verifyBuildStamp(rootDir, "commit-a")).toThrow("Build inputs changed");
  });

  it("rejects changed build output", () => {
    const rootDir = createBuildFixture();
    writeBuildStamp(rootDir, "commit-a");
    writeFileSync(join(rootDir, "dist", "server", "index.js"), "throw new Error();\n");

    expect(() => verifyBuildStamp(rootDir, "commit-a")).toThrow("Build output changed");
  });

  it("rejects a different commit", () => {
    const rootDir = createBuildFixture();
    writeBuildStamp(rootDir, "commit-a");

    expect(() => verifyBuildStamp(rootDir, "commit-b")).toThrow("current commit");
  });
});
