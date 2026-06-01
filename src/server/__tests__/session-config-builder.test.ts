import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { buildSessionConfig, type SessionConfigBuilderCallbacks, type SessionConfigBuilderDeps } from "../session-config-builder.js";
import type { Task } from "../task-store.js";
import type { SettingsStore } from "../settings-store.js";
import type { ChecklistStore } from "../checklist-store.js";
import { makeTestRuntimePaths, setupTestDb } from "./helpers.js";
import { createMcpServerStore } from "../mcp-server-store.js";
import { createTagStore } from "../tag-store.js";
import { resolveBridgeControlRoot } from "../control-root.js";
import {
  GITHUB_COPILOT_MCP_SERVER_NAME,
  GITHUB_COPILOT_MCP_READONLY_URL,
  GITHUB_COPILOT_MCP_WEB_SEARCH_TOOL,
} from "../github-copilot-mcp.js";

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Config task",
    kind: "task",
    muted: false,
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
    handleUserInputRequest: async () => ({ text: "ok" }) as any,
    ...overrides,
  };
}

function createDeps(overrides: Partial<SessionConfigBuilderDeps> = {}): SessionConfigBuilderDeps {
  return {
    config: { sessionMcpServers: {} },
    clientEnv: { BRIDGE_COPILOT_GITHUB_TOKEN: "" },
    ...overrides,
  };
}

function createMcpRegistryDeps() {
  const db = setupTestDb();
  return {
    mcpServerStore: createMcpServerStore(db),
    tagStore: createTagStore(db),
  };
}

const TEST_REPO_ROOT = resolveBridgeControlRoot(join(import.meta.dirname, "..", "..", ".."));

const GPT_55_TIERED_MODEL = {
  id: "gpt-5.5",
  capabilities: {
    limits: {
      max_context_window_tokens: 1_050_000,
      max_prompt_tokens: 922_000,
      max_output_tokens: 128_000,
    },
  },
  billing: {
    tokenPrices: {
      contextMax: 272_000,
      longContext: {
        contextMax: 922_000,
      },
    },
  },
};

const LONG_CONTEXT_CAPABILITIES = {
  limits: {
    max_context_window_tokens: 1_050_000,
    max_prompt_tokens: 922_000,
  },
};

function createGitHubCopilotMcpToolOptions() {
  return {
    additionalTools: [GITHUB_COPILOT_MCP_WEB_SEARCH_TOOL],
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
    expect(cfg.streaming).toBe(true);
    expect(cfg.includeSubAgentStreamingEvents).toBe(false);
    expect(cfg.mcpServers).toEqual({ configured: { command: "configured-mcp", args: [] } });
    expect(cfg.githubMcpToolOptions).toEqual(createGitHubCopilotMcpToolOptions());
    expect(cfg.onPermissionRequest).toBeUndefined();
    expect(cfg.systemMessage.sections.identity).toEqual({ action: "replace", content: "Custom Bridge identity" });
    expect(cfg.systemMessage.sections.environment_context.content).toContain("Server timezone:");
    expect(cfg.systemMessage.sections.web_fetch.content).toContain("<browser_escalation>");
    expect(cfg.systemMessage.sections.code_change_rules).toBeUndefined();
    expect(cfg.systemMessage.content).toContain("Prefer concise summaries.");
    expect(cfg.systemMessage.content).toContain("<research_behavior>");
    expect(cfg.systemMessage.content ?? "").not.toContain("call `session_rename`");
  });

  it("uses the backend permission policy when one is provided", () => {
    const permissionPolicy = vi.fn();

    const cfg = buildSessionConfig({
      deps: createDeps({ permissionPolicy: permissionPolicy as any }),
      callbacks: createCallbacks(),
    });

    expect(cfg.onPermissionRequest).toBe(permissionPolicy);
  });

  it("keeps staging instructions for source-managed release-slot sessions", () => {
    const runtimePaths = makeTestRuntimePaths(
      "source-release-slot-session-config",
      { distributionMode: "release" },
      { BRIDGE_CONTROL_DISTRIBUTION_MODE: "development" },
    );

    const cfg = buildSessionConfig({
      deps: createDeps({ runtimePaths }),
      callbacks: createCallbacks({ resolveEffectiveSessionCwd: () => TEST_REPO_ROOT }),
    });

    expect(cfg.systemMessage.sections.code_change_rules?.content).toContain("staging_deploy");
  });

  it("omits staging instructions when source management is unavailable", () => {
    const runtimePaths = makeTestRuntimePaths(
      "packaged-release-session-config",
      { distributionMode: "release" },
      { BRIDGE_CONTROL_DISTRIBUTION_MODE: "release" },
    );

    const cfg = buildSessionConfig({
      deps: createDeps({ runtimePaths }),
      callbacks: createCallbacks({ resolveEffectiveSessionCwd: () => TEST_REPO_ROOT }),
    });

    expect(cfg.systemMessage.sections.code_change_rules).toBeUndefined();
  });

  it("uses default-enabled registry MCP servers for unlinked sessions", () => {
    const { mcpServerStore } = createMcpRegistryDeps();
    mcpServerStore.createMcpServer({
      name: "Default",
      config: { command: "default-mcp", args: [] },
      enabledByDefault: true,
    });
    mcpServerStore.createMcpServer({
      name: "Opt In",
      config: { command: "opt-in-mcp", args: [] },
    });
    const settingsStore = {
      getSettings: () => ({}),
      getMcpServers: () => ({ stale: { command: "stale-settings-mcp", args: [] } }),
    } as unknown as SettingsStore;

    const cfg = buildSessionConfig({
      deps: createDeps({
        mcpServerStore,
        settingsStore,
        config: { sessionMcpServers: { fallback: { command: "fallback-mcp", args: [] } } },
      }),
      callbacks: createCallbacks(),
    });

    expect(cfg.mcpServers).toEqual({
      Default: { command: "default-mcp", args: [] },
    });
    expect(cfg.githubMcpToolOptions).toEqual(createGitHubCopilotMcpToolOptions());
  });

  it("adds CLI-hosted GitHub Copilot web search MCP when the Bridge Copilot token is configured", () => {
    const cfg = buildSessionConfig({
      deps: createDeps({
        clientEnv: { BRIDGE_COPILOT_GITHUB_TOKEN: "  token-123  " },
      }),
      callbacks: createCallbacks(),
    });

    expect(cfg.mcpServers).toEqual({
      [GITHUB_COPILOT_MCP_SERVER_NAME]: {
        type: "http",
        url: GITHUB_COPILOT_MCP_READONLY_URL,
        headers: {
          Authorization: "Bearer token-123",
          "X-MCP-Host": "copilot-bridge",
          "X-MCP-Readonly": "true",
          "X-MCP-Tools": GITHUB_COPILOT_MCP_WEB_SEARCH_TOOL,
        },
        tools: [GITHUB_COPILOT_MCP_WEB_SEARCH_TOOL],
      },
    });
    expect(cfg.githubMcpToolOptions).toBeUndefined();
  });

  it("requests the SDK-hosted GitHub MCP when no Bridge Copilot token is configured", () => {
    const cfg = buildSessionConfig({
      deps: createDeps({ clientEnv: { BRIDGE_COPILOT_GITHUB_TOKEN: "   " } }),
      callbacks: createCallbacks(),
    });

    expect(cfg.mcpServers).toEqual({});
    expect(cfg.enableConfigDiscovery).toBeUndefined();
    expect(cfg.githubMcpToolOptions).toEqual(createGitHubCopilotMcpToolOptions());
  });

  it("injects Bridge-owned MCP servers and prevents user config from overriding them", () => {
    const bridgeMcp = {
      type: "stdio" as const,
      command: "node",
      args: ["bridge-shim.js"],
      tools: ["tag_list"],
    };
    const cfg = buildSessionConfig({
      deps: createDeps({
        config: {
          sessionMcpServers: {
            "bridge-tools": { command: "malicious-bridge-tools", args: [] },
            custom: { command: "custom-mcp", args: [] },
          },
        },
        builtInMcpServers: {
          "bridge-tools": bridgeMcp,
        },
      }),
      callbacks: createCallbacks(),
    });

    expect(cfg.mcpServers).toEqual({
      custom: { command: "custom-mcp", args: [] },
      "bridge-tools": bridgeMcp,
    });
  });

  it("preserves an existing SDK-named GitHub MCP server instead of adding SDK-hosted GitHub MCP options", () => {
    const cfg = buildSessionConfig({
      deps: createDeps({
        clientEnv: { BRIDGE_COPILOT_GITHUB_TOKEN: "   " },
        config: {
          sessionMcpServers: {
            [GITHUB_COPILOT_MCP_SERVER_NAME]: {
              type: "http",
              url: GITHUB_COPILOT_MCP_READONLY_URL,
              headers: { Authorization: "Bearer manual-token" },
            },
          },
        },
      }),
      callbacks: createCallbacks(),
    });

    expect(cfg.mcpServers).toEqual({
      [GITHUB_COPILOT_MCP_SERVER_NAME]: {
        type: "http",
        url: GITHUB_COPILOT_MCP_READONLY_URL,
        headers: { Authorization: "Bearer manual-token" },
      },
    });
    expect(cfg.githubMcpToolOptions).toBeUndefined();
  });

  it("preserves an existing manual GitHub MCP server when adding Copilot web search", () => {
    const { mcpServerStore } = createMcpRegistryDeps();
    mcpServerStore.createMcpServer({
      name: "github",
      config: {
        type: "http",
        url: "https://api.githubcopilot.com/mcp/",
        headers: {
          Authorization: "Bearer manual-account-token",
          "X-MCP-Toolsets": "repos,pull_requests",
        },
      },
      enabledByDefault: true,
    });

    const cfg = buildSessionConfig({
      deps: createDeps({
        clientEnv: { BRIDGE_COPILOT_GITHUB_TOKEN: "copilot-account-token" },
        mcpServerStore,
      }),
      callbacks: createCallbacks(),
    });

    expect(cfg.mcpServers.github).toEqual({
      type: "http",
      url: "https://api.githubcopilot.com/mcp/",
      headers: {
        Authorization: "Bearer manual-account-token",
        "X-MCP-Toolsets": "repos,pull_requests",
      },
    });
    expect(cfg.mcpServers[GITHUB_COPILOT_MCP_SERVER_NAME].headers.Authorization)
      .toBe("Bearer copilot-account-token");
    expect(cfg.githubMcpToolOptions).toBeUndefined();
  });

  it("adds MCP servers selected by task tags", () => {
    const { mcpServerStore, tagStore } = createMcpRegistryDeps();
    const taskServer = mcpServerStore.createMcpServer({
      name: "Task MCP",
      config: { command: "task-mcp", args: ["serve"] },
    });
    const tag = tagStore.createTag("Task tools");
    tagStore.addTagMcpServerRef(tag.id, taskServer.id);
    tagStore.setEntityTags("task", "task-1", [tag.id]);

    const cfg = buildSessionConfig({
      deps: createDeps({ mcpServerStore, tagStore }),
      options: { task: createTask() },
      callbacks: createCallbacks(),
    });

    expect(cfg.mcpServers).toEqual({
      "Task MCP": { command: "task-mcp", args: ["serve"] },
    });
    expect(cfg.githubMcpToolOptions).toEqual(createGitHubCopilotMcpToolOptions());
  });

  it("preserves GitHub Copilot web search MCP when task tags rebuild MCP selection", () => {
    const { mcpServerStore, tagStore } = createMcpRegistryDeps();
    const taskServer = mcpServerStore.createMcpServer({
      name: "Task MCP",
      config: { command: "task-mcp", args: ["serve"] },
    });

    const tag = tagStore.createTag("Task tools");
    tagStore.addTagMcpServerRef(tag.id, taskServer.id);
    tagStore.setEntityTags("task", "task-1", [tag.id]);

    const cfg = buildSessionConfig({
      deps: createDeps({
        clientEnv: { BRIDGE_COPILOT_GITHUB_TOKEN: "copilot-token" },
        mcpServerStore,
        tagStore,
      }),
      options: { task: createTask() },
      callbacks: createCallbacks(),
    });

    expect(cfg.mcpServers).toEqual({
      "Task MCP": { command: "task-mcp", args: ["serve"] },
      [GITHUB_COPILOT_MCP_SERVER_NAME]: {
        type: "http",
        url: GITHUB_COPILOT_MCP_READONLY_URL,
        headers: {
          Authorization: "Bearer copilot-token",
          "X-MCP-Host": "copilot-bridge",
          "X-MCP-Readonly": "true",
          "X-MCP-Tools": GITHUB_COPILOT_MCP_WEB_SEARCH_TOOL,
        },
        tools: [GITHUB_COPILOT_MCP_WEB_SEARCH_TOOL],
      },
    });
    expect(cfg.githubMcpToolOptions).toBeUndefined();
  });

  it("preserves Bridge-owned MCP servers when task tags rebuild MCP selection", () => {
    const { mcpServerStore, tagStore } = createMcpRegistryDeps();
    const taskServer = mcpServerStore.createMcpServer({
      name: "Task MCP",
      config: { command: "task-mcp", args: ["serve"] },
    });
    const tag = tagStore.createTag("Task tools");
    tagStore.addTagMcpServerRef(tag.id, taskServer.id);
    tagStore.setEntityTags("task", "task-1", [tag.id]);
    const bridgeMcp = {
      type: "stdio" as const,
      command: "node",
      args: ["bridge-shim.js"],
      tools: ["tag_list"],
    };

    const cfg = buildSessionConfig({
      deps: createDeps({
        mcpServerStore,
        tagStore,
        builtInMcpServers: {
          "bridge-tools": bridgeMcp,
        },
      }),
      options: { task: createTask() },
      callbacks: createCallbacks(),
    });

    expect(cfg.mcpServers).toEqual({
      "Task MCP": { command: "task-mcp", args: ["serve"] },
      "bridge-tools": bridgeMcp,
    });
  });

  it("adds MCP servers selected by inherited group tags", () => {
    const { mcpServerStore, tagStore } = createMcpRegistryDeps();
    const groupServer = mcpServerStore.createMcpServer({
      name: "Group MCP",
      config: { type: "http", url: "https://group.example/mcp" },
    });
    const tag = tagStore.createTag("Group tools");
    tagStore.addTagMcpServerRef(tag.id, groupServer.id);
    tagStore.setEntityTags("task_group", "group-1", [tag.id]);

    const cfg = buildSessionConfig({
      deps: createDeps({ mcpServerStore, tagStore }),
      options: { task: createTask({ groupId: "group-1" }) },
      callbacks: createCallbacks(),
    });

    expect(cfg.mcpServers).toEqual({
      "Group MCP": { type: "http", url: "https://group.example/mcp" },
    });
    expect(cfg.githubMcpToolOptions).toEqual(createGitHubCopilotMcpToolOptions());
  });

  it("combines default-enabled, task-tag, and group-tag MCP selections", () => {
    const { mcpServerStore, tagStore } = createMcpRegistryDeps();
    mcpServerStore.createMcpServer({
      name: "Default MCP",
      config: { command: "default-mcp", args: [] },
      enabledByDefault: true,
    });
    const taskServer = mcpServerStore.createMcpServer({
      name: "Task MCP",
      config: { command: "task-mcp", args: [] },
    });
    const groupServer = mcpServerStore.createMcpServer({
      name: "Group MCP",
      config: { type: "sse", url: "https://group.example/sse" },
    });
    const taskTag = tagStore.createTag("Task tools");
    const groupTag = tagStore.createTag("Group tools");
    tagStore.addTagMcpServerRef(taskTag.id, taskServer.id);
    tagStore.addTagMcpServerRef(groupTag.id, groupServer.id);
    tagStore.setEntityTags("task", "task-1", [taskTag.id]);
    tagStore.setEntityTags("task_group", "group-1", [groupTag.id]);

    const cfg = buildSessionConfig({
      deps: createDeps({ mcpServerStore, tagStore }),
      options: { task: createTask({ groupId: "group-1" }) },
      callbacks: createCallbacks(),
    });

    expect(cfg.mcpServers).toEqual({
      "Default MCP": { command: "default-mcp", args: [] },
      "Task MCP": { command: "task-mcp", args: [] },
      "Group MCP": { type: "sse", url: "https://group.example/sse" },
    });
    expect(cfg.githubMcpToolOptions).toEqual(createGitHubCopilotMcpToolOptions());
  });

  it("deduplicates a registry server selected by both default and tag", () => {
    const { mcpServerStore, tagStore } = createMcpRegistryDeps();
    const sharedServer = mcpServerStore.createMcpServer({
      name: "Shared MCP",
      config: { command: "shared-mcp", args: [] },
      enabledByDefault: true,
    });
    const tag = tagStore.createTag("Shared tools");
    tagStore.addTagMcpServerRef(tag.id, sharedServer.id);
    tagStore.setEntityTags("task", "task-1", [tag.id]);

    const cfg = buildSessionConfig({
      deps: createDeps({ mcpServerStore, tagStore }),
      options: { task: createTask() },
      callbacks: createCallbacks(),
    });

    expect(Object.keys(cfg.mcpServers)).toEqual(["Shared MCP"]);
    expect(cfg.mcpServers).toEqual({
      "Shared MCP": { command: "shared-mcp", args: [] },
    });
    expect(cfg.githubMcpToolOptions).toEqual(createGitHubCopilotMcpToolOptions());
  });

  it("deduplicates one registry server selected by task and group tags during resume", () => {
    const { mcpServerStore, tagStore } = createMcpRegistryDeps();
    const sharedServer = mcpServerStore.createMcpServer({
      name: "Shared Tagged MCP",
      config: { command: "shared-tagged-mcp", args: ["serve"] },
    });
    const taskTag = tagStore.createTag("Task tools");
    const groupTag = tagStore.createTag("Group tools");
    tagStore.addTagMcpServerRef(taskTag.id, sharedServer.id);
    tagStore.addTagMcpServerRef(groupTag.id, sharedServer.id);
    tagStore.setEntityTags("task", "task-1", [taskTag.id]);
    tagStore.setEntityTags("task_group", "group-1", [groupTag.id]);

    const cfg = buildSessionConfig({
      deps: createDeps({
        mcpServerStore,
        tagStore,
        settingsStore: {
          getSettings: () => ({ model: "gpt-new", reasoningEffort: "high" }),
          getMcpServers: () => ({}),
        } as unknown as SettingsStore,
      }),
      options: { task: createTask({ groupId: "group-1" }), forResume: true },
      callbacks: createCallbacks(),
    });

    expect(cfg.model).toBeUndefined();
    expect(cfg.reasoningEffort).toBeUndefined();
    expect(cfg.streaming).toBe(true);
    expect(cfg.includeSubAgentStreamingEvents).toBe(false);
    expect(Object.keys(cfg.mcpServers)).toEqual(["Shared Tagged MCP"]);
    expect(cfg.mcpServers).toEqual({
      "Shared Tagged MCP": { command: "shared-tagged-mcp", args: ["serve"] },
    });
    expect(cfg.githubMcpToolOptions).toEqual(createGitHubCopilotMcpToolOptions());
  });

  it("merges legacy tag-owned MCP configs when the registry store is unavailable", () => {
    const settingsStore = {
      getSettings: () => ({}),
      getMcpServers: () => ({ Default: { command: "default-mcp", args: [] } }),
    } as unknown as SettingsStore;
    const tagStore = {
      resolveEffectiveTags: () => ({
        tags: [],
        mergedInstructions: "",
        mcpServerIds: [],
        mergedMcpServers: {
          "Legacy Tag": { type: "sse" as const, url: "https://legacy.example/sse" },
        },
      }),
    } as unknown as ReturnType<typeof createTagStore>;

    const cfg = buildSessionConfig({
      deps: createDeps({ settingsStore, tagStore }),
      options: { task: createTask() },
      callbacks: createCallbacks(),
    });

    expect(cfg.mcpServers).toEqual({
      Default: { command: "default-mcp", args: [] },
      "Legacy Tag": { type: "sse", url: "https://legacy.example/sse" },
    });
    expect(cfg.githubMcpToolOptions).toEqual(createGitHubCopilotMcpToolOptions());
  });

  it("refreshes registry MCP servers while preserving forResume model behavior", () => {
    const { mcpServerStore } = createMcpRegistryDeps();
    mcpServerStore.createMcpServer({
      name: "Resume MCP",
      config: { command: "resume-mcp", args: [] },
      enabledByDefault: true,
    });
    const settingsStore = {
      getSettings: () => ({ model: "gpt-new", reasoningEffort: "high" }),
      getMcpServers: () => ({}),
    } as unknown as SettingsStore;

    const cfg = buildSessionConfig({
      deps: createDeps({ mcpServerStore, settingsStore, config: { sessionMcpServers: {}, model: "config-fallback" } }),
      options: { forResume: true },
      callbacks: createCallbacks(),
    });

    expect(cfg.model).toBeUndefined();
    expect(cfg.reasoningEffort).toBeUndefined();
    expect(cfg.mcpServers).toEqual({
      "Resume MCP": { command: "resume-mcp", args: [] },
    });
    expect(cfg.githubMcpToolOptions).toEqual(createGitHubCopilotMcpToolOptions());
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

  it("includes explicit long-context capabilities for new-session paths", () => {
    const settingsStore = {
      getSettings: () => ({ model: "gpt-5.5", contextTier: "long_context" }),
      getMcpServers: () => ({}),
    } as unknown as SettingsStore;

    const cfg = buildSessionConfig({
      deps: createDeps({ settingsStore }),
      options: { modelMetadata: [GPT_55_TIERED_MODEL] },
      callbacks: createCallbacks(),
    });

    expect(cfg.model).toBe("gpt-5.5");
    expect(cfg.modelCapabilities).toEqual(LONG_CONTEXT_CAPABILITIES);
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
        handleUserInputRequest: userInputHandler,
      }),
    });

    await cfg.onUserInputRequest({ prompt: "Need input" } as any, { sessionId: "session-1" });

    expect(userInputHandler).toHaveBeenCalledWith({ prompt: "Need input" }, { sessionId: "session-1" });
    expect(cfg.systemMessage.sections.code_change_rules.content).toContain("<staging_workflow>");
    expect(cfg.systemMessage.content).toContain('You are helping with task "Config task" (taskId: task-1).');
    expect(cfg.systemMessage.content).toContain("use the task update tool");
    expect(cfg.systemMessage.content).toContain("Currently linked work items: #ABC-123 (linear).");
    expect(cfg.systemMessage.content).toContain("Currently linked PRs: custom/repo #99.");
    expect(cfg.systemMessage.content).toContain("Task notes:\nTask note body");
    expect(cfg.systemMessage.content).toContain('Group notes (from task group "Backend" that this task belongs to):\nGroup note body');
    expect(cfg.systemMessage.content).toContain("- [ ] Finish extraction [id: check-1] (due 2000-01-01 ⚠️ OVERDUE)");
    expect(cfg.systemMessage.content).toContain('triggered by schedule "Daily check" (recurring, run #3)');
    expect(cfg.systemMessage.content).not.toContain("call `session_rename`");
  });
});
