import { describe, expect, it, vi } from "vitest";

import type { AgentSession } from "../agent-backend/index.js";
import type { PendingElicitationRequestView } from "../elicitation-types.js";
import { createEventBusRegistry } from "../event-bus.js";
import { PendingInteractionError } from "../pending-interaction-validation.js";
import { SessionManager } from "../session-manager.js";
import { createSessionTitlesStore } from "../session-titles.js";
import { createTaskStore } from "../task-store.js";
import { createTestBus, makeAgentSessionStub, makeTestRuntimePaths, setupTestDb } from "./helpers.js";

function pendingRequest(): PendingElicitationRequestView {
  return {
    requestId: "el-request",
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
    } as never,
    elicitationSource: "deployment-mcp",
  };
}

/**
 * The Copilot runtime owns elicitation requests but exposes no wire method that
 * enumerates them, so Bridge's event-derived listing index is the only listing
 * source. Seed it the way `session-runner` does when the runtime raises
 * `elicitation.requested`; the runtime still adjudicates every response.
 */
function createManager(pending: PendingElicitationRequestView[] = []) {
  const db = setupTestDb();
  const globalBus = createTestBus();
  const eventBusRegistry = createEventBusRegistry();
  const runtimePaths = makeTestRuntimePaths("elicitation-manager");
  const bus = eventBusRegistry.getOrCreateBus("session-1");
  for (const request of pending) bus.emitElicitationRequested(request);
  const tryRespondToElicitation = vi.fn(async (requestId: string) => {
    const index = pending.findIndex((request) => request.requestId === requestId);
    if (index < 0) return false;
    pending.splice(index, 1);
    eventBusRegistry.getBus("session-1")?.emitElicitationResolved(requestId, "cancel");
    return true;
  });
  const session = makeAgentSessionStub({
    sessionId: "session-1",
    tryRespondToElicitation,
  }) as unknown as AgentSession;
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
  return { manager, session, tryRespondToElicitation, eventBusRegistry, bus };
}

function indexPendingElicitation(
  eventBusRegistry: ReturnType<typeof createEventBusRegistry>,
  requestId = "el-request",
): void {
  eventBusRegistry.getOrCreateBus("session-1").emitElicitationRequested({
    ...pendingRequest(),
    requestId,
  });
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

describe("SessionManager elicitation responses", () => {
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
  ])("validates a $name response against the indexed view and delegates it", async ({ payload }) => {
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

  it("rejects invalid form content before calling the runtime", async () => {
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

  it("keeps the runtime authoritative for stale ids", async () => {
    const { manager, tryRespondToElicitation } = createManager([pendingRequest()]);
    tryRespondToElicitation.mockResolvedValueOnce(false);

    await expect(manager.submitElicitationResponse("session-1", "el-request", {
      action: "cancel",
    })).rejects.toMatchObject({
      code: "request_not_found",
      statusCode: 404,
    } satisfies Partial<PendingInteractionError>);
  });

  it("404s an id the index never saw instead of inventing one", async () => {
    const { manager, tryRespondToElicitation } = createManager([pendingRequest()]);

    await expect(manager.submitElicitationResponse("session-1", "el-unknown", {
      action: "cancel",
    })).rejects.toMatchObject({
      code: "request_not_found",
      statusCode: 404,
    } satisfies Partial<PendingInteractionError>);
    expect(tryRespondToElicitation).not.toHaveBeenCalled();
  });

  it("surfaces a failing response RPC as a backend failure", async () => {
    const { manager, tryRespondToElicitation } = createManager([pendingRequest()]);
    tryRespondToElicitation.mockRejectedValue(new Error("session connection closed"));

    await expect(manager.submitElicitationResponse("session-1", "el-request", {
      action: "cancel",
    })).rejects.toMatchObject({
      code: "backend_unavailable",
      statusCode: 503,
    } satisfies Partial<PendingInteractionError>);
  });

  it("hydrates a reconnect from the listing index", async () => {
    const { manager } = createManager([pendingRequest()]);

    await expect(manager.hydratePendingInteractions("session-1")).resolves.toEqual({
      pendingUserInputs: [],
      pendingElicitations: [{
        requestId: "el-request",
        message: "Configure deployment",
        mode: "form",
        elicitationSource: "deployment-mcp",
        requestedSchema: pendingRequest().requestedSchema,
      }],
    });
  });
});

describe("SessionManager elicitation terminal cleanup", () => {
  it("cancels requests the runtime still holds when a run ends", async () => {
    const { manager, tryRespondToElicitation, eventBusRegistry } = createManager([pendingRequest()]);

    recordPendingElicitation(manager);
    abortRun(manager, eventBusRegistry.getOrCreateBus("session-1"));

    await expect(manager.hydratePendingInteractions("session-1")).resolves.toEqual({
      pendingUserInputs: [],
      pendingElicitations: [],
    });
    expect(tryRespondToElicitation).toHaveBeenCalledWith("el-request", { action: "cancel" });
  });

  it("holds reconnect hydration until terminal cancellation settles", async () => {
    const { manager, tryRespondToElicitation, eventBusRegistry } = createManager([pendingRequest()]);
    recordPendingElicitation(manager);
    let releaseCancel!: () => void;
    tryRespondToElicitation.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => {
        releaseCancel = () => resolve(true);
      }),
    );

    abortRun(manager, eventBusRegistry.getOrCreateBus("session-1"));
    let hydrated = false;
    const hydration = manager.hydratePendingInteractions("session-1")
      .then((snapshot) => {
        hydrated = true;
        return snapshot;
      });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(hydrated).toBe(false);

    releaseCancel();

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
    await Reflect.get(manager, "pendingInteractionCleanups").get("session-1");

    // The rejected sibling must not strand the rest of the cancellation pass.
    expect(tryRespondToElicitation).toHaveBeenCalledTimes(2);
    expect(tryRespondToElicitation).toHaveBeenCalledWith("el-stale", { action: "cancel" });
    expect(tryRespondToElicitation).toHaveBeenCalledWith("el-request", { action: "cancel" });
  });

  it("cancels indexed requests captured before the terminal event replaced the bus", async () => {
    const { manager, tryRespondToElicitation, eventBusRegistry } = createManager();
    indexPendingElicitation(eventBusRegistry);
    recordPendingElicitation(manager);

    // Hold the cancel open so the bus really is replaced mid-cancel.
    let releaseCancel!: () => void;
    tryRespondToElicitation.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => {
        releaseCancel = () => resolve(true);
      }),
    );

    const terminalBus = eventBusRegistry.getOrCreateBus("session-1");
    abortRun(manager, terminalBus);
    expect(terminalBus.complete).toBe(true);

    // A new run starts before cancellation settles and registers its own request.
    const nextRunBus = eventBusRegistry.getOrCreateBus("session-1");
    expect(nextRunBus).not.toBe(terminalBus);
    nextRunBus.emitElicitationRequested({ ...pendingRequest(), requestId: "el-next-run" });

    releaseCancel();
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
    const { manager, eventBusRegistry } = createManager();
    const bus = eventBusRegistry.getOrCreateBus("session-1");
    indexPendingElicitation(eventBusRegistry);
    recordPendingElicitation(manager);

    abortRun(manager, bus);
    // Simulate cancellation failing to drain the index (e.g. a dead runtime).
    await Reflect.get(manager, "pendingInteractionCleanups").get("session-1");
    bus.emitElicitationRequested({ ...pendingRequest(), requestId: "el-zombie" });
    expect(bus.complete).toBe(true);

    await expect(manager.hydratePendingInteractions("session-1")).resolves.toMatchObject({
      pendingUserInputs: [],
      pendingElicitations: [],
    });
    expect(manager.getPendingUserInputCount("session-1")).toBe(0);
  });

  it("cancels indexed requests even when no derived count was recorded", async () => {
    const { manager, tryRespondToElicitation, eventBusRegistry } = createManager();
    indexPendingElicitation(eventBusRegistry);

    abortRun(manager, eventBusRegistry.getOrCreateBus("session-1"));
    await Reflect.get(manager, "pendingInteractionCleanups").get("session-1");

    expect(tryRespondToElicitation).toHaveBeenCalledWith("el-request", { action: "cancel" });
  });
});
