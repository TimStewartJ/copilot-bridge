import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { isPathAtOrUnder } from "../path-utils.js";
import { makeTestDir, makeTestRuntimePaths, withTestEnv } from "./helpers.js";
import { createTestApp } from "./test-app.js";

describe("test helper runtime isolation", () => {
  it("cleans tracked temp directories after each test", () => {
    const dir = makeTestDir("cleanup");
    writeFileSync(join(dir, "marker.txt"), "ok");
    expect(existsSync(dir)).toBe(true);

    // onTestFinished runs after the shared afterEach cleanup, so this checks
    // cleanup without depending on another test running first.
    onTestFinished(() => {
      expect(existsSync(dir)).toBe(false);
    });
  });

  it("builds explicit isolated runtime paths", () => {
    const runtimePaths = makeTestRuntimePaths("runtime");

    expect(existsSync(runtimePaths.dataDir)).toBe(true);
    expect(existsSync(runtimePaths.docsDir)).toBe(true);
    expect(existsSync(runtimePaths.copilotHome!)).toBe(true);
    expect(runtimePaths.env.BRIDGE_DATA_DIR).toBe(runtimePaths.dataDir);
    expect(runtimePaths.env.BRIDGE_DOCS_DIR).toBe(runtimePaths.docsDir);
    expect(runtimePaths.env.COPILOT_HOME).toBe(runtimePaths.copilotHome);
    expect(isPathAtOrUnder(process.cwd(), runtimePaths.dataDir)).toBe(false);
  });

  it("restores env after scoped mutations", async () => {
    process.env.BRIDGE_DATA_DIR = "original-data"; // xplat-audit-ignore-line: intentionally testing raw env restore behavior
    process.env.TEST_ONLY_VAR = "original-value"; // xplat-audit-ignore-line: intentionally testing raw env restore behavior

    await withTestEnv(
      {
        BRIDGE_DATA_DIR: "isolated-data",
        TEST_ONLY_VAR: "changed-value",
        COPILOT_HOME: undefined,
      },
      async () => {
        expect(process.env.BRIDGE_DATA_DIR).toBe("isolated-data");
        expect(process.env.TEST_ONLY_VAR).toBe("changed-value");
        expect(process.env.COPILOT_HOME).toBeUndefined();
      },
    );

    expect(process.env.BRIDGE_DATA_DIR).toBe("original-data");
    expect(process.env.TEST_ONLY_VAR).toBe("original-value");
    delete process.env.BRIDGE_DATA_DIR; // xplat-audit-ignore-line: intentionally testing raw env restore behavior
    delete process.env.TEST_ONLY_VAR; // xplat-audit-ignore-line: intentionally testing raw env restore behavior
  });

  it("creates isolated app runtime paths by default", () => {
    const { ctx } = createTestApp();

    expect(ctx.runtimePaths).toBeDefined();
    expect(ctx.copilotHome).toBe(ctx.runtimePaths?.copilotHome);
    expect(existsSync(ctx.runtimePaths!.dataDir)).toBe(true);
    expect(isPathAtOrUnder(process.cwd(), ctx.runtimePaths!.dataDir)).toBe(false);
    expect(ctx.runtimePaths!.env.COPILOT_HOME).toBe(ctx.copilotHome);
  });

  it("passes explicit runtime paths into stores created by createTestApp", () => {
    const runtimePaths = makeTestRuntimePaths("explicit-app", { workspaceDir: makeTestDir("explicit-workspace") });
    const { ctx } = createTestApp({ runtimePaths });

    const task = ctx.taskStore.createTask("Runtime task");

    expect(ctx.runtimePaths?.workspaceDir).toBe(runtimePaths.workspaceDir);
    expect(task.cwd).toBeUndefined();
  });

  it("fills in an isolated copilot home when explicit runtime paths omit one", () => {
    const runtimePaths = makeTestRuntimePaths("no-home");
    const { ctx } = createTestApp({
      runtimePaths: {
        ...runtimePaths,
        copilotHome: undefined,
        env: { ...runtimePaths.env, COPILOT_HOME: undefined },
      },
    });

    expect(ctx.copilotHome).toBeDefined();
    expect(existsSync(ctx.copilotHome!)).toBe(true);
    expect(ctx.runtimePaths?.env.COPILOT_HOME).toBe(ctx.copilotHome);
  });
});
