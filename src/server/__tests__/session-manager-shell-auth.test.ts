import { describe, expect, it } from "vitest";

import type { AgentSession } from "../agent-backend/index.js";
import { createEventBusRegistry, type StreamEvent } from "../event-bus.js";
import { SessionManager } from "../session-manager.js";
import { createSessionTitlesStore } from "../session-titles.js";
import type { ShellAuthHandler } from "../shell-auth-requests.js";
import { createTaskStore } from "../task-store.js";
import { createTestBus, makeAgentSessionStub, makeTestRuntimePaths, setupTestDb } from "./helpers.js";

const SECRET = "correct-horse-battery-staple";

function createManager() {
  const db = setupTestDb();
  const globalBus = createTestBus();
  const eventBusRegistry = createEventBusRegistry();
  const runtimePaths = makeTestRuntimePaths("shell-auth-manager");
  const bus = eventBusRegistry.getOrCreateBus("session-1");
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
  const session = makeAgentSessionStub({ sessionId: "session-1" }) as unknown as AgentSession;
  (Reflect.get(manager, "sessionObjects") as Map<string, AgentSession>).set("session-1", session);
  const events: StreamEvent[] = [];
  bus.subscribe((event) => events.push(event));
  // The handler a chat's session config gives the runtime on create and resume.
  const config = (Reflect.get(manager, "buildSessionConfig") as Function).call(manager, { sessionId: "session-1" });
  const handler = config.onShellAuthenticationRequest as ShellAuthHandler;
  return { manager, bus, events, handler };
}

function ask(handler: ShellAuthHandler, signal = new AbortController().signal) {
  return handler({
    requestId: "auth-1",
    program: "sudo",
    prompt: "[sudo] password for user:",
    inputKind: "secret",
    command: "sudo -A apt-get update",
    cwd: "/home/user/project",
  }, { sessionId: "session-1", signal });
}

describe("SessionManager shell authentication", () => {
  it("shows a shell prompt in the chat and hands the answer to the command alone", async () => {
    const { manager, bus, events, handler } = createManager();
    expect(handler).toEqual(expect.any(Function));

    const answer = ask(handler);
    expect(events).toContainEqual(expect.objectContaining({
      type: "shell_auth_requested",
      requestId: "auth-1",
      program: "sudo",
      prompt: "[sudo] password for user:",
      inputKind: "secret",
      command: "sudo -A apt-get update",
      cwd: "/home/user/project",
    }));
    expect(manager.getPendingUserInputCount("session-1")).toBe(1);
    expect((await manager.hydratePendingInteractions("session-1")).pendingShellAuths)
      .toEqual([expect.objectContaining({ requestId: "auth-1", inputKind: "secret" })]);

    const submitted = manager.submitShellAuthResponse("session-1", "auth-1", { action: "accept", value: SECRET });

    await expect(answer).resolves.toEqual({ action: "accept", value: SECRET });
    expect(submitted).toEqual({ requestId: "auth-1", action: "accept", timestamp: expect.any(String) });
    expect(events.at(-1)).toEqual({
      type: "shell_auth_resolved",
      requestId: "auth-1",
      action: "accept",
      timestamp: expect.any(String),
    });
    expect(JSON.stringify([events, bus.getSnapshot(), submitted])).not.toContain(SECRET);
    expect(manager.getPendingUserInputCount("session-1")).toBe(0);
    expect(() => manager.submitShellAuthResponse("session-1", "auth-1", { action: "accept", value: SECRET }))
      .toThrow(expect.objectContaining({ code: "request_not_found", statusCode: 404 }));
  });

  it.each([
    {
      name: "the runtime stops waiting",
      reason: "expired",
      end: (_manager: SessionManager, controller: AbortController) => controller.abort(),
    },
    {
      name: "the run is stopped",
      reason: "session_ended",
      end: (manager: SessionManager) => {
        const bus = (Reflect.get(manager, "deps") as { eventBusRegistry: ReturnType<typeof createEventBusRegistry> })
          .eventBusRegistry.getBus("session-1");
        (Reflect.get(manager, "createRunController") as Function).call(manager, "session-1", bus).completeAborted("");
      },
    },
  ])("takes the prompt away when $name", async ({ reason, end }) => {
    const { manager, events, handler } = createManager();
    const controller = new AbortController();
    const answer = ask(handler, controller.signal);

    end(manager, controller);

    await expect(answer).resolves.toEqual({ action: "cancel" });
    expect(events).toContainEqual(expect.objectContaining({ type: "shell_auth_canceled", requestId: "auth-1", reason }));
    expect(manager.getPendingUserInputCount("session-1")).toBe(0);
    expect(() => manager.submitShellAuthResponse("session-1", "auth-1", { action: "cancel" }))
      .toThrow(expect.objectContaining({ statusCode: 404 }));
  });

  it("keeps the prompt open when the answer is invalid", async () => {
    const { manager, handler } = createManager();
    const answer = ask(handler);

    expect(() => manager.submitShellAuthResponse("session-1", "auth-1", { action: "accept", value: "x".repeat(4_097) }))
      .toThrow(expect.objectContaining({ code: "invalid_response", statusCode: 400 }));
    expect(manager.getPendingUserInputCount("session-1")).toBe(1);

    manager.submitShellAuthResponse("session-1", "auth-1", { action: "cancel" });
    await expect(answer).resolves.toEqual({ action: "cancel" });
  });
});
