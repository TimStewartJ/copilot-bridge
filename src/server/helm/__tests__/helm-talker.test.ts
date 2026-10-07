import { describe, expect, it, vi } from "vitest";
import { HelmTalker, parseLeadIn } from "../helm-talker.js";

describe("parseLeadIn", () => {
  it("keeps a short lead-in and drops silence, labels and markdown", () => {
    expect(parseLeadIn("Let me check the car task.")).toBe("Let me check the car task.");
    expect(parseLeadIn("BRIDGE: **Checking** the Tether task.")).toBe("Checking the Tether task.");
    expect(parseLeadIn("SILENT")).toBeUndefined();
    expect(parseLeadIn("x".repeat(120))).toBeUndefined();
    expect(parseLeadIn(undefined)).toBeUndefined();
  });
});

describe("HelmTalker", () => {
  const models = [{
    id: "gpt-6-luna",
    billing: { tokenPrices: { inputPrice: 10, outputPrice: 50, cachePrice: 1, batchSize: 1_000_000 } },
    supportedReasoningEfforts: ["none", "low", "medium"],
  }] as never;

  it("opens one low-effort helper session, reuses it, and disposes it on close", async () => {
    const session = { sendAndWait: vi.fn(async (_args: unknown, _timeout?: number) => ({ data: { content: "Let me look." } })), abort: vi.fn(async () => undefined) };
    const dispose = vi.fn(async () => undefined);
    const createHelperSession = vi.fn(async (_config: Record<string, unknown>) => ({ session, dispose }) as never);
    const talker = new HelmTalker({ listModels: async () => models, createHelperSession });
    expect(await talker.leadIn("what's new in the car task?", "Hi.")).toBe("Let me look.");
    expect(await talker.leadIn("and the Tether task?")).toBe("Let me look.");
    expect(createHelperSession).toHaveBeenCalledTimes(1);
    expect(createHelperSession.mock.calls[0]![0]).toMatchObject({ model: "gpt-6-luna", reasoningEffort: "low" });
    expect(session.sendAndWait.mock.calls[0]![0]).toEqual({ prompt: "Helm last said: Hi.\nUser: what's new in the car task?", attachments: [] });
    await talker.close();
    expect(dispose).toHaveBeenCalled();
  });

  it("sends one throwaway request when warmed, and a turn that arrives meanwhile waits for it", async () => {
    let finishWarmUp!: () => void;
    const order: string[] = [];
    const session = {
      sendAndWait: vi.fn(async (args: { prompt: string }, _timeout?: number) => {
        order.push(`sent ${args.prompt}`);
        if (args.prompt === "User: hello") await new Promise<void>((resolve) => { finishWarmUp = resolve; });
        order.push(`answered ${args.prompt}`);
        return { data: { content: args.prompt === "User: hello" ? "SILENT" : "Let me look." } };
      }),
      abort: vi.fn(async () => undefined),
    };
    const createHelperSession = vi.fn(async () => ({ session, dispose: async () => undefined }) as never);
    const log = vi.fn();
    const talker = new HelmTalker({ listModels: async () => models, createHelperSession, logger: { log, warn: vi.fn() } });
    talker.warm();
    talker.warm();
    const leadIn = talker.leadIn("what's new in the car task?");
    await vi.waitFor(() => expect(order).toEqual(["sent User: hello"]));
    finishWarmUp();
    expect(await leadIn).toBe("Let me look.");
    expect(order).toEqual(["sent User: hello", "answered User: hello", "sent User: what's new in the car task?", "answered User: what's new in the car task?"]);
    expect(createHelperSession).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^\[helm-talker\] Warm in \d+ms$/));
  });

  it("still writes lead-ins when the warm-up request fails", async () => {
    const session = {
      sendAndWait: vi.fn(async (args: { prompt: string }) => {
        if (args.prompt === "User: hello") throw new Error("Timeout");
        return { data: { content: "Let me look." } };
      }),
      abort: vi.fn(async () => undefined),
    };
    const talker = new HelmTalker({ listModels: async () => models, createHelperSession: async () => ({ session, dispose: async () => undefined }) as never });
    talker.warm();
    expect(await talker.leadIn("anything new?")).toBe("Let me look.");
    expect(session.abort).toHaveBeenCalledTimes(1);
  });

  it("says nothing when the helper fails or is slow", async () => {
    const session = { sendAndWait: vi.fn(async () => { throw new Error("Timeout"); }), abort: vi.fn(async () => undefined) };
    const talker = new HelmTalker({ listModels: async () => models, createHelperSession: async () => ({ session, dispose: async () => undefined }) as never });
    expect(await talker.leadIn("anything new?")).toBeUndefined();
    expect(session.abort).toHaveBeenCalled();
    const unavailable = new HelmTalker({ listModels: async () => { throw new Error("offline"); }, createHelperSession: vi.fn() as never });
    expect(await unavailable.leadIn("anything new?")).toBeUndefined();
  });
});
