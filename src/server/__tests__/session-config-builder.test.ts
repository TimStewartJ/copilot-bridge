import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { buildSessionConfig, type SessionConfigBuilderCallbacks, type SessionConfigBuilderDeps } from "../session-config-builder.js";
import type { Task } from "../task-store.js";
import type { SettingsStore } from "../settings-store.js";
import type { ChecklistStore } from "../checklist-store.js";

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Config task",
    kind: "task",
    status: "active",
    notes: "",
    priority: 0,
    order: 0,
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    sessionIds: [],
    workItems: [],
    pullRequests: [],
    ...overrides,
  };
}

function createCallbacks(overrides: Partial<SessionConfigBuilderCallbacks> = {}): SessionConfigBuilderCallbacks {
  return {
    resolveEffectiveSessionCwd: () => "/workspace/project",
    getCopilotHome: () => join("/home", "bridge-user", ".copilot"),
    shouldInjectSelfRenameGuidance: () => false,
    handleUserInputRequest: async () => ({ text: "ok" }) as any,
    ...overrides,
  };
}

function createDeps(overrides: Partial<SessionConfigBuilderDeps> = {}): SessionConfigBuilderDeps {
  return {
    tools: [],
    config: { sessionMcpServers: {} },
    ...overrides,
  };
}

describe("session-config-builder", () => {
  it("renders identity, custom instructions, model settings, and common system guidance", () => {
    const settingsStore = {
      getSettings: () => ({
        mcpServers: { configured: { command: "configured-mcp", args: [] } },
        identity: "Custom Bridge identity",
        customInstructions: "Prefer concise summaries.",
        model: "gpt-test",
        reasoningEffort: "high",
      }),
      updateSettings: vi.fn(),
      getMcpServers: () => ({ configured: { command: "configured-mcp", args: [] } }),
    } as unknown as SettingsStore;

    const cfg = buildSessionConfig({
      deps: createDeps({
        settingsStore,
        config: {
          sessionMcpServers: { fallback: { command: "fallback-mcp", args: [] } },
          model: "config-model",
        },
      }),
      callbacks: createCallbacks(),
    });

    expect(cfg.model).toBe("gpt-test");
    expect(cfg.reasoningEffort).toBe("high");
    expect(cfg.mcpServers).toEqual({ configured: { command: "configured-mcp", args: [] } });
    expect(cfg.systemMessage.sections.identity).toEqual({ action: "replace", content: "Custom Bridge identity" });
    expect(cfg.systemMessage.sections.environment_context.content).toContain("Server timezone:");
    expect(cfg.systemMessage.sections.web_fetch.content).toContain("<browser_escalation>");
    expect(cfg.systemMessage.sections.code_change_rules).toBeUndefined();
    expect(cfg.systemMessage.content).toContain("Prefer concise summaries.");
    expect(cfg.systemMessage.content).toContain("<research_behavior>");
    expect(cfg.systemMessage.content ?? "").not.toContain("call `session_rename`");
  });

  it("includes model and reasoningEffort for new-session paths (forResume omitted/false)", () => {
    const settingsStore = {
      getSettings: () => ({ model: "gpt-new", reasoningEffort: "medium" }),
      getMcpServers: () => ({}),
    } as unknown as SettingsStore;

    const cfg = buildSessionConfig({
      deps: createDeps({ settingsStore, config: { sessionMcpServers: {}, model: "config-fallback" } }),
      callbacks: createCallbacks(),
    });

    expect(cfg.model).toBe("gpt-new");
    expect(cfg.reasoningEffort).toBe("medium");
  });

  it("falls back to config.model when settings.model is unset for new-session paths", () => {
    const settingsStore = {
      getSettings: () => ({ model: undefined, reasoningEffort: undefined }),
      getMcpServers: () => ({}),
    } as unknown as SettingsStore;

    const cfg = buildSessionConfig({
      deps: createDeps({ settingsStore, config: { sessionMcpServers: {}, model: "config-fallback" } }),
      callbacks: createCallbacks(),
    });

    expect(cfg.model).toBe("config-fallback");
    expect(cfg.reasoningEffort).toBeUndefined();
  });

  it("omits model and reasoningEffort when forResume is true", () => {
    const settingsStore = {
      getSettings: () => ({ model: "gpt-new", reasoningEffort: "high" }),
      getMcpServers: () => ({}),
    } as unknown as SettingsStore;

    const cfg = buildSessionConfig({
      deps: createDeps({ settingsStore, config: { sessionMcpServers: {}, model: "config-fallback" } }),
      options: { forResume: true },
      callbacks: createCallbacks(),
    });

    expect(cfg.model).toBeUndefined();
    expect(cfg.reasoningEffort).toBeUndefined();
  });

  it("omits model and reasoningEffort when forResume is true even without settingsStore", () => {
    const cfg = buildSessionConfig({
      deps: createDeps({ config: { sessionMcpServers: {}, model: "config-fallback" } }),
      options: { forResume: true },
      callbacks: createCallbacks(),
    });

    expect(cfg.model).toBeUndefined();
    expect(cfg.reasoningEffort).toBeUndefined();
  });

  it("renders task, schedule, staging, checklist, and self-rename prompt context", async () => {
    const userInputHandler = vi.fn(async () => ({ text: "provided input" }) as any);
    const checklistStore = {
      listChecklistItems: () => [{
        id: "check-1",
        taskId: "task-1",
        text: "Finish extraction",
        done: false,
        order: 0,
        createdAt: "2026-04-01T00:00:00.000Z",
        deadline: "2000-01-01",
      }],
    } as unknown as ChecklistStore;
    const task = createTask({
      notes: "Task note body",
      workItems: [{ id: "ABC-123", provider: "linear" }],
      pullRequests: [{ repoId: "repo-id", repoName: "owner/repo", prId: 42, provider: "github" }],
    });

    const cfg = buildSessionConfig({
      deps: createDeps({ checklistStore }),
      options: {
        sessionId: "session-1",
        task,
        isNewTask: true,
        prDescriptions: ["custom/repo #99"],
        groupNotes: { groupName: "Backend", notes: "Group note body" },
        scheduleContext: { name: "Daily check", type: "cron", runCount: 2 },
      },
      callbacks: createCallbacks({
        resolveEffectiveSessionCwd: () => undefined,
        shouldInjectSelfRenameGuidance: () => true,
        handleUserInputRequest: userInputHandler,
      }),
    });

    await cfg.onUserInputRequest({ prompt: "Need input" } as any, { sessionId: "session-1" });

    expect(userInputHandler).toHaveBeenCalledWith({ prompt: "Need input" }, { sessionId: "session-1" });
    expect(cfg.systemMessage.sections.code_change_rules.content).toContain("<staging_workflow>");
    expect(cfg.systemMessage.content).toContain('You are helping with task "Config task" (taskId: task-1).');
    expect(cfg.systemMessage.content).toContain("call `task_update`");
    expect(cfg.systemMessage.content).toContain("Currently linked work items: #ABC-123 (linear).");
    expect(cfg.systemMessage.content).toContain("Currently linked PRs: custom/repo #99.");
    expect(cfg.systemMessage.content).toContain("Task notes:\nTask note body");
    expect(cfg.systemMessage.content).toContain('Group notes (from task group "Backend" that this task belongs to):\nGroup note body');
    expect(cfg.systemMessage.content).toContain("- [ ] Finish extraction [id: check-1] (due 2000-01-01 ⚠️ OVERDUE)");
    expect(cfg.systemMessage.content).toContain('triggered by schedule "Daily check" (recurring, run #3)');
    expect(cfg.systemMessage.content).toContain("call `session_rename`");
  });
});
