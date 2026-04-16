import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { dependencySyncHash, preparePatchedPackagesForInstall } from "../dependency-sync.js";

function createProjectDir(prefix: string, patchRelativePath?: string, patchContent = "patch") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "bridge-test" }));
  writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ lockfileVersion: 3 }));

  if (patchRelativePath) {
    const patchPath = join(dir, patchRelativePath);
    mkdirSync(dirname(patchPath), { recursive: true });
    writeFileSync(patchPath, patchContent);
  }

  return dir;
}

describe("dependencySyncHash", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("changes when patch-package content changes", () => {
    const a = createProjectDir("bridge-deps-a-", "patches/@github+copilot+1.0.29.patch", "one");
    const b = createProjectDir("bridge-deps-b-", "patches/@github+copilot+1.0.29.patch", "two");
    tempDirs.push(a, b);

    expect(dependencySyncHash(a)).not.toBe(dependencySyncHash(b));
  });

  it("changes when a patch file is renamed", () => {
    const a = createProjectDir("bridge-deps-a-", "patches/@github+copilot+1.0.23.patch");
    const b = createProjectDir("bridge-deps-b-", "patches/@github+copilot+1.0.29.patch");
    tempDirs.push(a, b);

    expect(dependencySyncHash(a)).not.toBe(dependencySyncHash(b));
  });

  it("backs up and restores installed packages targeted by patch-package files", () => {
    const dir = createProjectDir("bridge-deps-reset-", "patches/@github+copilot+1.0.29.patch");
    tempDirs.push(dir);

    const packageDir = join(dir, "node_modules", "@github", "copilot");
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: "@github/copilot" }));

    const prepared = preparePatchedPackagesForInstall(dir);
    expect(prepared.packages).toEqual(["@github/copilot"]);
    expect(existsSync(packageDir)).toBe(false);

    prepared.restore();
    expect(existsSync(packageDir)).toBe(true);
  });

  it("handles nested patch-package filenames", () => {
    const dir = createProjectDir("bridge-deps-nested-", "patches/banana++apple+0.4.2.patch");
    tempDirs.push(dir);

    const packageDir = join(dir, "node_modules", "banana", "node_modules", "apple");
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: "apple" }));

    const prepared = preparePatchedPackagesForInstall(dir);
    expect(prepared.packages).toEqual(["banana/apple"]);
    expect(existsSync(packageDir)).toBe(false);

    prepared.restore();
    expect(existsSync(packageDir)).toBe(true);
  });
});
