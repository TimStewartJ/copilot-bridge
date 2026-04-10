import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { SessionManager } from "../session-manager.js";
import { createEventBusRegistry } from "../event-bus.js";
import { createSessionTitlesStore } from "../session-titles.js";
import { setupTestDb, createTestBus } from "./helpers.js";

describe("SessionManager session config", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("injects research guidance into the default system message", () => {
    const db = setupTestDb();
    const copilotHome = mkdtempSync(join(tmpdir(), "bridge-session-config-"));
    tempDirs.push(copilotHome);
    const manager = new SessionManager({
      tools: [],
      globalBus: createTestBus(),
      eventBusRegistry: createEventBusRegistry(),
      sessionTitles: createSessionTitlesStore(db),
      taskStore: {} as any,
      config: { sessionMcpServers: {} },
      copilotHome,
    }) as any;

    const cfg = manager.buildSessionConfig();

    expect(cfg.systemMessage.content).toContain("<research_behavior>");
    expect(cfg.systemMessage.content).toContain("verify it online before answering confidently");
    expect(cfg.systemMessage.content).toContain("Split independent claims into separate checks");
    expect(cfg.systemMessage.content).toContain("run those checks in parallel when practical");
    expect(cfg.systemMessage.content).toContain("Skip unnecessary browsing for purely local codebase work");
    expect(cfg.systemMessage.sections.web_fetch).toMatchObject({
      action: "append",
    });
    expect(cfg.systemMessage.sections.web_fetch.content).toContain("<browser_escalation>");
  });
});
