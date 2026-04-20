import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createEventBusRegistry } from "../event-bus.js";
import { SessionManager, createBridgeTools, createSessionManager } from "../session-manager.js";
import { createSessionTitlesStore } from "../session-titles.js";
import { resolveRuntimePaths } from "../runtime-paths.js";
import { createTestApp, createTestBus, setupTestDb } from "./helpers.js";

describe("session-manager demo mode", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function createDemoRuntimePaths() {
    const demoDataDir = mkdtempSync(join(tmpdir(), "bridge-demo-session-manager-"));
    tempDirs.push(demoDataDir);
    return resolveRuntimePaths({}, {
      demoMode: true,
      dataDir: demoDataDir,
      docsDir: join(demoDataDir, "docs"),
      copilotHome: join(demoDataDir, ".copilot"),
      workspaceDir: join(demoDataDir, "workspace"),
    });
  }

  it("hides restart and staging tools in demo mode", () => {
    const runtimePaths = createDemoRuntimePaths();
    const { ctx } = createTestApp({ copilotHome: runtimePaths.copilotHome, runtimePaths });

    const toolNames = createBridgeTools(ctx).map((tool: { name: string }) => tool.name);

    expect(toolNames).not.toContain("self_restart");
    expect(toolNames).not.toContain("self_update");
    expect(toolNames).not.toContain("staging_init");
    expect(toolNames).not.toContain("staging_preview");
    expect(toolNames).not.toContain("staging_deploy");
    expect(toolNames).not.toContain("staging_cleanup");
  });

  it("defaults sessions into the demo workspace and suppresses staging instructions", () => {
    const runtimePaths = createDemoRuntimePaths();
    const db = setupTestDb();
    const copilotHome = mkdtempSync(join(tmpdir(), "bridge-demo-copilot-home-"));
    tempDirs.push(copilotHome);

    const manager = new SessionManager({
      tools: [],
      globalBus: createTestBus(),
      eventBusRegistry: createEventBusRegistry(),
      sessionTitles: createSessionTitlesStore(db),
      taskStore: {} as any,
      config: { sessionMcpServers: {} },
      copilotHome,
      runtimePaths,
    }) as any;

    const cfg = manager.buildSessionConfig({
      task: {
        id: "demo-task",
        title: "Demo task",
        status: "active",
        notes: "",
        workItems: [],
        pullRequests: [],
      },
    });

    expect(cfg.workingDirectory).toBe(runtimePaths.workspaceDir);
    expect(cfg.systemMessage.content).toContain("<demo_mode>");
    expect(cfg.systemMessage.sections.code_change_rules).toBeUndefined();
  });

  it("synthesizes runtime paths into the client environment by default", () => {
    const runtimePaths = createDemoRuntimePaths();
    const { ctx } = createTestApp({ copilotHome: runtimePaths.copilotHome, runtimePaths });

    const manager = createSessionManager(ctx, {
      tools: [],
      config: { sessionMcpServers: {} },
      runtimePaths,
    }) as any;

    expect(manager.deps.copilotHome).toBe(runtimePaths.copilotHome);
    expect(manager.deps.clientEnv?.COPILOT_HOME).toBe(runtimePaths.copilotHome);
    expect(manager.deps.clientEnv?.BRIDGE_DEMO_MODE).toBe("true");
    expect(manager.deps.clientEnv?.BRIDGE_DATA_DIR).toBe(runtimePaths.dataDir);
  });
});
