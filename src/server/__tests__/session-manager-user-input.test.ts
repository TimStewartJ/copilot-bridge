import { describe, expect, it, vi } from "vitest";

import type { AgentPendingUserInputRequest, AgentSession } from "../agent-backend/index.js";
import { createEventBusRegistry } from "../event-bus.js";
import { PendingInteractionError } from "../pending-interaction-validation.js";
import { SessionManager } from "../session-manager.js";
import { createSessionTitlesStore } from "../session-titles.js";
import { createTaskStore } from "../task-store.js";
import { createTestBus, makeTestRuntimePaths, setupTestDb } from "./helpers.js";

function createManager(pending: AgentPendingUserInputRequest[] = []) {
  const db = setupTestDb();
  const globalBus = createTestBus();
  const eventBusRegistry = createEventBusRegistry();
  const runtimePaths = makeTestRuntimePaths("user-input-manager");
  const respondToUserInput = vi.fn(async (requestId: string) => {
    const index = pending.findIndex((request) => request.requestId === requestId);
    if (index < 0) return false;
    pending.splice(index, 1);
    return true;
  });
  const session = {
    sessionId: "session-1",
    getPendingUserInputRequests: vi.fn(async () => structuredClone(pending)),
    getPendingElicitationRequests: vi.fn(async () => []),
    respondToUserInput,
  } as unknown as AgentSession;
  const manager = new SessionManager({
    globalBus,
    eventBusRegistry,
    sessionTitles: createSessionTitlesStore(db),
    taskStore: createTaskStore(db, globalBus),
    config: { sessionMcpServers: {} },
    clientEnv: runtimePaths.env,
    copilotHome: runtimePaths.copilotHome,
    runtimePaths,
  });
  (Reflect.get(manager, "sessionObjects") as Map<string, AgentSession>).set("session-1", session);
  return { manager, session, respondToUserInput, globalBus, eventBusRegistry };
}

function pendingRequest(): AgentPendingUserInputRequest {
  return {
    requestId: "request-1",
    request: {
      question: "Continue?",
      choices: ["yes", "no"],
      allowFreeform: false,
      toolCallId: "tool-1",
    },
  };
}

describe("SessionManager SDK-owned user input", () => {
  it("validates and delegates answers using the SDK request ID", async () => {
    const { manager, respondToUserInput, eventBusRegistry } = createManager([pendingRequest()]);
    const events: unknown[] = [];
    eventBusRegistry.getOrCreateBus("session-1").subscribe((event) => events.push(event));

    await expect(manager.submitUserInputResponse("session-1", "request-1", {
      answer: "yes",
      wasFreeform: false,
    })).resolves.toMatchObject({
      requestId: "request-1",
      answer: "yes",
      wasFreeform: false,
    });
    expect(respondToUserInput).toHaveBeenCalledWith("request-1", {
      answer: "yes",
      wasFreeform: false,
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: "user_input_answered",
      requestId: "request-1",
    }));
  });

  it("rejects invalid answers before calling the SDK", async () => {
    const { manager, respondToUserInput } = createManager([pendingRequest()]);

    await expect(manager.submitUserInputResponse("session-1", "request-1", {
      answer: "maybe",
      wasFreeform: false,
    })).rejects.toMatchObject({
      code: "invalid_response",
      statusCode: 400,
    } satisfies Partial<PendingInteractionError>);
    expect(respondToUserInput).not.toHaveBeenCalled();
  });

  it("maps first-responder races to the stale request contract", async () => {
    const { manager, respondToUserInput } = createManager([pendingRequest()]);
    respondToUserInput.mockResolvedValueOnce(false);

    await expect(manager.submitUserInputResponse("session-1", "request-1", {
      answer: "yes",
      wasFreeform: false,
    })).rejects.toMatchObject({
      code: "request_not_found",
      statusCode: 404,
      message: "Pending user input request not found",
    } satisfies Partial<PendingInteractionError>);
  });

  it("hydrates reconnect snapshots from the SDK-owned pending store", async () => {
    const { manager } = createManager([pendingRequest()]);

    await expect(manager.getPendingInteractionSnapshot("session-1")).resolves.toEqual({
      pendingUserInputs: [{
        requestId: "request-1",
        question: "Continue?",
        choices: ["yes", "no"],
        allowFreeform: false,
        toolCallId: "tool-1",
      }],
      pendingElicitations: [],
    });
  });

  it("surfaces unsupported backends clearly", async () => {
    const { manager } = createManager([pendingRequest()]);
    (Reflect.get(manager, "sessionObjects") as Map<string, AgentSession>).set("session-1", {
      sessionId: "session-1",
    } as AgentSession);

    await expect(manager.submitUserInputResponse("session-1", "request-1", {
      answer: "yes",
      wasFreeform: false,
    })).rejects.toMatchObject({
      code: "unsupported",
      statusCode: 501,
      message: "Pending user input is not supported by this agent backend",
    } satisfies Partial<PendingInteractionError>);
  });

  it("emits synchronous pending status before snapshot reconciliation completes", () => {
    const { manager, globalBus } = createManager([pendingRequest()]);
    const events: unknown[] = [];
    globalBus.subscribe((event) => events.push(event));

    (Reflect.get(manager, "recordPendingInteractionEvent") as Function).call(
      manager,
      "session-1",
      "user_input",
      "requested",
      "2026-04-29T12:00:00.000Z",
    );

    expect(manager.getPendingUserInputCount("session-1")).toBe(1);
    expect(events).toContainEqual({
      type: "session:user-input",
      sessionId: "session-1",
      pendingUserInputCount: 1,
      needsUserInput: true,
    });
  });

  it("discards out-of-order SDK count reconciliations", async () => {
    const { manager, session } = createManager();
    let resolveOlder!: (value: AgentPendingUserInputRequest[]) => void;
    let resolveNewer!: (value: AgentPendingUserInputRequest[]) => void;
    vi.mocked(session.getPendingUserInputRequests!)
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveOlder = resolve;
      }))
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveNewer = resolve;
      }));

    const reconcile = Reflect.get(manager, "reconcilePendingInteractionCounts") as Function;
    const older = reconcile.call(manager, "session-1", session);
    const newer = reconcile.call(manager, "session-1", session);
    resolveNewer([]);
    await newer;
    resolveOlder([pendingRequest()]);
    await older;

    expect(manager.getPendingUserInputCount("session-1")).toBe(0);
  });

  it("clears derived pending status on terminal paths", () => {
    const { manager, eventBusRegistry } = createManager();
    (Reflect.get(manager, "recordPendingInteractionEvent") as Function).call(
      manager,
      "session-1",
      "user_input",
      "requested",
    );
    const bus = eventBusRegistry.getOrCreateBus("session-1");
    const controller = (Reflect.get(manager, "createRunController") as Function).call(
      manager,
      "session-1",
      bus,
    );

    controller.completeAborted("");

    expect(manager.getPendingUserInputCount("session-1")).toBe(0);
  });

  it("bounds unresponsive backend lookups", async () => {
    vi.useFakeTimers();
    try {
      const { manager, session } = createManager([pendingRequest()]);
      vi.mocked(session.getPendingUserInputRequests!)
        .mockImplementation(() => new Promise(() => {}));

      const response = manager.submitUserInputResponse("session-1", "request-1", {
        answer: "yes",
        wasFreeform: false,
      });
      const rejection = expect(response).rejects.toMatchObject({
        code: "backend_unavailable",
        statusCode: 504,
      } satisfies Partial<PendingInteractionError>);
      await vi.advanceTimersByTimeAsync(5_000);

      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });
});
