import { symlinkSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDirectoryLink } from "../platform.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    symlinkSync: vi.fn(),
  };
});

const symlinkSyncMock = vi.mocked(symlinkSync);
const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
  });
}

function restorePlatform(): void {
  if (originalPlatformDescriptor) {
    Object.defineProperty(process, "platform", originalPlatformDescriptor);
  }
}

afterEach(() => {
  symlinkSyncMock.mockReset();
  restorePlatform();
});

describe("directory link platform helper", () => {
  it("uses Windows junctions for directory links on Windows", () => {
    setPlatform("win32");
    const cwd = resolve("root");

    expect(createDirectoryLink("link", "target", cwd)).toEqual({ ok: true, output: "" });

    expect(symlinkSyncMock).toHaveBeenCalledWith(
      resolve(cwd, "target"),
      resolve(cwd, "link"),
      "junction",
    );
  });

  it.each(["darwin", "linux"] as const)("uses directory symlinks on %s", (platform) => {
    setPlatform(platform);
    const cwd = resolve("root");

    expect(createDirectoryLink("link", "target", cwd)).toEqual({ ok: true, output: "" });

    expect(symlinkSyncMock).toHaveBeenCalledWith(
      resolve(cwd, "target"),
      resolve(cwd, "link"),
      "dir",
    );
  });

  it("passes paths with shell metacharacters directly to the Node symlink API", () => {
    setPlatform("linux");
    const cwd = resolve("root with spaces");
    const target = "target with spaces & $(danger)";
    const link = "link with spaces ; rm -rf";

    expect(createDirectoryLink(link, target, cwd)).toEqual({ ok: true, output: "" });

    expect(symlinkSyncMock).toHaveBeenCalledWith(
      resolve(cwd, target),
      resolve(cwd, link),
      "dir",
    );
  });
});
