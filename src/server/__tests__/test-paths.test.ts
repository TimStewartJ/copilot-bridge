import { describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { testPath, withTestSourceCheckout } from "./test-paths.js";

const SOURCE_GIT_PATH = resolve(import.meta.dirname, "..", "..", "..", ".git");

describe("test source checkout fixture", () => {
  it("supplies the source-root marker when host Git metadata is absent", () => {
    const actualExistsSync = vi.fn<typeof import("node:fs").existsSync>(() => false);
    const existsSync = withTestSourceCheckout(actualExistsSync);

    expect(existsSync(SOURCE_GIT_PATH)).toBe(true);
    expect(actualExistsSync).not.toHaveBeenCalled();
  });

  it("does not invent Git metadata for another control root", () => {
    const actualExistsSync = vi.fn<typeof import("node:fs").existsSync>(() => false);
    const existsSync = withTestSourceCheckout(actualExistsSync);
    const gitPath = testPath("other-control-root", ".git");

    expect(existsSync(gitPath)).toBe(false);
    expect(actualExistsSync).toHaveBeenCalledWith(gitPath);
  });

  it.each([true, false])("preserves non-checkout existence results of %s", (result) => {
    const actualExistsSync = vi.fn<typeof import("node:fs").existsSync>(() => result);
    const existsSync = withTestSourceCheckout(actualExistsSync);
    const path = resolve(SOURCE_GIT_PATH, "..", "package.json");

    expect(existsSync(path)).toBe(result);
    expect(actualExistsSync).toHaveBeenCalledWith(path);
  });

  it("delegates Buffer and URL paths without changing them", () => {
    const actualExistsSync = vi.fn<typeof import("node:fs").existsSync>(() => false);
    const existsSync = withTestSourceCheckout(actualExistsSync);

    for (const path of [Buffer.from(testPath("docs")), pathToFileURL(testPath("docs"))]) {
      expect(existsSync(path)).toBe(false);
      expect(actualExistsSync).toHaveBeenCalledWith(path);
    }
  });
});
