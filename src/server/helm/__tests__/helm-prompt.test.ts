import { describe, expect, it } from "vitest";
import { buildHelmSystemPrompt, composeHandsFreePrompt, HANDS_FREE_MARKER, SCREEN_DIVIDER } from "../helm-prompt.js";
import { selectHelmModel } from "../helm-session-profile.js";

const context = { timeZone: "America/Los_Angeles", now: new Date("2026-09-18T16:23:00.000Z") };

describe("buildHelmSystemPrompt", () => {
  it("explains both modes, Bridge links and the on-screen divider", () => {
    const prompt = buildHelmSystemPrompt({ timeZone: "America/Los_Angeles", defaultWorkModel: "claude-opus-5" });
    expect(prompt).toContain("You are Helm");
    expect(prompt).toContain(HANDS_FREE_MARKER);
    expect(prompt).toContain("bridge://session/<ref>");
    expect(prompt).toContain(`a line containing only ${SCREEN_DIVIDER}`);
    expect(prompt).toContain("(claude-opus-5)");
    expect(prompt).toContain("Local time zone: America/Los_Angeles.");
    expect(prompt).toContain("hands_free");
  });
});

describe("composeHandsFreePrompt", () => {
  it("frames what the user said but shows only their words", () => {
    expect(composeHandsFreePrompt({ kind: "user", text: "what's new?" }, { ...context, snapshot: "2 unread" })).toEqual({
      prompt: "[hands-free]\n[Bridge now: 2 unread]\nwhat's new?",
      displayPrompt: "what's new?",
      hidden: false,
    });
    expect(composeHandsFreePrompt({ kind: "continuation", text: "and the tasks" }, context)).toEqual({
      prompt: "[hands-free]\n[The user kept talking before you answered; this continues their previous message.]\nand the tasks",
      displayPrompt: "and the tasks",
      hidden: false,
    });
    expect(composeHandsFreePrompt({ kind: "interrupted", text: "stop, read Tellus" }, context).prompt)
      .toBe("[hands-free]\n[The user interrupted you.]\nstop, read Tellus");
  });

  it("keeps greetings and Bridge updates out of the transcript", () => {
    const greeting = composeHandsFreePrompt({ kind: "greeting", text: "" }, { ...context, snapshot: "1 waiting on you" });
    expect(greeting.hidden).toBe(true);
    expect(greeting.displayPrompt).toBeUndefined();
    expect(greeting.prompt).toContain("It's Friday 9:23 AM.");
    expect(greeting.prompt).toContain("[Bridge now: 1 waiting on you]");

    const update = composeHandsFreePrompt({ kind: "event", text: 'Session "Tellus" finished.' }, context);
    expect(update).toEqual({
      prompt: '[hands-free]\n[Bridge update to mention briefly:]\nSession "Tellus" finished.',
      hidden: true,
    });
  });
});

describe("selectHelmModel", () => {
  const models = [
    { id: "claude-opus-5", supportedReasoningEfforts: ["low", "medium", "high"] },
    { id: "gpt-5-mini", supportedReasoningEfforts: ["low", "medium"] },
    { id: "gpt-5.6-luna", supportedReasoningEfforts: ["none", "low"], policy: { state: "disabled" } },
    { id: "gpt-6-luna", supportedReasoningEfforts: ["none", "low"] },
  ] as any;

  it("prefers GPT-6 Luna and starts it at the wanted effort, clamped to what it has", () => {
    expect(selectHelmModel(models, undefined, "max")).toEqual({ model: "gpt-6-luna", reasoningEffort: "low" });
    expect(selectHelmModel(models, undefined, "low")).toEqual({ model: "gpt-6-luna", reasoningEffort: "low" });
    // Without a wanted effort the model keeps its own default.
    expect(selectHelmModel(models)).toEqual({ model: "gpt-6-luna" });
  });

  it("falls back to another fast model when GPT-6 Luna is unavailable or disabled", () => {
    const withoutLunaSix = models.filter((model: { id: string }) => model.id !== "gpt-6-luna");
    const disabledLunaSix = models.map((model: { id: string; policy?: { state: string } }) =>
      model.id === "gpt-6-luna" ? { ...model, policy: { state: "disabled" } } : model,
    );
    expect(selectHelmModel(withoutLunaSix, undefined, "max")).toEqual({ model: "gpt-5-mini", reasoningEffort: "medium" });
    expect(selectHelmModel(disabledLunaSix, undefined, "max")).toEqual({ model: "gpt-5-mini", reasoningEffort: "medium" });
  });

  it("honors a requested model", () => {
    expect(selectHelmModel(models, "claude-opus-5", "max")).toEqual({ model: "claude-opus-5", reasoningEffort: "high" });
    expect(selectHelmModel(models, "claude-opus-5", "high")).toEqual({ model: "claude-opus-5", reasoningEffort: "high" });
    expect(selectHelmModel(models, "claude-opus-5", "none")).toEqual({ model: "claude-opus-5", reasoningEffort: "low" });
  });

  it("falls back sensibly when the catalog is empty or the request is unknown or disabled", () => {
    expect(selectHelmModel([], undefined, "max")).toEqual({});
    expect(selectHelmModel([], "some-model", "max")).toEqual({ model: "some-model" });
    expect(selectHelmModel(models, "gpt-5.6-luna", "max")).toEqual({ model: "gpt-6-luna", reasoningEffort: "low" });
  });
});
