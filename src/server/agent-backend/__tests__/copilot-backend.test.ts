// Wrap-fidelity tests for CopilotBackend.
//
// These do NOT assert behavior. They assert that each AgentBackend /
// AgentSession method delegates to the underlying CopilotClient /
// CopilotSession rpc namespaces with the exact arguments the
// SessionManager and SessionRunner pass today. Behavioral coverage stays
// in the existing session-manager-*/session-runner-* tests.

import { describe, expect, it, vi } from "vitest";
import { CopilotBackend } from "../copilot-backend.js";

function createFakeSession(rpc: any = {}) {
  return {
    sessionId: "fake-session-id",
    send: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    disconnect: vi.fn(),
    on: vi.fn(() => () => undefined),
    getEvents: vi.fn(async () => [{ type: "test" }]),
    rpc,
  };
}

function createFakeClient(session: ReturnType<typeof createFakeSession> = createFakeSession()) {
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
    rpc: { sessions: { fork: vi.fn(async () => ({ sessionId: "fork-id" })) } },
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

  it("forkSession passes sessionId and toEventId to rpc.sessions.fork", async () => {
    const client = createFakeClient();
    const backend = new CopilotBackend(client as any);

    await expect(backend.forkSession!("src-id")).resolves.toEqual({ sessionId: "fork-id" });
    expect(client.rpc.sessions.fork).toHaveBeenCalledWith({ sessionId: "src-id" });

    await backend.forkSession!("src-id", { toEventId: "evt-7" });
    expect(client.rpc.sessions.fork).toHaveBeenLastCalledWith({ sessionId: "src-id", toEventId: "evt-7" });
  });

  it("forkSession throws when rpc.sessions.fork is missing", async () => {
    const client = createFakeClient();
    delete (client as any).rpc;
    const backend = new CopilotBackend(client as any);
    await expect(backend.forkSession!("src-id")).rejects.toThrow(/fork is not available/);
  });
});

describe("CopilotAgentSession wrap fidelity", () => {
  it("forwards send/abort/setModel with identical arguments", async () => {
    const session = createFakeSession();
    const backend = new CopilotBackend(createFakeClient(session) as any);
    const wrapped = await backend.createSession({} as any);

    const sendArgs = { prompt: "hi", attachments: [{ kind: "image" }], mode: "immediate" as const };
    await wrapped.send(sendArgs);
    expect(session.send).toHaveBeenCalledWith(sendArgs);

    await wrapped.abort();
    expect(session.abort).toHaveBeenCalledOnce();

    await wrapped.setModel("gpt-5", { reasoningEffort: "high" });
    expect(session.setModel).toHaveBeenCalledWith("gpt-5", { reasoningEffort: "high" });
  });

  it("exposes sessionId and disconnect from the underlying session", async () => {
    const session = createFakeSession();
    const wrapped = await new CopilotBackend(createFakeClient(session) as any).createSession({} as any);
    expect(wrapped.sessionId).toBe("fake-session-id");
    wrapped.disconnect?.();
    expect(session.disconnect).toHaveBeenCalledOnce();
  });

  it("registers and unregisters event handlers via on()", async () => {
    const unsub = vi.fn();
    const onImpl = vi.fn(() => unsub);
    const session = { ...createFakeSession(), on: onImpl };
    const wrapped = await new CopilotBackend(createFakeClient(session as any) as any).createSession({} as any);

    const handler = vi.fn();
    const off = wrapped.on(handler);
    expect(onImpl).toHaveBeenCalledWith(handler);
    off();
    expect(unsub).toHaveBeenCalledOnce();
  });

  it("delegates getEvents and surfaces a clear error when the SDK lacks it", async () => {
    const session = createFakeSession();
    const wrapped = await new CopilotBackend(createFakeClient(session) as any).createSession({} as any);

    await expect(wrapped.getEvents!()).resolves.toEqual([{ type: "test" }]);

    delete (session as any).getEvents;
    await expect(wrapped.getEvents!()).rejects.toThrow(/event API is not available/);
  });

  it("setSendMode delegates to rpc.mode.set and throws when unavailable", async () => {
    const setMode = vi.fn(async () => undefined);
    const session = createFakeSession({ mode: { set: setMode } });
    const wrapped = await new CopilotBackend(createFakeClient(session) as any).createSession({} as any);

    await wrapped.setSendMode!({ mode: "immediate" });
    expect(setMode).toHaveBeenCalledWith({ mode: "immediate" });

    const wrapped2 = await new CopilotBackend(createFakeClient(createFakeSession({})) as any).createSession({} as any);
    await expect(wrapped2.setSendMode!({ mode: "immediate" })).rejects.toThrow(/mode switching is not available/);
  });

  it("startFleet delegates to rpc.fleet.start and throws when unavailable", async () => {
    const start = vi.fn(async () => undefined);
    const session = createFakeSession({ fleet: { start } });
    const wrapped = await new CopilotBackend(createFakeClient(session) as any).createSession({} as any);

    await wrapped.startFleet!({ prompt: "go" });
    expect(start).toHaveBeenCalledWith({ prompt: "go" });

    const wrapped2 = await new CopilotBackend(createFakeClient(createFakeSession({})) as any).createSession({} as any);
    await expect(wrapped2.startFleet!({ prompt: "go" })).rejects.toThrow(/Fleet mode is not available/);
  });

  it("getCurrentModel returns undefined when rpc.model.getCurrent is missing", async () => {
    const wrapped = await new CopilotBackend(createFakeClient(createFakeSession({})) as any).createSession({} as any);
    await expect(wrapped.getCurrentModel!()).resolves.toBeUndefined();

    const getCurrent = vi.fn(async () => ({ modelId: "gpt-5" }));
    const session2 = createFakeSession({ model: { getCurrent } });
    const wrapped2 = await new CopilotBackend(createFakeClient(session2) as any).createSession({} as any);
    await expect(wrapped2.getCurrentModel!()).resolves.toEqual({ modelId: "gpt-5" });
  });

  it("truncateHistory returns undefined when rpc.history.truncate is missing", async () => {
    const wrapped = await new CopilotBackend(createFakeClient(createFakeSession({})) as any).createSession({} as any);
    await expect(wrapped.truncateHistory!({ eventId: "x" })).resolves.toBeUndefined();

    const truncate = vi.fn(async () => ({ eventsRemoved: 4 }));
    const session2 = createFakeSession({ history: { truncate } });
    const wrapped2 = await new CopilotBackend(createFakeClient(session2) as any).createSession({} as any);
    await expect(wrapped2.truncateHistory!({ eventId: "x" })).resolves.toEqual({ eventsRemoved: 4 });
    expect(truncate).toHaveBeenCalledWith({ eventId: "x" });
  });

  it("listMcpServers returns undefined when rpc.mcp.list is missing", async () => {
    const wrapped = await new CopilotBackend(createFakeClient(createFakeSession({})) as any).createSession({} as any);
    await expect(wrapped.listMcpServers!()).resolves.toBeUndefined();

    const list = vi.fn(async () => ({ servers: [{ name: "a", status: "connected" }] }));
    const session2 = createFakeSession({ mcp: { list } });
    const wrapped2 = await new CopilotBackend(createFakeClient(session2) as any).createSession({} as any);
    await expect(wrapped2.listMcpServers!()).resolves.toEqual({ servers: [{ name: "a", status: "connected" }] });
  });

  it("startMcpOauthLogin throws when rpc.mcp.oauth.login is missing, delegates otherwise", async () => {
    const session = createFakeSession({ mcp: {} });
    const wrapped = await new CopilotBackend(createFakeClient(session) as any).createSession({} as any);
    await expect(wrapped.startMcpOauthLogin!({ serverName: "x" })).rejects.toThrow(/OAuth login is not available/);

    const login = vi.fn(async () => ({ authorizationUrl: "https://x" }));
    const session2 = createFakeSession({ mcp: { oauth: { login } } });
    const wrapped2 = await new CopilotBackend(createFakeClient(session2) as any).createSession({} as any);
    await wrapped2.startMcpOauthLogin!({ serverName: "x" });
    expect(login).toHaveBeenCalledWith({ serverName: "x" });
  });

  it("getName/setName delegate to rpc.name and throw on setName when missing", async () => {
    const get = vi.fn(async () => ({ name: "title" }));
    const set = vi.fn(async () => undefined);
    const session = createFakeSession({ name: { get, set } });
    const wrapped = await new CopilotBackend(createFakeClient(session) as any).createSession({} as any);

    await expect(wrapped.getName!()).resolves.toEqual({ name: "title" });
    await wrapped.setName!({ name: "new" });
    expect(set).toHaveBeenCalledWith({ name: "new" });

    const wrapped2 = await new CopilotBackend(createFakeClient(createFakeSession({})) as any).createSession({} as any);
    await expect(wrapped2.getName!()).resolves.toBeUndefined();
    await expect(wrapped2.setName!({ name: "new" })).rejects.toThrow(/Session name RPC is not available/);
  });
});
