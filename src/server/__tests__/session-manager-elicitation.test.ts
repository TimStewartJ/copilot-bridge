import { describe, expect, it, vi } from "vitest";

import type { AgentPendingElicitationRequest, AgentSession } from "../agent-backend/index.js";
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
