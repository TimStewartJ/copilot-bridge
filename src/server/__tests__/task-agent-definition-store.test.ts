import { describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createTaskAgentDefinitionStore,
  getTaskAgentDefinitionsRoot,
  toCopilotCustomAgentConfig,
} from "../task-agent-definition-store.js";
import { createTaskStore } from "../task-store.js";
import { createTestBus, makeTestDir, setupTestDb } from "./helpers.js";

describe("task agent definition store", () => {
  it("writes standard task-scoped agent profiles and preserves tool tri-state", () => {
    const dataDir = makeTestDir("task-agent-files");
    const store = createTaskAgentDefinitionStore({ dataDir });

    const allTools = store.createTaskAgentDefinition({
      taskId: "task-1",
      name: "migration-reviewer",
      displayName: "Migration Reviewer",
      description: "Reviews migration compatibility",
      prompt: "Review migrations for compatibility regressions.",
      createdBySessionId: "session-1",
    });
    const noTools = store.createTaskAgentDefinition({
      taskId: "task-1",
      name: "architecture-critic",
      description: "Critiques architecture proposals",
      prompt: "Critique the proposed architecture without changing files.",
      tools: [],
      infer: true,
    });

    expect(allTools).toMatchObject({
      taskId: "task-1",
      name: "migration-reviewer",
      displayName: "Migration Reviewer",
      tools: null,
      infer: false,
      userInvocable: true,
      fileName: "migration-reviewer.agent.md",
    });
    expect(noTools).toMatchObject({
      name: "architecture-critic",
      tools: [],
      infer: true,
    });
    expect(toCopilotCustomAgentConfig(allTools)).toEqual({
      name: "migration-reviewer",
      displayName: "Migration Reviewer",
      description: "Reviews migration compatibility",
      prompt: "Review migrations for compatibility regressions.",
      tools: null,
      infer: false,
    });

    const raw = readFileSync(
      join(getTaskAgentDefinitionsRoot(dataDir), "task-1", "migration-reviewer.agent.md"),
      "utf-8",
    );
    expect(raw).toContain("disable-model-invocation: true");
    expect(raw).toContain("user-invocable: true");
    expect(raw).toContain("bridge-task-id: task-1");
    expect(raw).not.toContain("\ntools:");
  });

  it("rejects traversal, platform-reserved names, built-in names, and duplicates", () => {
    const store = createTaskAgentDefinitionStore({ dataDir: makeTestDir("task-agent-validation") });
    const input = {
      taskId: "task-1",
      description: "Writes focused tests",
      prompt: "Write tests only.",
    };

    expect(() => store.createTaskAgentDefinition({
      ...input,
      taskId: "../../escape",
      name: "test-specialist",
    })).toThrow("taskId must be a single path-safe identifier");
    expect(() => store.createTaskAgentDefinition({
      ...input,
      name: "code-review",
    })).toThrow('name "code-review" is reserved');
    expect(() => store.createTaskAgentDefinition({
      ...input,
      name: "con",
    })).toThrow('name "con" is reserved by Windows');

    store.createTaskAgentDefinition({ ...input, name: "test-specialist" });
    expect(() => store.createTaskAgentDefinition({ ...input, name: "test-specialist" }))
      .toThrow("already exists for task task-1");
  });

  it("cleans files after every task-store deletion path", () => {
    const db = setupTestDb();
    const store = createTaskAgentDefinitionStore({ dataDir: makeTestDir("task-agent-delete") });
    const taskStore = createTaskStore(db, createTestBus(), {
      onTaskDeleted: (taskId) => {
        store.removeTaskAgentDefinitions(taskId);
      },
    });

    const direct = taskStore.createTask("Direct");
    const cascade = taskStore.createTask("Cascade");
    const archive = taskStore.createTask("Archive");
    for (const task of [direct, cascade, archive]) {
      store.createTaskAgentDefinition({
        taskId: task.id,
        name: "cleanup-check",
        description: "Cleanup check",
        prompt: "Verify cleanup.",
      });
    }

    taskStore.deleteTask(direct.id);
    taskStore.deleteTaskCascade(cascade.id);
    taskStore.archiveSessionsAndDeleteTask(archive.id);

    for (const task of [direct, cascade, archive]) {
      expect(store.listTaskAgentDefinitions(task.id)).toEqual([]);
    }
    db.close();
  });

  it("logs and skips unreadable profiles instead of bricking task sessions", () => {
    const dataDir = makeTestDir("task-agent-corrupt");
    const store = createTaskAgentDefinitionStore({ dataDir });
    store.createTaskAgentDefinition({
      taskId: "task-1",
      name: "healthy-reviewer",
      description: "Healthy definition",
      prompt: "Review normally.",
    });
    const brokenPath = join(
      getTaskAgentDefinitionsRoot(dataDir),
      "task-1",
      "broken-reviewer.agent.md",
    );
    writeFileSync(brokenPath, "---\ndescription: [broken\n---\nPrompt", "utf-8");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      expect(store.listTaskAgentDefinitions("task-1")).toEqual([
        expect.objectContaining({ name: "healthy-reviewer" }),
      ]);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('Skipping unreadable definition "broken-reviewer.agent.md"'),
        expect.any(Error),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("sweeps only orphan task directories and refuses an empty live-task set", () => {
    const dataDir = makeTestDir("task-agent-orphans");
    const store = createTaskAgentDefinitionStore({ dataDir });
    for (const taskId of ["live-task", "orphan-task"]) {
      store.createTaskAgentDefinition({
        taskId,
        name: "reviewer",
        description: "Reviews work",
        prompt: "Review the work.",
      });
    }

    expect(store.sweepOrphanedTaskAgentDirectories(new Set())).toEqual({
      removed: 0,
      skipped: true,
    });
    expect(store.sweepOrphanedTaskAgentDirectories(new Set(["live-task"]))).toEqual({
      removed: 1,
      skipped: false,
    });
    expect(store.listTaskAgentDefinitions("live-task")).toHaveLength(1);
    expect(existsSync(join(getTaskAgentDefinitionsRoot(dataDir), "orphan-task"))).toBe(false);
  });
});
