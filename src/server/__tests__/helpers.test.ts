import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestApp, makeTestDir, makeTestRuntimePaths, withTestEnv } from "./helpers.js";

describe("test helper runtime isolation", () => {
  let previousDir: string | undefined;

  it("creates tracked temp directories", () => {
    previousDir = makeTestDir("cleanup");
    writeFileSync(join(previousDir, "marker.txt"), "ok");

    expect(existsSync(previousDir)).toBe(true);
  });

  it("cleans tracked temp directories after each test", () => {
    expect(previousDir).toBeDefined();
    expect(existsSync(previousDir!)).toBe(false);
  });

  it("builds explicit isolated runtime paths", () => {
    const runtimePaths = makeTestRuntimePaths("runtime");

    expect(existsSync(runtimePaths.dataDir)).toBe(true);
    expect(existsSync(runtimePaths.docsDir)).toBe(true);
    expect(existsSync(runtimePaths.copilotHome!)).toBe(true);
    expect(runtimePaths.env.BRIDGE_DATA_DIR).toBe(runtimePaths.dataDir);
    expect(runtimePaths.env.BRIDGE_DOCS_DIR).toBe(runtimePaths.docsDir);
    expect(runtimePaths.env.COPILOT_HOME).toBe(runtimePaths.copilotHome);
    expect(runtimePaths.dataDir.startsWith(process.cwd())).toBe(false);
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
    expect(ctx.runtimePaths!.dataDir.startsWith(process.cwd())).toBe(false);
    expect(ctx.runtimePaths!.env.COPILOT_HOME).toBe(ctx.copilotHome);
  });

  it("passes explicit runtime paths into stores created by createTestApp", () => {
    const runtimePaths = makeTestRuntimePaths("demo-app", { demoMode: true });
    const { ctx } = createTestApp({ runtimePaths });

    const task = ctx.taskStore.createTask("Demo task");

    expect(task.cwd).toBe(runtimePaths.workspaceDir);
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
