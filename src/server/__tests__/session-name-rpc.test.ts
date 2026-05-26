import { describe, expect, it, vi } from "vitest";
import { createSessionNameRpc } from "../session-name-rpc.js";

describe("session name RPC persistence", () => {
  type WithSessionNameRpc = <T>(sessionId: string, operation: (session: any) => Promise<T>) => Promise<T>;

  function createRpc(options: {
    session?: any;
    withSessionNameRpc?: WithSessionNameRpc;
    emitted?: Array<{ sessionId: string; name: string }>;
    retryDelaysMs?: readonly number[];
  } = {}) {
    const session = options.session ?? {};
    const withSessionNameRpc = options.withSessionNameRpc
      ?? vi.fn(async <T>(_sessionId: string, operation: (session: any) => Promise<T>) => operation(session));
    const emitted = options.emitted ?? [];
    const rpc = createSessionNameRpc({
      getSessionStateDir: (sessionId) => `/unused/${sessionId}`,
      withSessionNameRpc: withSessionNameRpc as WithSessionNameRpc,
      emitSessionNameChanged: (sessionId, name) => emitted.push({ sessionId, name }),
      retryDelaysMs: options.retryDelaysMs ?? [0, 0, 0, 0],
    });
    return { rpc, withSessionNameRpc, emitted };
  }

  it("retries name.set and name.get on one resumed SDK session until the expected name is visible", async () => {
    let visibleName: string | null = null;
    const set = vi.fn(async ({ name }: { name: string }) => {
      if (set.mock.calls.length >= 3) visibleName = name;
    });
    const get = vi.fn(async () => ({ name: visibleName }));
    const session = { setName: set, getName: get };
    const { rpc, withSessionNameRpc, emitted } = createRpc({ session });

    await rpc.setSessionName("session-1", "New concise title");

    expect(withSessionNameRpc).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledTimes(3);
    expect(get).toHaveBeenCalledTimes(3);
    expect(set.mock.contexts.every((context) => context === session)).toBe(true);
    expect(get.mock.contexts.every((context) => context === session)).toBe(true);
    expect(emitted).toEqual([{ sessionId: "session-1", name: "New concise title" }]);
  });

  it("retries on a supplied live session without launching a temporary resume", async () => {
    let visibleName: string | null = null;
    const set = vi.fn(async ({ name }: { name: string }) => {
      if (set.mock.calls.length >= 2) visibleName = name;
    });
    const get = vi.fn(async () => ({ name: visibleName }));
    const session = { setName: set, getName: get };
    const withSessionNameRpc = vi.fn(async <T>(_sessionId: string, _operation: (session: any) => Promise<T>) => {
      throw new Error("unexpected resume");
    });
    const { rpc, emitted } = createRpc({ session, withSessionNameRpc, retryDelaysMs: [0, 0] });

    await rpc.setSessionName("session-1", "Live session title", { session: session as unknown as any });

    expect(withSessionNameRpc).not.toHaveBeenCalled();
    expect(set).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenCalledTimes(2);
    expect(emitted).toEqual([{ sessionId: "session-1", name: "Live session title" }]);
  });

  it("does not emit success when name.get never returns the expected title", async () => {
    const set = vi.fn(async () => {});
    const get = vi.fn(async () => ({ name: null }));
    const emitted: Array<{ sessionId: string; name: string }> = [];
    const { rpc } = createRpc({
      session: { setName: set, getName: get },
      emitted,
      retryDelaysMs: [0, 0],
    });

    await expect(rpc.setSessionName("session-1", "Unverified title"))
      .rejects.toThrow("Session rename did not verify for session-1 after 2 attempt(s): name.get returned no title");

    expect(set).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenCalledTimes(2);
    expect(emitted).toEqual([]);
  });

  it("requires both name.set and name.get so rename success can be verified", async () => {
    const emitted: Array<{ sessionId: string; name: string }> = [];
    const { rpc } = createRpc({
      session: { setName: vi.fn(async () => {}) },
      emitted,
    });

    await expect(rpc.setSessionName("session-1", "Missing getter"))
      .rejects.toThrow("Session name RPC is not available in this Copilot SDK build");
    expect(emitted).toEqual([]);
  });
});
