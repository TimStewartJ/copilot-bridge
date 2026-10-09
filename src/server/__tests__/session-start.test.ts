import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppContext } from "../app-context.js";
import { getBridgeToolDefinitions } from "../agent-tools-mcp/register.js";
import { normalizeToolResult } from "../agent-tools-mcp/server.js";
import { convertBridgeToolResultToSdk, createNativeBridgeTools } from "../bridge-native-tools.js";
import { createGlobalBus } from "../global-bus.js";
import { createSettingsStore } from "../settings-store.js";
import { createTaskStore } from "../task-store.js";
import { createSessionToolDefinitions } from "../tools/session-tools.js";
import { createMockSessionManager, setupTestDb } from "./helpers.js";

const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const CALLER_ID = "00000000-0000-4000-8000-000000000002";

afterEach(() => vi.restoreAllMocks());

function createHarness() {
  const db = setupTestDb();
  const globalBus = createGlobalBus();
  const taskStore = createTaskStore(db, globalBus);
  const settingsStore = createSettingsStore(db);
  const sessionManager = createMockSessionManager();
  sessionManager.createSession = vi.fn().mockResolvedValue({ sessionId: SESSION_ID });
  sessionManager.createTaskSession = vi.fn().mockResolvedValue({ sessionId: SESSION_ID });
  sessionManager.startWorkAndWaitForDelivery = vi.fn().mockResolvedValue(undefined);
  sessionManager.deleteSession = vi.fn().mockResolvedValue(undefined);
  sessionManager.validateModelSelection = vi.fn().mockResolvedValue({ ok: true });
  const ctx = { globalBus, taskStore, settingsStore, sessionManager } as AppContext;
  const tool = createSessionToolDefinitions(ctx).find((candidate) => candidate.name === "session_start");
  if (!tool) throw new Error("session_start tool not found");
  const call = async (args: Record<string, unknown>, sessionId: string | undefined = CALLER_ID, signal?: AbortSignal) =>
    tool.handler(args, { sessionId, requestId: "start-1", signal });
  return { ctx, tool, call, globalBus, taskStore, settingsStore, sessionManager };
}

describe("session_start", () => {
  it("is registered for native and MCP tools and distinguishes chats from bounded delegation", () => {
    const { ctx, tool } = createHarness();
    expect(getBridgeToolDefinitions(ctx).some((candidate) => candidate.name === "session_start")).toBe(true);
    const [native] = createNativeBridgeTools([tool]);
    expect(native?.name).toBe("session_start");
    expect(native?.defer).toBe("never");
    expect(tool.description).toContain("task sub-agent tool instead");
    expect(tool.description).toContain("no completion report is sent back here");
    expect(tool.inputSchema?.required).toEqual(["prompt"]);
  });

  it("uses defaults for an unlinked chat rather than inheriting the caller's task or history", async () => {
    const { call, taskStore, settingsStore, sessionManager } = createHarness();
    settingsStore.updateSettings({ model: "default-model" });
    const task = taskStore.createTask("Caller task");
    taskStore.linkSession(task.id, CALLER_ID);

    const result = await call({ prompt: "  Prepare a proposal in this separate chat.  " });

    expect(sessionManager.createSession).toHaveBeenCalledWith({});
    expect(sessionManager.createTaskSession).not.toHaveBeenCalled();
    expect(sessionManager.validateModelSelection).not.toHaveBeenCalled();
    expect(sessionManager.startWorkAndWaitForDelivery).toHaveBeenCalledWith(
      SESSION_ID, "Prepare a proposal in this separate chat.",
    );
    expect(taskStore.getTask(task.id)?.sessionIds).toEqual([CALLER_ID]);
    expect(result).toMatchObject({
      success: true, sessionId: SESSION_ID, link: `bridge://session/${SESSION_ID}`, status: "prompt_accepted",
      markdown: `[Open the new chat](bridge://session/${SESSION_ID})`,
    });
  });

  it("leaves the session-created announcement to the shared manager", async () => {
    const { call, sessionManager, globalBus } = createHarness();
    const emit = vi.spyOn(globalBus, "emit");
    sessionManager.createSession = vi.fn().mockImplementation(async () => {
      globalBus.emit({ type: "sessions:changed", sessionId: SESSION_ID });
      return { sessionId: SESSION_ID };
    });
    await call({ prompt: "Work separately." });
    expect(emit).toHaveBeenCalledExactlyOnceWith({ type: "sessions:changed", sessionId: SESSION_ID });
  });

  it("creates with full task context and links before sending the first prompt", async () => {
    const { call, taskStore, sessionManager } = createHarness();
    const task = taskStore.createTask("Separate task conversation");
    taskStore.updateTask(task.id, { notes: "Proposal notes", instructions: "Follow task instructions." });
    const updated = taskStore.getTask(task.id)!;
    sessionManager.startWorkAndWaitForDelivery = vi.fn(async () => {
      expect(taskStore.getTask(task.id)?.sessionIds).toContain(SESSION_ID);
    });

    const result = await call({ taskId: ` ${task.id} `, prompt: "Start the proposal." });

    expect(sessionManager.createTaskSession).toHaveBeenCalledWith(
      updated.id, updated.title, updated.workItems, updated.notes, updated.cwd, undefined, {},
    );
    expect(sessionManager.createSession).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: true, taskId: task.id, taskLinked: true });
  });

  it("waits for prompt acceptance but not for the new chat to finish", async () => {
    const { call, sessionManager } = createHarness();
    let accept!: () => void;
    const accepted = new Promise<void>((resolve) => { accept = resolve; });
    sessionManager.startWorkAndWaitForDelivery = vi.fn(() => accepted);
    let settled = false;
    const result = call({ prompt: "Work independently." }).then((value) => { settled = true; return value; });
    await vi.waitFor(() => expect(sessionManager.startWorkAndWaitForDelivery).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    accept();
    expect(await result).toMatchObject({ success: true, status: "prompt_accepted" });
  });

  it("validates explicit settings and forwards only the overrides", async () => {
    const { call, sessionManager } = createHarness();
    await call({
      prompt: "Draft separately.", model: " selected-model ", reasoningEffort: " high ", contextTier: "long_context",
    });
    expect(sessionManager.validateModelSelection).toHaveBeenCalledWith({
      model: "selected-model", reasoningEffort: "high", contextTier: "long_context",
    });
    expect(sessionManager.createSession).toHaveBeenCalledWith({
      model: "selected-model", reasoningEffort: "high", contextTier: "long_context",
    });
  });

  it("validates effort against the user's default model without overriding that model", async () => {
    const { call, settingsStore, sessionManager } = createHarness();
    settingsStore.updateSettings({ model: "default-model" });
    await call({ prompt: "Draft separately.", reasoningEffort: "medium" });
    expect(sessionManager.validateModelSelection).toHaveBeenCalledWith({
      model: "default-model", reasoningEffort: "medium",
    });
    expect(sessionManager.createSession).toHaveBeenCalledWith({ reasoningEffort: "medium" });
  });

  it.each([
    {}, { prompt: "" }, { prompt: "  " }, { prompt: 42 }, { prompt: "x", taskId: " " },
    { prompt: "x", taskId: "missing-task" }, { prompt: "x", model: 42 },
    { prompt: "x", reasoningEffort: false }, { prompt: "x", contextTier: "huge" },
    { prompt: "x", agent: "undeclared" },
  ])("rejects invalid arguments before creating a chat: %j", async (args) => {
    const { call, sessionManager } = createHarness();
    expect(await call(args)).toMatchObject({ resultType: "failure" });
    expect(sessionManager.createSession).not.toHaveBeenCalled();
    expect(sessionManager.createTaskSession).not.toHaveBeenCalled();
  });

  it("requires an invoking session", async () => {
    const { call, sessionManager } = createHarness();
    expect(await call({ prompt: "x" }, "")).toMatchObject({ resultType: "failure" });
    expect(sessionManager.createSession).not.toHaveBeenCalled();
  });

  it("does not create a chat when cancelled before creation", async () => {
    const { call, sessionManager } = createHarness();
    const controller = new AbortController();
    controller.abort();
    expect(await call({ prompt: "x" }, CALLER_ID, controller.signal)).toMatchObject({ resultType: "failure" });
    expect(sessionManager.createSession).not.toHaveBeenCalled();
  });

  it("does not create a chat when cancelled during model validation", async () => {
    const { call, sessionManager } = createHarness();
    const controller = new AbortController();
    sessionManager.validateModelSelection = vi.fn().mockImplementation(async () => {
      controller.abort();
      return { ok: true };
    });
    expect(await call({ prompt: "x", model: "selected" }, CALLER_ID, controller.signal))
      .toMatchObject({ resultType: "failure" });
    expect(sessionManager.createSession).not.toHaveBeenCalled();
  });

  it("retains the chat but does not send when cancelled during creation", async () => {
    const { call, sessionManager } = createHarness();
    const controller = new AbortController();
    sessionManager.createSession = vi.fn().mockImplementation(async () => {
      controller.abort();
      return { sessionId: SESSION_ID };
    });
    const result = await call({ prompt: "x" }, CALLER_ID, controller.signal);
    expect(result).toMatchObject({ sessionId: SESSION_ID, status: "not_sent", resultType: "failure" });
    expect(sessionManager.startWorkAndWaitForDelivery).not.toHaveBeenCalled();
    expect(convertBridgeToolResultToSdk(result).textResultForLlm).toContain(`bridge://session/${SESSION_ID}`);
  });

  it("surfaces invalid model choices and capacity failures without starting work", async () => {
    const { call, sessionManager } = createHarness();
    sessionManager.validateModelSelection = vi.fn().mockResolvedValue({ ok: false, error: "Model unavailable" });
    expect(convertBridgeToolResultToSdk(await call({ prompt: "x", model: "missing" })).textResultForLlm)
      .toContain("Model unavailable");
    expect(sessionManager.createSession).not.toHaveBeenCalled();
    sessionManager.createSession = vi.fn().mockRejectedValue(new Error("Live Copilot capacity is full"));
    expect(convertBridgeToolResultToSdk(await call({ prompt: "x" })).textResultForLlm).toContain("capacity is full");
    expect(sessionManager.startWorkAndWaitForDelivery).not.toHaveBeenCalled();
  });

  it("retains the created chat and exposes a failed task link in both native and MCP results", async () => {
    const { call, taskStore, sessionManager } = createHarness();
    const task = taskStore.createTask("Link failure");
    vi.spyOn(taskStore, "linkSession").mockImplementation(() => { throw new Error("Link write failed"); });
    const result = await call({ prompt: "x", taskId: task.id });
    expect(result).toMatchObject({ sessionId: SESSION_ID, taskLinked: false, status: "not_sent" });
    expect(sessionManager.startWorkAndWaitForDelivery).not.toHaveBeenCalled();
    expect(sessionManager.deleteSession).not.toHaveBeenCalled();
    const native = convertBridgeToolResultToSdk(result);
    expect(native.resultType).toBe("failure");
    expect(native.textResultForLlm).toContain(`bridge://session/${SESSION_ID}`);
    expect(native.textResultForLlm).toContain("Task linked: false");
    const mcp = normalizeToolResult(result);
    expect(mcp.isError).toBe(true);
    expect(JSON.stringify(mcp.content)).toContain(`bridge://session/${SESSION_ID}`);
  });

  it("reports unconfirmed prompt acceptance with the linked chat's handle rather than implying no work ran", async () => {
    const { call, taskStore, sessionManager } = createHarness();
    const task = taskStore.createTask("Send failure");
    sessionManager.startWorkAndWaitForDelivery = vi.fn().mockRejectedValue(new Error("Send disconnected"));
    const result = await call({ prompt: "x", taskId: task.id });
    expect(result).toMatchObject({
      sessionId: SESSION_ID, taskLinked: true, status: "prompt_acceptance_unconfirmed",
    });
    const text = convertBridgeToolResultToSdk(result).textResultForLlm;
    expect(text).toContain("First prompt acceptance was not confirmed");
    expect(text).toContain("Inspect this chat before retrying");
    expect(text).toContain(SESSION_ID);
    expect(text).toContain(`bridge://session/${SESSION_ID}`);
    expect(taskStore.getTask(task.id)?.sessionIds).toContain(SESSION_ID);
  });
});
