import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createEventBusRegistry } from "../event-bus.js";
import { ElicitationBroker } from "../elicitation-broker.js";
import { SessionManager } from "../session-manager.js";
import { createSessionTitlesStore } from "../session-titles.js";
import { createTaskStore } from "../task-store.js";
import { createTestBus, makeTestRuntimePaths, setupTestDb } from "./helpers.js";

type ElicitationSessionConfig = {
  onElicitationRequest: (request: {
    sessionId: string;
    message: string;
    requestedSchema?: unknown;
    mode?: "form" | "url";
    elicitationSource?: string;
    url?: string;
  }) => Promise<{ action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> }>;
};

function createManager() {
  const db = setupTestDb();
  const globalBus = createTestBus();
  const eventBusRegistry = createEventBusRegistry();
  const runtimePaths = makeTestRuntimePaths("elicitation-manager");
  const copilotHome = runtimePaths.copilotHome;
  if (!copilotHome) throw new Error("Expected test runtime paths to include copilotHome");
  const elicitationBroker = new ElicitationBroker({
    requestIdFactory: () => "el_request",
    now: () => new Date("2026-07-13T12:00:00.000Z"),
  });
  const manager = new SessionManager({
    globalBus,
    eventBusRegistry,
    elicitationBroker,
    sessionTitles: createSessionTitlesStore(db),
    taskStore: createTaskStore(db, globalBus),
    config: { sessionMcpServers: {} },
    clientEnv: runtimePaths.env,
    copilotHome,
    runtimePaths,
  });
  return { manager, copilotHome, eventBusRegistry, globalBus, elicitationBroker };
}

function writeDiskSession(copilotHome: string, sessionId: string) {
  const sessionDir = join(copilotHome, "session-state", sessionId);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, "workspace.yaml"), "created_at: 2026-07-13T12:00:00.000Z\n");
}

describe("SessionManager elicitation responses", () => {
  it("wires native elicitation requests through the broker and sanitized stream events", async () => {
    const { manager, eventBusRegistry } = createManager();
    const cfg = (Reflect.get(manager, "buildSessionConfig") as () => ElicitationSessionConfig).call(manager);

    const responsePromise = cfg.onElicitationRequest({
      sessionId: "session-1",
      message: "Configure deployment",
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
    });

    const bus = eventBusRegistry.getBus("session-1")!;
    expect(bus.getSnapshot().pendingElicitations).toEqual([
      {
        requestId: "el_request",
        message: "Configure deployment",
        mode: "form",
        requestedAt: "2026-07-13T12:00:00.000Z",
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
    ]);

    const endpointResult = await manager.submitElicitationResponse("session-1", "el_request", {
      action: "accept",
      content: {
        target: "staging",
        reason: "Safer",
      },
    });

    expect(endpointResult).toMatchObject({
      requestId: "el_request",
      action: "accept",
    });
    expect(endpointResult).not.toHaveProperty("content");
    expect(bus.getSnapshot().pendingElicitations).toEqual([]);
    await expect(responsePromise).resolves.toEqual({
      action: "accept",
      content: {
        target: "staging",
        reason: "Safer",
      },
    });
  });

  it("combines legacy user input and elicitation in needs-answer status", async () => {
    const { manager, eventBusRegistry, globalBus } = createManager();
    const events: any[] = [];
    const unsubscribe = globalBus.subscribe((event) => {
      if (event.type === "session:user-input" && event.sessionId === "session-1") {
        events.push(event);
      }
    });
    const cfg = (Reflect.get(manager, "buildSessionConfig") as () => any).call(manager);

    const legacyPromise = cfg.onUserInputRequest(
      { question: "Legacy?" },
      { sessionId: "session-1" },
    );
    const elicitationPromise = cfg.onElicitationRequest({
      sessionId: "session-1",
      message: "Form?",
      requestedSchema: {
        type: "object",
        properties: {
          answer: { type: "string" },
        },
      },
    });

    expect(events.at(-1)).toMatchObject({
      pendingUserInputCount: 2,
      needsUserInput: true,
    });

    const legacyRequestId = eventBusRegistry.getBus("session-1")
      ?.getSnapshot()
      .pendingUserInputs[0]
      ?.requestId;
    if (!legacyRequestId) throw new Error("Expected a pending legacy user input request");
    await manager.submitUserInputResponse("session-1", legacyRequestId, {
      answer: "legacy",
      wasFreeform: true,
    });
    expect(events.at(-1)).toMatchObject({ pendingUserInputCount: 1, needsUserInput: true });

    await manager.submitElicitationResponse("session-1", "el_request", { action: "cancel" });
    expect(events.at(-1)).toMatchObject({ pendingUserInputCount: 0, needsUserInput: false });
    unsubscribe();
    await expect(legacyPromise).resolves.toEqual({ answer: "legacy", wasFreeform: true });
    await expect(elicitationPromise).resolves.toEqual({ action: "cancel" });
  });

  it("resolves pending elicitation as canceled when a run aborts", async () => {
    const { manager, eventBusRegistry, elicitationBroker } = createManager();
    const cfg = (Reflect.get(manager, "buildSessionConfig") as () => ElicitationSessionConfig).call(manager);
    const responsePromise = cfg.onElicitationRequest({
      sessionId: "session-1",
      message: "Continue?",
      requestedSchema: {
        type: "object",
        properties: {
          answer: { type: "boolean" },
        },
      },
    });

    const bus = eventBusRegistry.getBus("session-1")!;
    const events: any[] = [];
    const unsubscribe = bus.subscribe((event) => events.push(event));
    const controller = (Reflect.get(manager, "createRunController") as any).call(manager, "session-1", bus);
    controller.completeAborted("partial");
    unsubscribe();

    expect(elicitationBroker.getPendingCount("session-1")).toBe(0);
    expect(events.filter((event) => event.type !== "snapshot").map((event) => event.type)).toEqual([
      "elicitation_canceled",
      "aborted",
    ]);
    await expect(responsePromise).resolves.toEqual({ action: "cancel" });
  });

  it("addresses existing disk sessions without scanning the session list", async () => {
    const { manager, copilotHome } = createManager();
    writeDiskSession(copilotHome, "session-on-disk");

    await expect(manager.submitElicitationResponse("session-on-disk", "missing", {
      action: "cancel",
    })).rejects.toMatchObject({
      code: "request_not_found",
      statusCode: 404,
      message: "Pending elicitation request not found",
    });
  });
});
