import { describe, expect, it, vi } from "vitest";
import { makeAgentSessionStub } from "./helpers.js";

describe("agent session stub release contract", () => {
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
    expect(session.release()).toBe(release);
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

  it("reports unsupported raw disconnect rather than fabricating release success", async () => {
    const session = makeAgentSessionStub({ disconnect: undefined });

    await expect(session.release()).resolves.toMatchObject({ status: "unsupported" });
  });
});
