import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentSession } from "../agent-backend/index.js";
import { createEventBusRegistry } from "../event-bus.js";
import { PendingInteractionError } from "../pending-interaction-validation.js";
import { SessionManager } from "../session-manager.js";
import { createSessionTitlesStore } from "../session-titles.js";
import { createTaskStore } from "../task-store.js";
import type { PendingUserInputRequestView } from "../user-input-types.js";
import { createTestBus, makeAgentSessionStub, makeTestRuntimePaths, setupTestDb } from "./helpers.js";

function createManager(pending: PendingUserInputRequestView[] = []) {
  const db = setupTestDb();
  const globalBus = createTestBus();
  const eventBusRegistry = createEventBusRegistry();
  const runtimePaths = makeTestRuntimePaths("user-input-manager");
  const bus = eventBusRegistry.getOrCreateBus("session-1");
  // The runtime owns the requests but cannot enumerate them, so Bridge's
  // event-derived listing index is the only listing source. Seed it the way
  // `session-runner` does when the runtime raises `user_input.requested`.
  for (const request of pending) bus.emitUserInputRequested(request);
  const respondToUserInput = vi.fn(async (requestId: string) => {
    const index = pending.findIndex((request) => request.requestId === requestId);
    if (index < 0) return false;
    pending.splice(index, 1);
    bus.emitUserInputAnswered(requestId, { answer: "", wasFreeform: false });
    return true;
  });
  const session = {
    sessionId: "session-1",
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
  return { manager, session, respondToUserInput, globalBus, eventBusRegistry, bus };
}

function pendingRequest(): PendingUserInputRequestView {
  return {
    requestId: "request-1",
    question: "Continue?",
    choices: ["yes", "no"],
    allowFreeform: false,
    toolCallId: "tool-1",
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

  it("hydrates reconnect snapshots from the listing index", async () => {
    const { manager } = createManager([pendingRequest()]);

    await expect(manager.hydratePendingInteractions("session-1")).resolves.toEqual({
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

  it("discards a reconciliation that a newer read superseded", async () => {
    const { manager, session, bus } = createManager([pendingRequest()]);

    const reconcile = Reflect.get(manager, "reconcilePendingInteractionCounts") as Function;
    const older = reconcile.call(manager, "session-1", session);
    // A newer reconcile claims the generation before the older one resumes.
    const newer = reconcile.call(manager, "session-1", session);
    bus.emitUserInputAnswered("request-1", { answer: "yes", wasFreeform: false });
    await Promise.all([older, newer]);

    // The superseded pass must not resurrect the count it read first.
    expect(manager.getPendingUserInputCount("session-1")).toBe(0);
  });

  it("clears derived status and cancels runtime requests on terminal paths", async () => {
    const { manager, respondToUserInput, eventBusRegistry } = createManager([pendingRequest()]);
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
    await expect(manager.hydratePendingInteractions("session-1")).resolves.toEqual({
      pendingUserInputs: [],
      pendingElicitations: [],
    });
    expect(respondToUserInput).toHaveBeenCalledWith("request-1", {
      answer: "",
      wasFreeform: false,
      dismissed: true,
    });
  });

  it("bounds unresponsive backend responses", async () => {
    vi.useFakeTimers();
    try {
      const { manager, respondToUserInput } = createManager([pendingRequest()]);
      respondToUserInput.mockImplementation(() => new Promise(() => {}));

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

describe("SessionManager projected user message lifecycle", () => {
  function createManager() {
    const db = setupTestDb();
    const eventBusRegistry = createEventBusRegistry();
    const manager = new SessionManager({
      globalBus: createTestBus(),
      eventBusRegistry,
      sessionTitles: createSessionTitlesStore(db),
      taskStore: {
        findTaskBySessionId: vi.fn().mockReturnValue(null),
      } as any,
      settingsStore: {
        getMcpServers: () => ({}),
        getSettings: () => ({ mcpServers: {} }),
      } as any,
      config: { sessionMcpServers: {} },
    }) as any;

    return { manager, eventBusRegistry };
  }

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("projects a pending message immediately and reconciles it when user.message arrives", async () => {
    const { manager, eventBusRegistry } = createManager();
    let handler: ((event: any) => void) | undefined;
    let releaseSend: (() => void) | undefined;

    const session = makeAgentSessionStub({
      setSendMode: vi.fn().mockResolvedValue(undefined),
      on: vi.fn((cb: (event: any) => void) => {
        handler = cb;
        return vi.fn();
      }),
      send: vi.fn(async () => {
        handler?.({
          id: "user-event-1",
          type: "user.message",
          data: { content: "hello there" },
          timestamp: "2026-04-11T00:00:00.000Z",
        });
        await new Promise<void>((resolve) => {
          releaseSend = resolve;
        });
      }),
    });

    manager.backend = {
      resumeSession: vi.fn().mockResolvedValue(session),
    };

    manager.startWork("session-1", "hello there");

    const bus = eventBusRegistry.getBus("session-1");
    expect(bus?.getSnapshot()).not.toHaveProperty("pendingPrompt");
    expect(bus?.getSnapshot().pendingUserMessages).toMatchObject([
      {
        content: "hello there",
        pending: true,
      },
    ]);
    await vi.waitFor(() => {
      expect(session.send).toHaveBeenCalledTimes(1);
    });
    expect(bus?.getSnapshot().pendingUserMessages).toMatchObject([
      {
        content: "hello there",
        pending: false,
        sourceEventId: "user-event-1",
        timestamp: "2026-04-11T00:00:00.000Z",
      },
    ]);

    releaseSend?.();
    await Promise.resolve();
    await Promise.resolve();
    handler?.({
      type: "session.idle",
      data: {},
      timestamp: "2026-04-11T00:00:01.000Z",
    });
    await Promise.resolve();
  });
});

