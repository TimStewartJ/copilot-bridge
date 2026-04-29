import { describe, expect, it, vi } from "vitest";
import { createEventBusRegistry } from "../event-bus.js";
import { SessionManager } from "../session-manager.js";
import { createSessionTitlesStore } from "../session-titles.js";
import { createTaskStore } from "../task-store.js";
import { UserInputBroker, UserInputBrokerError } from "../user-input-broker.js";
import { setupTestDb, createTestBus } from "./helpers.js";

type UserInputSessionConfig = {
  onUserInputRequest: (
    request: { question: string; choices?: string[]; allowFreeform?: boolean },
    invocation: { sessionId: string },
  ) => Promise<{ answer: string; wasFreeform: boolean }>;
};

function createManager(ids: string[] = ["request-1"]) {
  const db = setupTestDb();
  const globalBus = createTestBus();
  const eventBusRegistry = createEventBusRegistry();
  let nextId = 0;
  const userInputBroker = new UserInputBroker({
    requestIdFactory: () => ids[nextId++] ?? `request-${nextId}`,
    now: () => new Date("2026-04-29T12:00:00.000Z"),
  });
  const manager = new SessionManager({
    tools: [],
    globalBus,
    eventBusRegistry,
    userInputBroker,
    sessionTitles: createSessionTitlesStore(db),
    taskStore: createTaskStore(db, globalBus),
    config: { sessionMcpServers: {} },
  });

  return { manager, eventBusRegistry, globalBus, userInputBroker };
}

describe("SessionManager user input responses", () => {
  it("wires SDK user input requests through the broker and event bus", async () => {
    const { manager, eventBusRegistry } = createManager();
    const cfg = (Reflect.get(manager, "buildSessionConfig") as () => UserInputSessionConfig).call(manager);

    const responsePromise = cfg.onUserInputRequest({
      question: "Continue?",
      choices: ["yes", "no"],
      allowFreeform: false,
    }, { sessionId: "session-1" });

    const bus = eventBusRegistry.getBus("session-1");
    expect(bus?.getSnapshot().pendingUserInputs).toEqual([
      {
        requestId: "request-1",
        question: "Continue?",
        choices: ["yes", "no"],
        allowFreeform: false,
        requestedAt: "2026-04-29T12:00:00.000Z",
      },
    ]);

    await manager.submitUserInputResponse("session-1", "request-1", {
      answer: "yes",
      wasFreeform: false,
    });

    expect(bus?.getSnapshot().pendingUserInputs).toEqual([]);
    await expect(responsePromise).resolves.toEqual({ answer: "yes", wasFreeform: false });
  });

  it("emits global input-required status when pending user input changes", async () => {
    const { manager, globalBus } = createManager();
    const events: any[] = [];
    const unsubscribe = globalBus.subscribe((event) => {
      if (event.sessionId === "session-1" && event.type === "session:user-input") {
        events.push(event);
      }
    });
    const cfg = (Reflect.get(manager, "buildSessionConfig") as () => UserInputSessionConfig).call(manager);

    const responsePromise = cfg.onUserInputRequest({
      question: "Continue?",
      choices: ["yes", "no"],
      allowFreeform: false,
    }, { sessionId: "session-1" });
    await manager.submitUserInputResponse("session-1", "request-1", {
      answer: "yes",
      wasFreeform: false,
    });
    unsubscribe();

    expect(events).toEqual([
      {
        type: "session:user-input",
        sessionId: "session-1",
        pendingUserInputCount: 1,
        needsUserInput: true,
      },
      {
        type: "session:user-input",
        sessionId: "session-1",
        pendingUserInputCount: 0,
        needsUserInput: false,
      },
    ]);
    await expect(responsePromise).resolves.toEqual({ answer: "yes", wasFreeform: false });
  });

  it("delegates valid answers to the broker and clears the pending stream snapshot", async () => {
    const { manager, eventBusRegistry, userInputBroker } = createManager();
    const promise = userInputBroker.requestUserInput("session-1", {
      question: "Continue?",
      choices: ["yes", "no"],
      allowFreeform: false,
    });
    const pending = userInputBroker.getPendingUserInput("session-1", "request-1");
    expect(pending).toBeDefined();

    const bus = eventBusRegistry.getOrCreateBus("session-1");
    bus.emitUserInputRequested(pending!);

    const response = await manager.submitUserInputResponse("session-1", "request-1", {
      answer: "yes",
      wasFreeform: false,
    });

    expect(response).toMatchObject({
      requestId: "request-1",
      answer: "yes",
      wasFreeform: false,
    });
    expect(bus.getSnapshot().pendingUserInputs).toEqual([]);
    await expect(promise).resolves.toEqual({ answer: "yes", wasFreeform: false });
  });

  it("cancels pending user input when a run is aborted", async () => {
    const { manager, eventBusRegistry, userInputBroker } = createManager();
    const cfg = (Reflect.get(manager, "buildSessionConfig") as () => UserInputSessionConfig).call(manager);

    const responsePromise = cfg.onUserInputRequest({
      question: "Continue?",
      allowFreeform: true,
    }, { sessionId: "session-1" });
    const rejected = expect(responsePromise).rejects.toMatchObject({
      code: "request_canceled",
      reason: "session_ended",
    });

    const bus = eventBusRegistry.getBus("session-1")!;
    const controller = (Reflect.get(manager, "createRunController") as any).call(manager, "session-1", bus);
    controller.completeAborted("partial");

    expect(userInputBroker.getPendingCount("session-1")).toBe(0);
    expect(bus.getSnapshot()).toMatchObject({
      terminalType: "aborted",
      pendingUserInputs: [],
    });
    await rejected;
  });

  it("cancels pending user input before emitting run errors", async () => {
    const { manager, eventBusRegistry, userInputBroker } = createManager();
    const cfg = (Reflect.get(manager, "buildSessionConfig") as () => UserInputSessionConfig).call(manager);

    const responsePromise = cfg.onUserInputRequest({
      question: "Continue?",
      allowFreeform: true,
    }, { sessionId: "session-1" });
    const rejected = expect(responsePromise).rejects.toMatchObject({
      code: "request_canceled",
      reason: "error",
      message: "boom",
    });

    const bus = eventBusRegistry.getBus("session-1")!;
    const events: any[] = [];
    const unsubscribe = bus.subscribe((event) => events.push(event));
    const controller = (Reflect.get(manager, "createRunController") as any).call(manager, "session-1", bus);
    controller.completeError("boom");
    unsubscribe();

    expect(userInputBroker.getPendingCount("session-1")).toBe(0);
    expect(events.filter((event) => event.type !== "snapshot").map((event) => event.type)).toEqual([
      "user_input_canceled",
      "error",
    ]);
    expect(events.find((event) => event.type === "user_input_canceled")).toMatchObject({
      requestId: "request-1",
      reason: "error",
      message: "boom",
    });
    await rejected;
  });

  it("keeps pending user input across ordinary stream disconnects", async () => {
    const { manager, eventBusRegistry, userInputBroker } = createManager();
    const cfg = (Reflect.get(manager, "buildSessionConfig") as () => UserInputSessionConfig).call(manager);

    const responsePromise = cfg.onUserInputRequest({
      question: "Continue?",
      allowFreeform: true,
    }, { sessionId: "session-1" });
    const bus = eventBusRegistry.getBus("session-1")!;
    const unsubscribe = bus.subscribe(() => {});
    unsubscribe();

    expect(userInputBroker.getPendingCount("session-1")).toBe(1);
    expect(bus.getSnapshot().pendingUserInputs).toHaveLength(1);

    await manager.submitUserInputResponse("session-1", "request-1", {
      answer: "yes",
      wasFreeform: true,
    });
    await expect(responsePromise).resolves.toEqual({ answer: "yes", wasFreeform: true });
  });

  it("counts pending user input as session activity while the run waits for an answer", async () => {
    const { manager } = createManager();
    const cfg = (Reflect.get(manager, "buildSessionConfig") as () => UserInputSessionConfig).call(manager);
    (Reflect.get(manager, "setSessionRunState") as any).call(manager, "session-1", "busy", {
      now: 1,
      lastEventAt: 1,
    });

    const responsePromise = cfg.onUserInputRequest({
      question: "Continue?",
      allowFreeform: true,
    }, { sessionId: "session-1" });

    expect(manager.getSessionActivity()).toMatchObject([
      {
        id: "session-1",
        state: "busy",
        lastEventAt: Date.parse("2026-04-29T12:00:00.000Z"),
      },
    ]);

    const rejected = expect(responsePromise).rejects.toMatchObject({
      code: "request_canceled",
      reason: "session_ended",
    });
    await manager.shutdown();
    await rejected;
  });

  it("cancels all pending user input when the session manager shuts down", async () => {
    const { manager, userInputBroker } = createManager(["request-1", "request-2"]);
    const cfg = (Reflect.get(manager, "buildSessionConfig") as () => UserInputSessionConfig).call(manager);
    (manager as any).client = { stop: vi.fn().mockResolvedValue(undefined) };

    const first = cfg.onUserInputRequest({ question: "First?" }, { sessionId: "session-1" });
    const second = cfg.onUserInputRequest({ question: "Second?" }, { sessionId: "session-2" });
    const firstRejected = expect(first).rejects.toMatchObject({
      code: "request_canceled",
      reason: "session_ended",
    });
    const secondRejected = expect(second).rejects.toMatchObject({
      code: "request_canceled",
      reason: "session_ended",
    });

    await manager.shutdown();

    expect(userInputBroker.getPendingCount()).toBe(0);
    expect((manager as any).client).toBeNull();
    await firstRejected;
    await secondRejected;
  });

  it("rejects answers for sessions the manager cannot address", async () => {
    const { manager } = createManager();

    await expect(manager.submitUserInputResponse("missing-session", "request-1", {
      answer: "yes",
      wasFreeform: false,
    })).rejects.toMatchObject({
      code: "request_not_found",
      statusCode: 404,
      message: "Session not found",
    } satisfies Partial<UserInputBrokerError>);
  });
});
