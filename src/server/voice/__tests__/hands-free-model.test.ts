import { describe, expect, it, vi } from "vitest";
import {
  chooseHandsFreeModel,
  formatRouteMessage,
  HANDS_FREE_SYSTEM_PROMPT,
  HandsFreeModel,
  parseRouteDecision,
} from "../hands-free-model.js";

const priced = (inputPrice: number, outputPrice: number) => ({ tokenPrices: { inputPrice, outputPrice, cachePrice: 0, batchSize: 1_000_000 } });
const MODELS = [
  { id: "claude-opus-5", billing: priced(500, 2500), supportedReasoningEfforts: ["low", "medium", "high"] },
  { id: "gpt-6.1-terra", billing: priced(100, 500), supportedReasoningEfforts: ["low", "medium", "high", "max"] },
  { id: "gpt-6-luna", billing: priced(10, 50), supportedReasoningEfforts: ["none", "low", "high"] },
  { id: "gpt-5.6-luna", billing: priced(1, 1), supportedReasoningEfforts: ["none", "low"], policy: { state: "disabled" } },
] as any;
const PRESETS = { preset1: { model: "gpt-6.1-terra", reasoningEffort: "high" } };

describe("parseRouteDecision", () => {
  it.each([
    ['{"action":"send","text":"Check the Tether task."}', { action: "send", text: "Check the Tether task." }],
    ['Sure: {"action":"progress","text":"ignored"}', { action: "progress", text: "" }],
    ['```json\n{"action":"ignore","text":""}\n```', { action: "ignore", text: "" }],
    ['{"action":"send","text":"  "}', undefined],
    ['{"action":"dance","text":""}', undefined],
    ["SILENT", undefined],
  ])("reads %j", (content, expected) => {
    expect(parseRouteDecision(content)).toEqual(expected);
  });
});

describe("chooseHandsFreeModel", () => {
  it("runs on its role at low whatever the tier says, or at the effort its own model names", () => {
    expect(chooseHandsFreeModel({ modelPresets: PRESETS, modelRoles: { handsFree: { tier: "preset1" } } } as any, MODELS))
      .toEqual({ model: "gpt-6.1-terra", reasoningEffort: "low" });
    expect(chooseHandsFreeModel({ modelRoles: { handsFree: { model: "claude-opus-5", reasoningEffort: "medium" } } } as any, MODELS))
      .toEqual({ model: "claude-opus-5", reasoningEffort: "medium" });
  });

  it("is Automatic without a role: the Small jobs model, else the cheapest usable model", () => {
    expect(chooseHandsFreeModel({ modelPresets: PRESETS, modelRoles: { helper: { tier: "preset1" } } } as any, MODELS))
      .toEqual({ model: "gpt-6.1-terra", reasoningEffort: "low" });
    // The cheapest one is disabled by policy, so the next one is used.
    expect(chooseHandsFreeModel({} as any, MODELS)).toEqual({ model: "gpt-6-luna", reasoningEffort: "low" });
    expect(chooseHandsFreeModel({} as any, [])).toEqual({});
  });
});

describe("HandsFreeModel", () => {
  function harness(reply: () => Promise<unknown>) {
    const dispose = vi.fn(async () => undefined);
    const abort = vi.fn(async () => undefined);
    const sendAndWait = vi.fn((_input: { prompt: string; attachments: unknown[] }, _timeoutMs?: number) => reply());
    const createHelperSession = vi.fn(async () => ({ session: { sendAndWait, abort } as any, dispose }));
    const model = new HandsFreeModel({ listModels: async () => MODELS, getSettings: () => ({}) as any, createHelperSession });
    return { model, createHelperSession, sendAndWait, dispose, abort };
  }

  it("asks a fresh helper session for each decision and disposes of it", async () => {
    const { model, createHelperSession, sendAndWait, dispose } = harness(async () => ({ data: { content: '{"action":"send","text":"Check the Tether task."}' } }));
    const context = { state: "working" as const, workingSeconds: 45, glossary: "Tether = my iPhone app", transcript: "check the tether task" };
    await expect(model.route(context)).resolves.toEqual({ action: "send", text: "Check the Tether task." });
    await model.route(context);
    expect(createHelperSession).toHaveBeenCalledTimes(2);
    expect(createHelperSession).toHaveBeenCalledWith(expect.objectContaining({
      model: "gpt-6-luna", reasoningEffort: "low", systemMessage: { mode: "replace", content: HANDS_FREE_SYSTEM_PROMPT },
    }));
    expect(sendAndWait.mock.calls[0]![0]).toEqual({ prompt: formatRouteMessage(context), attachments: [] });
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(2));
  });

  it("answers nothing when the call fails, so the layer falls back", async () => {
    const { model, abort, dispose } = harness(async () => { throw new Error("timeout"); });
    await expect(model.speak("A long reply.")).resolves.toBeUndefined();
    expect(abort).toHaveBeenCalled();
    await vi.waitFor(() => expect(dispose).toHaveBeenCalled());
  });
});
