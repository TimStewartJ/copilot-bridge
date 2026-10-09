import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppContext } from "../app-context.js";
import { getBridgeToolDefinitions } from "../agent-tools-mcp/register.js";
import { normalizeToolResult } from "../agent-tools-mcp/server.js";
import { convertBridgeToolResultToSdk, createNativeBridgeTools } from "../bridge-native-tools.js";
import { createDeferredPromptStore } from "../deferred-prompt-store.js";
import { createDeferredPromptRunner } from "../deferred-prompt-runner.js";
import { createGlobalBus } from "../global-bus.js";
import { createSessionMetaStore } from "../session-meta-store.js";
import { createTaskStore } from "../task-store.js";
import { createSessionToolDefinitions } from "../tools/session-tools.js";
import { createMockSessionManager, setupTestDb } from "./helpers.js";

const TARGET = "00000000-0000-4000-8000-000000000001";
const CALLER = "00000000-0000-4000-8000-000000000002";
const DELIVERY_ID = `chat-message:session-send:${CALLER}:send-1`;

afterEach(() => vi.restoreAllMocks());

function fixture() {
  const db = setupTestDb();
  const globalBus = createGlobalBus();
  const sessionManager = createMockSessionManager();
  sessionManager.getSessionCreationState = vi.fn().mockResolvedValue("present");
  sessionManager.startWork = vi.fn();
  sessionManager.startWorkAndWaitForDelivery = vi.fn().mockResolvedValue(undefined);
  sessionManager.steerSession = vi.fn().mockResolvedValue(undefined);
  sessionManager.createSession = vi.fn();
  const taskStore = createTaskStore(db, globalBus);
  const sessionMetaStore = createSessionMetaStore(db);
  const deferredPromptStore = createDeferredPromptStore(db);
  const deferredPromptRunner = createDeferredPromptRunner(deferredPromptStore, sessionManager, globalBus);
  const poke = vi.spyOn(deferredPromptRunner, "poke");
  const ctx = {
    sessionManager, taskStore, sessionMetaStore, globalBus, deferredPromptStore,
    deferredPromptRunner,
  } as AppContext;
  const tool = createSessionToolDefinitions(ctx).find((definition) => definition.name === "session_send");
  if (!tool) throw new Error("session_send tool missing");
  const call = async (
    args: Record<string, unknown> = { sessionId: TARGET, message: "Continue the proposal." },
    signal?: AbortSignal,
    sessionId = CALLER,
  ) => tool.handler(args, { sessionId, requestId: "send-1", signal });
  return { db, ctx, tool, call, sessionManager, taskStore, sessionMetaStore, deferredPromptStore, deferredPromptRunner, globalBus, poke };
}

function text(result: Awaited<ReturnType<ReturnType<typeof fixture>["call"]>>) {
  return convertBridgeToolResultToSdk(result).textResultForLlm;
}

describe("session_send", () => {
  it("registers native and MCP definitions with the existing-chat versus sub-agent distinction", () => {
    const { ctx, tool } = fixture();
    expect(getBridgeToolDefinitions(ctx).some((definition) => definition.name === "session_send")).toBe(true);
    expect(createNativeBridgeTools([tool])[0]?.defer).toBe("never");
    expect(tool.inputSchema.required).toEqual(["sessionId", "message"]);
    expect(tool.description).toContain("Use write_agent");
    expect(tool.description).toContain("no reply is forwarded here");
  });

  it("waits for acceptance in an existing chat and leaves task association and human engagement alone", async () => {
    const { call, sessionManager, taskStore } = fixture();
    const callerTask = taskStore.createTask("Caller task");
    const targetTask = taskStore.createTask("Target task");
    taskStore.linkSession(callerTask.id, CALLER);
    taskStore.linkSession(targetTask.id, TARGET);
    const before = taskStore.getTask(targetTask.id);
    const recordUserMessage = vi.spyOn(taskStore, "recordUserMessage");
    const result = await call({ sessionId: ` ${TARGET} `, message: "  Continue the proposal.  " });
    expect(result).toMatchObject({
      success: true, delivery: "accepted", sessionId: TARGET,
      link: `bridge://session/${TARGET}`, markdown: `[Open the target chat](bridge://session/${TARGET})`,
    });
    expect(sessionManager.startWorkAndWaitForDelivery).toHaveBeenCalledWith(
      TARGET, "Continue the proposal.", undefined, { clientMessageId: `session-send:${CALLER}:send-1` },
    );
    expect(sessionManager.startWork).not.toHaveBeenCalled();
    expect(sessionManager.createSession).not.toHaveBeenCalled();
    expect(taskStore.getTask(targetTask.id)).toEqual(before);
    expect(recordUserMessage).not.toHaveBeenCalled();
  });

  it("steers an active turn and reports steering, not a finished answer", async () => {
    const { call, sessionManager } = fixture();
    sessionManager.isSessionBusy = vi.fn(() => true);
    sessionManager.hasRunInFlight = vi.fn(() => true);
    expect(await call()).toMatchObject({ success: true, delivery: "steered" });
    expect(sessionManager.steerSession).toHaveBeenCalledWith(
      TARGET, "Continue the proposal.", undefined, `session-send:${CALLER}:send-1`,
    );
    expect(sessionManager.startWorkAndWaitForDelivery).not.toHaveBeenCalled();
  });

  it("does not return accepted until delivery resolves", async () => {
    const { call, sessionManager } = fixture();
    let accept!: () => void;
    const promise = new Promise<void>((resolve) => { accept = resolve; });
    sessionManager.startWorkAndWaitForDelivery = vi.fn(() => promise);
    let settled = false;
    const result = call().then((value) => { settled = true; return value; });
    await vi.waitFor(() => expect(sessionManager.startWorkAndWaitForDelivery).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    accept();
    expect(await result).toMatchObject({ delivery: "accepted" });
  });

  it("restores an archived target before sending and announces restoration once", async () => {
    const { call, sessionManager, sessionMetaStore, globalBus } = fixture();
    sessionMetaStore.setArchived(TARGET, true);
    const emit = vi.spyOn(globalBus, "emit");
    sessionManager.startWorkAndWaitForDelivery = vi.fn(async () => {
      expect(sessionMetaStore.isArchived(TARGET)).toBe(false);
    });
    expect(await call()).toMatchObject({ delivery: "accepted" });
    expect(emit).toHaveBeenCalledExactlyOnceWith({ type: "session:archived", sessionId: TARGET, archived: false });
  });

  it.each([
    {}, { message: "x" }, { sessionId: TARGET }, { sessionId: "some title", message: "x" },
    { sessionId: "../bad", message: "x" }, { sessionId: CALLER, message: "x" },
    { sessionId: TARGET, message: "" }, { sessionId: TARGET, message: " " },
    { sessionId: TARGET, message: 4 }, { sessionId: TARGET, message: "/compact" },
    { sessionId: TARGET, message: "x", model: "other" },
  ])("rejects invalid inputs without sending or restoring: %j", async (args) => {
    const { call, sessionManager, sessionMetaStore } = fixture();
    sessionMetaStore.setArchived(TARGET, true);
    expect(await call(args)).toMatchObject({ resultType: "failure" });
    expect(sessionMetaStore.isArchived(TARGET)).toBe(true);
    expect(sessionManager.startWorkAndWaitForDelivery).not.toHaveBeenCalled();
    expect(sessionManager.steerSession).not.toHaveBeenCalled();
  });

  it("does not create or restore a missing chat", async () => {
    const { call, sessionManager, sessionMetaStore } = fixture();
    sessionMetaStore.setArchived(TARGET, true);
    sessionManager.getSessionCreationState = vi.fn().mockResolvedValue("absent");
    expect(text(await call())).toContain("was not found");
    expect(sessionMetaStore.isArchived(TARGET)).toBe(true);
    expect(sessionManager.createSession).not.toHaveBeenCalled();
    expect(sessionManager.startWorkAndWaitForDelivery).not.toHaveBeenCalled();
  });

  it("allows a known pending creation", async () => {
    const { call, sessionManager } = fixture();
    sessionManager.getSessionCreationState = vi.fn().mockResolvedValue("pending");
    expect(await call()).toMatchObject({ delivery: "accepted" });
  });

  it("leaves a pending question untouched and puts its link in both native and MCP failure text", async () => {
    const { call, sessionManager, sessionMetaStore } = fixture();
    sessionMetaStore.setArchived(TARGET, true);
    sessionManager.getPendingUserInputCount = vi.fn(() => 1);
    const result = await call();
    expect(text(result)).toContain("This message was not sent");
    expect(text(result)).toContain(`bridge://session/${TARGET}`);
    expect(JSON.stringify(normalizeToolResult(result).content)).toContain(`bridge://session/${TARGET}`);
    expect(sessionMetaStore.isArchived(TARGET)).toBe(true);
    expect(sessionManager.steerSession).not.toHaveBeenCalled();
    expect(sessionManager.startWorkAndWaitForDelivery).not.toHaveBeenCalled();
  });

  it("requires an invoking session", async () => {
    const { call, sessionManager } = fixture();
    expect(await call({ sessionId: TARGET, message: "x" }, undefined, "")).toMatchObject({ resultType: "failure" });
    expect(sessionManager.getSessionCreationState).not.toHaveBeenCalled();
  });

  it.each(["before lookup", "during lookup"])("stops cancellation %s without changing the target", async (phase) => {
    const { call, sessionManager, sessionMetaStore } = fixture();
    const controller = new AbortController();
    sessionMetaStore.setArchived(TARGET, true);
    if (phase === "before lookup") controller.abort();
    else sessionManager.getSessionCreationState = vi.fn(async () => { controller.abort(); return "present"; });
    expect(await call({ sessionId: TARGET, message: "x" }, controller.signal)).toMatchObject({ resultType: "failure" });
    expect(sessionMetaStore.isArchived(TARGET)).toBe(true);
    expect(sessionManager.startWorkAndWaitForDelivery).not.toHaveBeenCalled();
  });

  it.each(["backend", "hold", "capacity", "stalled"])("queues known pre-dispatch %s blocking without claiming delivery", async (reason) => {
    const { call, sessionManager, deferredPromptStore, poke } = fixture();
    if (reason === "backend") sessionManager.getBackendUnavailableReason = () => "Agent backend is reconnecting";
    if (reason === "hold") sessionManager.isSessionBusy = () => true;
    if (reason === "capacity") sessionManager.getSessionCapacityWait = () => "Capacity full";
    if (reason === "stalled") sessionManager.getSessionRunState = () => "stalled";
    const result = await call();
    expect(result).toMatchObject({ success: true, delivery: "queued", deliveryId: DELIVERY_ID });
    expect(text(result)).toContain("not yet delivered");
    expect(deferredPromptStore.get(DELIVERY_ID)).toMatchObject({
      sessionId: TARGET, prompt: "Continue the proposal.", purpose: "delivery", status: "pending",
    });
    expect(sessionManager.startWorkAndWaitForDelivery).not.toHaveBeenCalled();
    expect(sessionManager.steerSession).not.toHaveBeenCalled();
    expect(poke).toHaveBeenCalledOnce();
  });

  it("a retry of a queued invocation does not send directly once capacity frees", async () => {
    const { call, sessionManager, deferredPromptStore } = fixture();
    sessionManager.getBackendUnavailableReason = () => "Recovering";
    await call();
    sessionManager.getBackendUnavailableReason = () => undefined;
    expect(await call()).toMatchObject({ delivery: "queued", deliveryId: DELIVERY_ID });
    expect(deferredPromptStore.listDeliveriesForSession(TARGET)).toHaveLength(1);
    expect(sessionManager.startWorkAndWaitForDelivery).not.toHaveBeenCalled();
  });

  it("delivers a queued native message through a restarted outbox runner exactly once", async () => {
    const { db, call, sessionManager, globalBus } = fixture();
    sessionManager.getBackendUnavailableReason = () => "Recovering";
    await call();
    const recoveredStore = createDeferredPromptStore(db);
    expect(recoveredStore.get(DELIVERY_ID)?.status).toBe("pending");
    sessionManager.getBackendUnavailableReason = () => undefined;
    sessionManager.listSessionsFromDisk = async () => [{ sessionId: TARGET }];
    const runner = createDeferredPromptRunner(recoveredStore, sessionManager, globalBus);
    runner.start();
    try {
      await vi.waitFor(() => expect(recoveredStore.get(DELIVERY_ID)?.status).toBe("completed"));
      expect(sessionManager.startWorkAndWaitForDelivery).toHaveBeenCalledExactlyOnceWith(
        TARGET, "Continue the proposal.", undefined,
        { completionAttention: true, clientMessageId: `session-send:${CALLER}:send-1` },
      );
      expect(await call()).toMatchObject({ delivery: "accepted", deliveryId: DELIVERY_ID });
      expect(sessionManager.startWorkAndWaitForDelivery).toHaveBeenCalledOnce();
    } finally {
      runner.shutdown();
    }
  });

  it.each(["running", "completed", "failed", "cancelled"])("reports the previous queued invocation's %s state without resending", async (status) => {
    const { db, call, sessionManager, deferredPromptStore } = fixture();
    deferredPromptStore.enqueueDelivery({ id: DELIVERY_ID, sourceId: DELIVERY_ID, sessionId: TARGET, prompt: "Continue the proposal." });
    db.prepare("UPDATE deferred_prompts SET status = ? WHERE id = ?").run(status, DELIVERY_ID);
    const result = await call();
    if (status === "running") expect(result).toMatchObject({ delivery: "queued" });
    else if (status === "completed") expect(result).toMatchObject({ delivery: "accepted" });
    else expect(text(result)).toContain(`previous queued message is ${status}`);
    expect(sessionManager.startWorkAndWaitForDelivery).not.toHaveBeenCalled();
  });

  it("rejects reuse of a queued invocation with different text", async () => {
    const { call, sessionManager } = fixture();
    sessionManager.getBackendUnavailableReason = () => "Recovering";
    await call();
    expect(text(await call({ sessionId: TARGET, message: "Something else" }))).toContain("different target or message");
    expect(sessionManager.startWorkAndWaitForDelivery).not.toHaveBeenCalled();
  });

  it.each(["idle", "busy"])("does not queue an ambiguous failure after a %s send attempt", async (state) => {
    const { call, sessionManager, deferredPromptStore } = fixture();
    const error = new Error("Agent backend disconnected; the Bridge is restarting it. Try again shortly.");
    if (state === "busy") {
      sessionManager.isSessionBusy = () => true;
      sessionManager.hasRunInFlight = () => true;
      sessionManager.steerSession = vi.fn().mockRejectedValue(error);
    } else sessionManager.startWorkAndWaitForDelivery = vi.fn().mockRejectedValue(error);
    const result = await call();
    expect(text(result)).toContain("acceptance was not confirmed");
    expect(text(result)).toContain(`bridge://session/${TARGET}`);
    expect(deferredPromptStore.listDeliveriesForSession(TARGET)).toEqual([]);
  });

  it("surfaces outbox errors rather than claiming a message was queued", async () => {
    const { call, sessionManager, deferredPromptStore, sessionMetaStore } = fixture();
    sessionMetaStore.setArchived(TARGET, true);
    sessionManager.getBackendUnavailableReason = () => "Recovering";
    vi.spyOn(deferredPromptStore, "enqueueDelivery").mockImplementation(() => { throw new Error("Disk full"); });
    expect(text(await call())).toContain("Disk full");
    expect(sessionMetaStore.isArchived(TARGET)).toBe(true);
    expect(sessionManager.startWorkAndWaitForDelivery).not.toHaveBeenCalled();
  });

  it("cancels a queued message if restoring its archived target fails", async () => {
    const { call, sessionManager, deferredPromptStore, sessionMetaStore, poke } = fixture();
    sessionMetaStore.setArchived(TARGET, true);
    sessionManager.getBackendUnavailableReason = () => "Recovering";
    vi.spyOn(sessionMetaStore, "setArchived").mockImplementation(() => { throw new Error("Restore write failed"); });
    expect(text(await call())).toContain("Restore write failed");
    expect(deferredPromptStore.get(DELIVERY_ID)?.status).toBe("cancelled");
    expect(sessionMetaStore.isArchived(TARGET)).toBe(true);
    expect(poke).not.toHaveBeenCalled();
  });

  it("queues a Bridge hold even while its old run remains in flight", async () => {
    const { call, sessionManager } = fixture();
    sessionManager.isSessionBusy = () => true;
    sessionManager.hasRunInFlight = () => true;
    sessionManager.getSessionHold = () => "image-compaction";
    expect(await call()).toMatchObject({ delivery: "queued" });
    expect(sessionManager.steerSession).not.toHaveBeenCalled();
  });

  it("wakes queued delivery when a Bridge hold ends", async () => {
    const { call, sessionManager, poke } = fixture();
    let held = true;
    let changed!: () => void;
    const unsubscribe = vi.fn();
    sessionManager.isSessionBusy = () => held;
    sessionManager.getSessionHold = vi.fn(() => held ? "image-compaction" : undefined);
    sessionManager.subscribeSessionHold = vi.fn((_id, listener) => { changed = listener; return unsubscribe; });
    await call();
    expect(poke).toHaveBeenCalledOnce();
    changed();
    expect(poke).toHaveBeenCalledOnce();
    held = false;
    changed();
    expect(poke).toHaveBeenCalledTimes(2);
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
