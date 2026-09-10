import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { AgentBackend, AgentSession, AgentSessionRelease } from "../agent-backend/index.js";
import { makeAgentSessionStub } from "./helpers.js";

describe("agent session stub release contract", () => {
  it("requires release and fencing in backend-neutral contracts", () => {
    expectTypeOf<AgentSession["release"]>().toEqualTypeOf<() => Promise<AgentSessionRelease>>();
    expectTypeOf<AgentBackend["fence"]>().toEqualTypeOf<() => Promise<void>>();
  });

  it("acknowledges one simulated raw disconnect and caches its release promise", async () => {
    const disconnect = vi.fn(async () => undefined);
    const session = makeAgentSessionStub({ disconnect });
    const release = session.release();

    expect(session.release()).toBe(release);
    await expect(release).resolves.toEqual({ status: "released" });
    expect(session.release()).toBe(release);
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("remains pending until the injected raw disconnect settles", async () => {
    let finish!: () => void;
    const raw = new Promise<void>((resolve) => { finish = resolve; });
    const disconnect = vi.fn(() => raw);
    const session = makeAgentSessionStub({ disconnect });
    const release = session.release();
    let settled = false;
    void release.then(() => { settled = true; });

    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(session.release()).toBe(release);
    expect(disconnect).toHaveBeenCalledOnce();

    finish();
    await expect(release).resolves.toEqual({ status: "released" });
  });

  it.each(["synchronous", "asynchronous"])("preserves a %s disconnect failure without retrying", async (mode) => {
    const error = new Error("raw detach failed");
    const disconnect = vi.fn(() => {
      if (mode === "synchronous") throw error;
      return Promise.reject(error);
    });
    const session = makeAgentSessionStub({ disconnect });
    const release = session.release();

    await expect(release).rejects.toBe(error);
    expect(session.release()).toBe(release);
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("honors an explicit release override without invoking disconnect", async () => {
    const disconnect = vi.fn(async () => { throw new Error("must not run"); });
    const release = vi.fn(async () => ({ status: "uncertain" as const, detail: "fixture uncertainty" }));
    const session = makeAgentSessionStub({ disconnect, release });

    expect(session.release).toBe(release);
    await expect(session.release()).resolves.toEqual({ status: "uncertain", detail: "fixture uncertainty" });
    expect(disconnect).not.toHaveBeenCalled();
  });

  it("reports unsupported raw disconnect rather than fabricating release success", async () => {
    const session = makeAgentSessionStub({ disconnect: undefined });

    await expect(session.release()).resolves.toMatchObject({ status: "unsupported" });
  });

  it("observes disconnect injections installed after the stub is created", async () => {
    const session = makeAgentSessionStub({});
    const error = new Error("late disconnect injection");
    session.disconnect = vi.fn(async () => { throw error; });

    await expect(session.release()).rejects.toBe(error);
    expect(session.disconnect).toHaveBeenCalledOnce();
  });
});
