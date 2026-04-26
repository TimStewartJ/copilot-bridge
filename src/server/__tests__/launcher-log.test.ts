import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { appendLauncherLogLine, readLauncherLogTail } from "../launcher-log.js";
import { makeTestDir } from "./helpers.js";

let tempDir: string;

beforeEach(() => {
  tempDir = makeTestDir("launcher-log");
  vi.stubEnv("BRIDGE_LAUNCHER_LOG_PATH", join(tempDir, "launcher.log"));
});

describe("launcher log helpers", () => {
  it("appends timestamped launcher lines and tails the most recent entries", () => {
    appendLauncherLogLine("[launcher] first line");
    appendLauncherLogLine("[launcher] second line");

    const tail = readLauncherLogTail(process.env.BRIDGE_LAUNCHER_LOG_PATH, { lines: 1 });

    expect(tail.status).toBe("ok");
    if (tail.status !== "ok") {
      throw new Error("Expected launcher log tail to be available");
    }
    expect(tail.lines).toHaveLength(1);
    expect(tail.lines[0]).toMatch(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\] \[launcher\] second line$/);

    const content = readFileSync(process.env.BRIDGE_LAUNCHER_LOG_PATH!, "utf-8");
    expect(content).toContain("[launcher] first line");
    expect(content).toContain("[launcher] second line");
  });

  it("reports unavailable when no launcher log has been created yet", () => {
    expect(readLauncherLogTail()).toEqual({
      status: "unavailable",
      error: "Launcher log is not available yet. Restart the bridge through the launcher to populate it.",
    });
  });
});
