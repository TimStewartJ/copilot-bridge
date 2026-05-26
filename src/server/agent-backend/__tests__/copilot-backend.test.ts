// Wrap-fidelity tests for CopilotBackend.
//
// These do NOT assert behavior. They assert that each AgentBackend /
// AgentSession method delegates to the underlying CopilotClient /
// CopilotSession with the exact arguments the SessionManager and
// SessionRunner pass today. Behavioral coverage stays in the existing
// session-manager-*/session-runner-* tests.

import { describe, expect, it, vi } from "vitest";
import { CopilotBackend } from "../copilot-backend.js";

function createFakeSession() {
  return {
    sessionId: "fake-session-id",
    send: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    disconnect: vi.fn(),
    on: vi.fn(() => () => undefined),
    getEvents: vi.fn(async () => [{ type: "test" }]),
    rpc: { sentinel: true },
  };
}

function createFakeClient(session = createFakeSession()) {
  return {
    session,
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    forceStop: vi.fn(async () => undefined),
    listModels: vi.fn(async () => [{ id: "fake-model", name: "Fake" }]),
    listSessions: vi.fn(async () => [{ sessionId: "s1", title: "S1" }]),
    createSession: vi.fn(async () => session),
    resumeSession: vi.fn(async () => session),
    deleteSession: vi.fn(async () => undefined),
    getSessionMetadata: vi.fn(async () => ({ sessionId: "s1" })),
    rpc: { sessions: { fork: vi.fn() } },
  };
}

describe("CopilotBackend wrap fidelity", () => {
  it("exposes the copilot id and full capability set", () => {
    const backend = new CopilotBackend(createFakeClient() as any);
    expect(backend.id).toBe("copilot");
    expect(backend.capabilities).toMatchObject({
      resumeSession: true,
      streamingToolInput: true,
      costUsage: true,
      subAgents: true,
      images: true,
      bidirectionalStdin: false,
      externalToolEvents: true,
      forkBoundaries: true,
    });
  });

  it("delegates start/stop/forceStop to the SDK client", async () => {
    const client = createFakeClient();
    const backend = new CopilotBackend(client as any);
    await backend.start();
    await backend.stop();
    await backend.forceStop();
    expect(client.start).toHaveBeenCalledOnce();
    expect(client.stop).toHaveBeenCalledOnce();
    expect(client.forceStop).toHaveBeenCalledOnce();
  });

  it("returns no-op forceStop when the underlying SDK has no method", async () => {
    const client = createFakeClient();
    delete (client as any).forceStop;
    const backend = new CopilotBackend(client as any);
    await expect(backend.forceStop()).resolves.toBeUndefined();
  });

  it("delegates listModels and listSessions verbatim", async () => {
    const client = createFakeClient();
    const backend = new CopilotBackend(client as any);
    await expect(backend.listModels()).resolves.toEqual([{ id: "fake-model", name: "Fake" }]);
    await expect(backend.listSessions()).resolves.toEqual([{ sessionId: "s1", title: "S1" }]);
    expect(client.listModels).toHaveBeenCalledOnce();
    expect(client.listSessions).toHaveBeenCalledOnce();
  });

  it("forwards createSession/resumeSession config and wraps the returned session", async () => {
    const client = createFakeClient();
    const backend = new CopilotBackend(client as any);
    const config = { workingDirectory: "/x", mcpServers: {} };
    const created = await backend.createSession(config);
    expect(client.createSession).toHaveBeenCalledWith(config);
    expect(created.sessionId).toBe("fake-session-id");

    const resumed = await backend.resumeSession("abc", config);
    expect(client.resumeSession).toHaveBeenCalledWith("abc", config);
    expect(resumed.sessionId).toBe("fake-session-id");
  });

  it("delegates deleteSession and getSessionMetadata", async () => {
    const client = createFakeClient();
    const backend = new CopilotBackend(client as any);
    await backend.deleteSession("zzz");
    await backend.getSessionMetadata("zzz");
    expect(client.deleteSession).toHaveBeenCalledWith("zzz");
    expect(client.getSessionMetadata).toHaveBeenCalledWith("zzz");
  });

  it("exposes the raw rpc handle through .rpc for legacy escape hatches", () => {
    const client = createFakeClient();
    const backend = new CopilotBackend(client as any);
    expect(backend.rpc).toBe(client.rpc);
  });
});

describe("CopilotAgentSession wrap fidelity", () => {
  it("forwards send/abort/setModel with identical arguments", async () => {
    const session = createFakeSession();
    const client = createFakeClient(session);
    const backend = new CopilotBackend(client as any);
    const wrapped = await backend.createSession({} as any);

    const sendArgs = { prompt: "hi", attachments: [{ kind: "image" }], mode: "immediate" as const };
    await wrapped.send(sendArgs);
    expect(session.send).toHaveBeenCalledWith(sendArgs);

    await wrapped.abort();
    expect(session.abort).toHaveBeenCalledOnce();

    await wrapped.setModel("gpt-5", { reasoningEffort: "high" });
    expect(session.setModel).toHaveBeenCalledWith("gpt-5", { reasoningEffort: "high" });
  });

  it("exposes sessionId, rpc, and disconnect from the underlying session", async () => {
    const session = createFakeSession();
    const client = createFakeClient(session);
    const backend = new CopilotBackend(client as any);
    const wrapped = await backend.createSession({} as any);

    expect(wrapped.sessionId).toBe("fake-session-id");
    expect(wrapped.rpc).toBe(session.rpc);

    wrapped.disconnect?.();
    expect(session.disconnect).toHaveBeenCalledOnce();
  });

  it("registers and unregisters event handlers via on()", async () => {
    const unsub = vi.fn();
    const onImpl = vi.fn(() => unsub);
    const session = { ...createFakeSession(), on: onImpl };
    const client = createFakeClient(session as any);
    const backend = new CopilotBackend(client as any);
    const wrapped = await backend.createSession({} as any);

    const handler = vi.fn();
    const off = wrapped.on(handler);
    expect(onImpl).toHaveBeenCalledWith(handler);
    off();
    expect(unsub).toHaveBeenCalledOnce();
  });

  it("delegates getEvents and surfaces a clear error when the SDK lacks it", async () => {
    const session = createFakeSession();
    const client = createFakeClient(session);
    const backend = new CopilotBackend(client as any);
    const wrapped = await backend.createSession({} as any);

    await expect(wrapped.getEvents!()).resolves.toEqual([{ type: "test" }]);

    delete (session as any).getEvents;
    await expect(wrapped.getEvents!()).rejects.toThrow(/event API is not available/);
  });

  it("CopilotBackend.unwrapSession returns the raw SDK session for legacy callers", async () => {
    const session = createFakeSession();
    const client = createFakeClient(session);
    const backend = new CopilotBackend(client as any);
    const wrapped = await backend.createSession({} as any);
    expect(CopilotBackend.unwrapSession(wrapped)).toBe(session);
  });
});
