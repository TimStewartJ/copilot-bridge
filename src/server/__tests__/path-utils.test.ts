import { posix, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isLocalStagingModule,
  isPathAtOrUnder,
  pathsEqual,
} from "../path-utils.js";
import { testPosixPath, testWindowsPath } from "./test-paths.js";

const win32Options = { platform: "win32" as const, pathApi: win32 };
const linuxOptions = { platform: "linux" as const, pathApi: posix };

describe("path-utils", () => {
  it("matches Windows paths across drive-letter case differences", () => {
    const root = testWindowsPath("bridge-staging", "preview");
    const candidate = testWindowsPath("bridge-staging", "preview", "dist", "server.js")
      .replace(/^C:/, "c:");

    expect(pathsEqual(root, root.replace(/^C:/, "c:"), win32Options)).toBe(true);
    expect(isPathAtOrUnder(root, root.replace(/^C:/, "c:"), win32Options)).toBe(true);
    expect(isPathAtOrUnder(root, candidate, win32Options)).toBe(true);
  });

  it("keeps Linux path containment case-sensitive", () => {
    const logsDir = testPosixPath("data", "logs");
    const caseDifferentLog = testPosixPath("data", "LOGS", "update-test.log");

    expect(isPathAtOrUnder(logsDir, caseDifferentLog, linuxOptions)).toBe(false);
  });

  it("detects a local staging module across Windows drive-letter case differences", () => {
    const stagingRoot = testWindowsPath("bridge-staging", "preview");
    const dataDir = win32.join(stagingRoot, "data");
    const modulePath = win32.join(stagingRoot, "dist", "server", "path-utils.js")
      .replace(/^C:/, "c:");

    expect(isLocalStagingModule(
      { runtimePaths: { dataDir } },
      { modulePath, ...win32Options },
    )).toBe(true);
  });
});
