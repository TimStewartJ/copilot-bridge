import { describe, expect, it, vi } from "vitest";

import type { AgentPendingElicitationRequest, AgentSession } from "../agent-backend/index.js";
import { AgentPendingInteractionUnsupportedError } from "../agent-backend/index.js";
import { createEventBusRegistry } from "../event-bus.js";
import { PendingInteractionError } from "../pending-interaction-validation.js";
import { SessionManager } from "../session-manager.js";
import { createSessionTitlesStore } from "../session-titles.js";
import { createTaskStore } from "../task-store.js";
import { createTestBus, makeTestRuntimePaths, setupTestDb } from "./helpers.js";

function pendingRequest(): AgentPendingElicitationRequest {
  return {
    requestId: "el-request",
    request: {
      message: "Configure deployment",
      mode: "form",
      requestedSchema: {
        type: "object",
        properties: {
          target: {
            type: "string",
            enum: ["staging", "production"],
          },
          reason: { type: "string" },
        },
        required: ["target", "reason"],
      },
    },
    elicitationSource: "deployment-mcp",
  };
}

function createManager(pending: AgentPendingElicitationRequest[] = []) {
  const db = setupTestDb();
  const globalBus = createTestBus();
  const eventBusRegistry = createEventBusRegistry();
  const runtimePaths = makeTestRuntimePaths("elicitation-manager");
  const tryRespondToElicitation = vi.fn(async (requestId: string) => {
    const index = pending.findIndex((request) => request.requestId === requestId);
    if (index < 0) return false;
    pending.splice(index, 1);
    return true;
  });
  const session = {
    sessionId: "session-1",
    getPendingUserInputRequests: vi.fn(async () => []),
    getPendingElicitationRequests: vi.fn(async () => structuredClone(pending)),
    tryRespondToElicitation,
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
  return { manager, session, tryRespondToElicitation, eventBusRegistry };
}

function recordPendingElicitation(manager: SessionManager): void {
  (Reflect.get(manager, "recordPendingInteractionEvent") as Function).call(
    manager,
    "session-1",
    "elicitation",
    "requested",
  );
}

function abortRun(
  manager: SessionManager,
  bus: ReturnType<ReturnType<typeof createEventBusRegistry>["getOrCreateBus"]>,
): void {
  const controller = (Reflect.get(manager, "createRunController") as Function).call(
    manager,
    "session-1",
    bus,
  );
  controller.completeAborted("");
}

describe("SessionManager SDK-owned elicitation", () => {
  it.each([
    {
      name: "accept",
      payload: {
        action: "accept",
        content: { target: "staging", reason: "Safer" },
      },
    },
    { name: "decline", payload: { action: "decline" } },
    { name: "cancel", payload: { action: "cancel" } },
  ])("delegates a validated $name response", async ({ payload }) => {
    const { manager, tryRespondToElicitation, eventBusRegistry } = createManager([pendingRequest()]);
    const events: unknown[] = [];
    eventBusRegistry.getOrCreateBus("session-1").subscribe((event) => events.push(event));

    await expect(manager.submitElicitationResponse(
      "session-1",
      "el-request",
      payload,
    )).resolves.toMatchObject({
      requestId: "el-request",
      action: payload.action,
    });
    expect(tryRespondToElicitation).toHaveBeenCalledWith("el-request", payload);
    expect(events).toContainEqual(expect.objectContaining({
      type: "elicitation_resolved",
      requestId: "el-request",
      action: payload.action,
    }));
  });

  it("rejects invalid form content before calling the SDK", async () => {
    const { manager, tryRespondToElicitation } = createManager([pendingRequest()]);

    await expect(manager.submitElicitationResponse("session-1", "el-request", {
      action: "accept",
      content: { target: "staging" },
    })).rejects.toMatchObject({
      code: "invalid_response",
      statusCode: 400,
      message: "Elicitation response is missing required field reason",
    } satisfies Partial<PendingInteractionError>);
    expect(tryRespondToElicitation).not.toHaveBeenCalled();
  });

  it("maps first-responder races, hydrates reconnect snapshots, and surfaces unsupported backends", async () => {
    // maps first-responder races to the stale request contract
    {
      const { manager, tryRespondToElicitation } = createManager([pendingRequest()]);
      tryRespondToElicitation.mockResolvedValueOnce(false);

      await expect(manager.submitElicitationResponse("session-1", "el-request", {
        action: "cancel",
      })).rejects.toMatchObject({
        code: "request_not_found",
        statusCode: 404,
      } satisfies Partial<PendingInteractionError>);
    }

    // hydrates reconnect snapshots from the SDK-owned pending store
    {
      const { manager } = createManager([pendingRequest()]);

      await expect(manager.getPendingInteractionSnapshot("session-1")).resolves.toEqual({
        pendingUserInputs: [],
        pendingElicitations: [{
          requestId: "el-request",
          message: "Configure deployment",
          mode: "form",
          elicitationSource: "deployment-mcp",
          requestedSchema: pendingRequest().request.requestedSchema,
        }],
      });
    }

    // surfaces unsupported backends clearly
    {
      const { manager } = createManager([pendingRequest()]);
      (Reflect.get(manager, "sessionObjects") as Map<string, AgentSession>).set("session-1", {
        sessionId: "session-1",
      } as AgentSession);

      await expect(manager.submitElicitationResponse("session-1", "el-request", {
        action: "cancel",
      })).rejects.toMatchObject({
        code: "unsupported",
        statusCode: 501,
        message: "Pending elicitation is not supported by this agent backend",
      } satisfies Partial<PendingInteractionError>);
    }
  });
  it("cancels requests the runtime still holds when a run ends", async () => {
    const { manager, tryRespondToElicitation, eventBusRegistry } = createManager([pendingRequest()]);

    recordPendingElicitation(manager);
    abortRun(manager, eventBusRegistry.getOrCreateBus("session-1"));

    await expect(manager.getPendingInteractionSnapshot("session-1")).resolves.toEqual({
      pendingUserInputs: [],
      pendingElicitations: [],
    });
    expect(tryRespondToElicitation).toHaveBeenCalledWith("el-request", { action: "cancel" });
  });

  it("holds reconnect hydration until terminal cancellation settles", async () => {
    const { manager, session, eventBusRegistry } = createManager([pendingRequest()]);
    recordPendingElicitation(manager);
    let releaseTerminalLookup!: (requests: AgentPendingElicitationRequest[]) => void;
    vi.mocked(session.getPendingElicitationRequests!).mockImplementationOnce(
      () => new Promise((resolve) => {
        releaseTerminalLookup = resolve;
      }),
    );

    abortRun(manager, eventBusRegistry.getOrCreateBus("session-1"));
    let hydrated = false;
    const hydration = manager.getPendingInteractionSnapshot("session-1")
      .then((snapshot) => {
        hydrated = true;
        return snapshot;
      });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(hydrated).toBe(false);

    releaseTerminalLookup([pendingRequest()]);

    await expect(hydration).resolves.toEqual({
      pendingUserInputs: [],
      pendingElicitations: [],
    });
  });

  it("keeps cancelling after a single request fails", async () => {
    const { manager, tryRespondToElicitation, eventBusRegistry } = createManager([
      { ...pendingRequest(), requestId: "el-stale" },
      pendingRequest(),
    ]);
    tryRespondToElicitation.mockRejectedValueOnce(new Error("already resolved"));

    recordPendingElicitation(manager);
    abortRun(manager, eventBusRegistry.getOrCreateBus("session-1"));

    await expect(manager.getPendingInteractionSnapshot("session-1")).resolves.toMatchObject({
      pendingElicitations: [expect.objectContaining({ requestId: "el-stale" })],
    });
    expect(tryRespondToElicitation).toHaveBeenCalledWith("el-request", { action: "cancel" });
  });
});

/**
 * Copilot CLI >= 1.0.74 serves `session.permissions.pendingRequests` from its
 * native runtime and ships no wire method that enumerates pending user input or
 * elicitation requests. The runtime stays the sole authority for *answering* a
 * request; Bridge only keeps an event-derived listing index so a reconnecting
 * browser can still see what is in flight.
 */
describe("SessionManager pending elicitation listing fallback", () => {
  function indexPendingElicitation(
    eventBusRegistry: ReturnType<typeof createEventBusRegistry>,
    requestId = "el-request",
  ): void {
    eventBusRegistry.getOrCreateBus("session-1").emitElicitationRequested({
      requestId,
      message: "Configure deployment",
      mode: "form",
      requestedSchema: pendingRequest().request.requestedSchema as never,
      elicitationSource: "deployment-mcp",
    });
  }

  function makeUnsupported() {
    const created = createManager([pendingRequest()]);
    vi.mocked(created.session.getPendingElicitationRequests!).mockRejectedValue(
      new AgentPendingInteractionUnsupportedError("no listing wire method"),
    );
    vi.mocked(created.session.getPendingUserInputRequests!).mockRejectedValue(
      new AgentPendingInteractionUnsupportedError("no listing wire method"),
    );
    return created;
  }

  it("hydrates a reconnect from the listing index and marks it non-authoritative", async () => {
    const { manager, eventBusRegistry } = makeUnsupported();
    indexPendingElicitation(eventBusRegistry);

    await expect(manager.hydratePendingInteractions("session-1")).resolves.toEqual({
      pendingUserInputs: [],
      pendingElicitations: [{
        requestId: "el-request",
        message: "Configure deployment",
        mode: "form",
        elicitationSource: "deployment-mcp",
        requestedSchema: pendingRequest().request.requestedSchema,
      }],
      runtimeSourced: { userInput: false, elicitation: false },
    });
  });

  it("validates against the indexed view and still delegates the response to the runtime", async () => {
    const { manager, tryRespondToElicitation, eventBusRegistry } = makeUnsupported();
    indexPendingElicitation(eventBusRegistry);

    await expect(manager.submitElicitationResponse("session-1", "el-request", {
      action: "accept",
      content: { target: "staging", reason: "Safer" },
    })).resolves.toMatchObject({ requestId: "el-request", action: "accept" });
    expect(tryRespondToElicitation).toHaveBeenCalledWith("el-request", {
      action: "accept",
      content: { target: "staging", reason: "Safer" },
    });
  });

  it("keeps schema validation intact when the view comes from the index", async () => {
    const { manager, tryRespondToElicitation, eventBusRegistry } = makeUnsupported();
    indexPendingElicitation(eventBusRegistry);

    await expect(manager.submitElicitationResponse("session-1", "el-request", {
      action: "accept",
      content: { target: "staging" },
    })).rejects.toMatchObject({
      code: "invalid_response",
      statusCode: 400,
    } satisfies Partial<PendingInteractionError>);
    expect(tryRespondToElicitation).not.toHaveBeenCalled();
  });

  it("keeps the runtime authoritative for stale ids", async () => {
    const { manager, tryRespondToElicitation, eventBusRegistry } = makeUnsupported();
    indexPendingElicitation(eventBusRegistry);
    tryRespondToElicitation.mockResolvedValueOnce(false);

    await expect(manager.submitElicitationResponse("session-1", "el-request", {
      action: "cancel",
    })).rejects.toMatchObject({
      code: "request_not_found",
      statusCode: 404,
    } satisfies Partial<PendingInteractionError>);
  });

  it("404s an id the index never saw instead of inventing one", async () => {
    const { manager, tryRespondToElicitation, eventBusRegistry } = makeUnsupported();
    indexPendingElicitation(eventBusRegistry);

    await expect(manager.submitElicitationResponse("session-1", "el-unknown", {
      action: "cancel",
    })).rejects.toMatchObject({
      code: "request_not_found",
      statusCode: 404,
    } satisfies Partial<PendingInteractionError>);
    expect(tryRespondToElicitation).not.toHaveBeenCalled();
  });

  it("cancels indexed requests captured before the terminal event replaced the bus", async () => {
    const { manager, session, tryRespondToElicitation, eventBusRegistry } = makeUnsupported();
    indexPendingElicitation(eventBusRegistry);
    recordPendingElicitation(manager);

    // Hold the terminal lookup open so the bus really is replaced mid-cancel.
    let rejectTerminalLookup!: (error: unknown) => void;
    vi.mocked(session.getPendingElicitationRequests!).mockImplementationOnce(
      () => new Promise((_resolve, reject) => { rejectTerminalLookup = reject; }),
    );

    const terminalBus = eventBusRegistry.getOrCreateBus("session-1");
    abortRun(manager, terminalBus);
    expect(terminalBus.complete).toBe(true);

    // A new run starts before cancellation settles and registers its own request.
    const nextRunBus = eventBusRegistry.getOrCreateBus("session-1");
    expect(nextRunBus).not.toBe(terminalBus);
    nextRunBus.emitElicitationRequested({
      requestId: "el-next-run",
      message: "Next run question",
      mode: "form",
      requestedSchema: pendingRequest().request.requestedSchema as never,
    });

    rejectTerminalLookup(new AgentPendingInteractionUnsupportedError("no listing wire method"));
    await Reflect.get(manager, "pendingInteractionCleanups").get("session-1");

    // Only the terminated run's request is cancelled...
    expect(tryRespondToElicitation).toHaveBeenCalledTimes(1);
    expect(tryRespondToElicitation).toHaveBeenCalledWith("el-request", { action: "cancel" });
    // ...and the clear lands on the captured bus, never the new run's index.
    expect(nextRunBus.getPendingInteractionIndex().pendingElicitations.map((r) => r.requestId))
      .toEqual(["el-next-run"]);
    expect(terminalBus.getPendingInteractionIndex().pendingElicitations).toEqual([]);
  });

  it("does not resurrect a terminated run's request into a reconnect snapshot", async () => {
    const { manager, eventBusRegistry } = makeUnsupported();
    const bus = eventBusRegistry.getOrCreateBus("session-1");
    indexPendingElicitation(eventBusRegistry);
    recordPendingElicitation(manager);

    abortRun(manager, bus);
    // Simulate cancellation failing to drain the index (e.g. a dead runtime).
    await Reflect.get(manager, "pendingInteractionCleanups").get("session-1");
    bus.emitElicitationRequested({
      requestId: "el-zombie",
      message: "Left behind",
      mode: "form",
      requestedSchema: pendingRequest().request.requestedSchema as never,
    });
    expect(bus.complete).toBe(true);

    await expect(manager.hydratePendingInteractions("session-1")).resolves.toMatchObject({
      pendingUserInputs: [],
      pendingElicitations: [],
    });
    expect(manager.getPendingUserInputCount("session-1")).toBe(0);
  });

  it("cancels indexed requests even when no derived count was recorded", async () => {
    const { manager, tryRespondToElicitation, eventBusRegistry } = makeUnsupported();
    indexPendingElicitation(eventBusRegistry);

    abortRun(manager, eventBusRegistry.getOrCreateBus("session-1"));
    await Reflect.get(manager, "pendingInteractionCleanups").get("session-1");

    expect(tryRespondToElicitation).toHaveBeenCalledWith("el-request", { action: "cancel" });
  });

  it("does not degrade an unsupported listing into a backend failure", async () => {
    const { manager } = makeUnsupported();

    await expect(manager.hydratePendingInteractions("session-1")).resolves.toMatchObject({
      pendingElicitations: [],
      runtimeSourced: { elicitation: false },
    });
  });

  it("still surfaces genuine backend failures", async () => {
    const { manager, session } = createManager([pendingRequest()]);
    vi.mocked(session.getPendingElicitationRequests!).mockRejectedValue(
      new Error("session connection closed"),
    );

    await expect(manager.hydratePendingInteractions("session-1")).rejects.toMatchObject({
      code: "backend_unavailable",
      statusCode: 503,
    } satisfies Partial<PendingInteractionError>);
  });

  it("does not let one unparseable sibling block a valid response", async () => {
    const { manager, session, tryRespondToElicitation } = createManager([
      // `message` must be a string; this entry cannot be normalized.
      { requestId: "el-broken", request: { message: 42 } as never },
      pendingRequest(),
    ]);
    vi.mocked(session.getPendingElicitationRequests!).mockResolvedValue([
      { requestId: "el-broken", request: { message: 42 } as never },
      pendingRequest(),
    ]);

    await expect(manager.submitElicitationResponse("session-1", "el-request", {
      action: "accept",
      content: { target: "staging", reason: "Safer" },
    })).resolves.toMatchObject({ requestId: "el-request", action: "accept" });
    expect(tryRespondToElicitation).toHaveBeenCalledWith("el-request", {
      action: "accept",
      content: { target: "staging", reason: "Safer" },
    });
  });

  it("keeps the envelope request id authoritative over a payload field", async () => {
    const { manager, session } = createManager([pendingRequest()]);
    vi.mocked(session.getPendingElicitationRequests!).mockResolvedValue([{
      requestId: "el-envelope",
      request: { ...pendingRequest().request, requestId: "el-spoofed" } as never,
    }]);

    await expect(manager.hydratePendingInteractions("session-1")).resolves.toMatchObject({
      pendingElicitations: [expect.objectContaining({ requestId: "el-envelope" })],
    });
  });
});
