import { describe, expect, it } from "vitest";
import { setupTestDb } from "./helpers.js";
import { createSettingsStore } from "../settings-store.js";
import { resolveModelRole } from "../model-roles.js";
import { subagentDefaultsFor, resolveSubagentSettings } from "../../shared/subagent-settings.js";

const PRESETS = {
  preset1: { model: "gpt-6-luna", reasoningEffort: "max", contextTier: "long_context" as const },
  preset2: { model: "gpt-6.1-sol", reasoningEffort: "max", contextTier: "long_context" as const },
  preset3: { model: "claude-opus-5.5", reasoningEffort: "high", contextTier: "long_context" as const },
};

function storeWith(settings: Record<string, unknown>) {
  const db = setupTestDb();
  db.prepare("INSERT INTO settings (key, value) VALUES ('app', ?)").run(JSON.stringify(settings));
  return createSettingsStore(db);
}

const MODELS = [
  { id: "gpt-6-luna", supportedReasoningEfforts: ["none", "low", "high", "max"] },
  { id: "gpt-6.1-sol", supportedReasoningEfforts: ["low", "high", "xhigh", "max"] },
  { id: "claude-opus-5.5", supportedReasoningEfforts: ["low", "high", "max"] },
  { id: "old-model", policy: { state: "disabled" } },
];

describe("model roles in settings", () => {
  it("infers roles from settings made before roles only where they already equal a tier", () => {
    // Tim's real settings on 25 Oct 2026: default sol/xhigh (no tier matches), deferred worker = Fast.
    const store = storeWith({
      model: "gpt-6.1-sol", reasoningEffort: "xhigh", contextTier: "long_context",
      modelPresets: PRESETS, deferWorker: { model: "gpt-6-luna", reasoningEffort: "max", contextTier: "long_context" },
    });
    const settings = store.getSettings();
    expect(settings.modelRoles).toEqual({ background: { tier: "preset1" } });
    expect(settings.model).toBe("gpt-6.1-sol");
    expect(settings.reasoningEffort).toBe("xhigh");
  });

  it("writes a tier into the older fields, and follows the tier when it is edited", () => {
    const store = storeWith({ model: "gpt-6.1-sol", reasoningEffort: "xhigh", modelPresets: PRESETS });
    store.updateSettings({ modelRoles: { chat: { tier: "preset2" }, background: { tier: "preset1" }, helm: { tier: "preset1" } } });
    let settings = store.getSettings();
    expect(settings).toMatchObject({ model: "gpt-6.1-sol", reasoningEffort: "max", contextTier: "long_context" });
    expect(settings.deferWorker).toEqual(PRESETS.preset1);
    expect(settings.helm?.model).toBe("gpt-6-luna");

    store.updateSettings({ modelPresets: { ...PRESETS, preset2: { model: "claude-opus-5.5", reasoningEffort: "high" } } });
    settings = store.getSettings();
    expect(settings).toMatchObject({ model: "claude-opus-5.5", reasoningEffort: "high" });
    expect(settings.contextTier).toBeUndefined();
  });

  it("a direct change of an older field makes that role follow the field, keeping the rest", () => {
    const store = storeWith({ modelPresets: PRESETS, modelRoles: { chat: { tier: "preset2" }, background: { tier: "preset1" } } });
    store.updateSettings({ reasoningEffort: "low" });
    const settings = store.getSettings();
    expect(settings.modelRoles).toEqual({ background: { tier: "preset1" } });
    expect(settings).toMatchObject({ model: "gpt-6.1-sol", reasoningEffort: "low", contextTier: "long_context" });
  });

  it("an unchanged older field sent back, or a role set in the same write, leaves the role on its tier", () => {
    const store = storeWith({ modelPresets: PRESETS, modelRoles: { chat: { tier: "preset2" } } });
    const current = store.getSettings();
    store.updateSettings({ model: current.model, reasoningEffort: current.reasoningEffort });
    expect(store.getSettings().modelRoles?.chat).toEqual({ tier: "preset2" });
    store.updateSettings({ model: "gpt-6-luna", modelRoles: { chat: { tier: "preset3" } } });
    expect(store.getSettings()).toMatchObject({ model: "claude-opus-5.5", modelRoles: { chat: { tier: "preset3" } } });
  });

  it("refuses a model of its own for roles that keep it in their older field, and unknown roles", () => {
    const store = storeWith({ modelPresets: PRESETS });
    expect(() => store.updateSettings({ modelRoles: { chat: { model: "x" } } } as never)).toThrow(/takes a tier/);
    expect(() => store.updateSettings({ modelRoles: { nope: { tier: "preset1" } } } as never)).toThrow(/not a known role/);
    expect(() => store.updateSettings({ modelRoles: { helm: { model: "x" } } } as never)).toThrow(/takes a tier/);
    // Helm's own look at all Bridges was once a role of its own; it is Helm now.
    expect(() => store.updateSettings({ modelRoles: { thinker: { tier: "preset3" } } } as never)).toThrow(/not a known role/);
    expect(() => store.updateSettings({ modelRoles: { subagents: { tier: "preset9" } } } as never)).toThrow(/preset1/);
    store.updateSettings({ modelRoles: { subagents: { model: "gpt-6.1-sol", reasoningEffort: "xhigh" } } });
    expect(store.getSettings().modelRoles?.subagents).toEqual({ model: "gpt-6.1-sol", reasoningEffort: "xhigh" });
  });
});

describe("model roles when a tier or model goes away", () => {
  it("a role on a tier that loses its model keeps what it last ran on", () => {
    const store = storeWith({ model: "gpt-6.1-sol", modelPresets: PRESETS, modelRoles: { chat: { tier: "preset2" }, helm: { tier: "preset3" } } });
    const { preset1 } = PRESETS;
    const updated = store.updateSettings({ modelPresets: { preset1 } });
    expect(updated.modelRoles).toEqual({});
    expect(updated.model).toBe("gpt-6.1-sol");
    expect(updated.helm?.model).toBe("claude-opus-5.5");
  });

  it("says honestly that work on an older setting may fail when its tier's model is unavailable", () => {
    const settings = { modelPresets: PRESETS, modelRoles: { chat: { tier: "preset2" as const }, helm: { tier: "preset2" as const } } };
    const models = MODELS.filter((model) => model.id !== "gpt-6.1-sol");
    expect(resolveModelRole(settings, "chat", models)).toMatchObject({ source: "tier", model: "gpt-6.1-sol", warning: expect.stringMatching(/may fail/) });
    // Helm checks its model when it starts, so it falls back to Automatic instead.
    expect(resolveModelRole(settings, "helm", models)).toMatchObject({ source: "automatic", warning: expect.stringMatching(/uses Automatic/) });
  });
});

describe("resolveModelRole", () => {
  const settings = { modelPresets: PRESETS, modelRoles: { helm: { tier: "preset3" as const }, helper: { tier: "preset1" as const }, subagents: { model: "old-model" } } };

  it("resolves a tier with an effort the model supports, and small jobs at the lowest effort", () => {
    expect(resolveModelRole(settings, "helm", MODELS)).toEqual({ role: "helm", source: "tier", tier: "preset3", model: "claude-opus-5.5", reasoningEffort: "high", contextTier: "long_context" });
    expect(resolveModelRole(settings, "helper", MODELS)).toMatchObject({ model: "gpt-6-luna", reasoningEffort: "none" });
  });

  it("falls back to Automatic, with a warning, when the model can't be used or the tier is empty", () => {
    expect(resolveModelRole(settings, "subagents", MODELS)).toMatchObject({ source: "automatic", warning: expect.stringMatching(/isn't available/) });
    expect(resolveModelRole({ modelRoles: { helm: { tier: "preset2" } } }, "helm", MODELS)).toMatchObject({ source: "automatic", warning: expect.stringMatching(/no model yet/) });
    expect(resolveModelRole(settings, "background", MODELS)).toEqual({ role: "background", source: "automatic" });
  });

  it("gives task, explore and research the Sub-agents role's model, leaving per-agent choices and other agents alone", () => {
    const defaults = subagentDefaultsFor(resolveModelRole({ modelPresets: PRESETS, modelRoles: { subagents: { tier: "preset2" } } }, "subagents", MODELS));
    const resolved = resolveSubagentSettings({ agents: { explore: { model: "gpt-6-luna" } } }, MODELS as never, defaults);
    expect(resolved?.agents.task).toEqual({ model: "gpt-6.1-sol", effortLevel: "max" });
    expect(resolved?.agents.explore).toEqual({ model: "gpt-6-luna" });
    expect(resolved?.agents["rubber-duck"]).toBeUndefined();
    expect(subagentDefaultsFor(undefined).task).toEqual({ model: "gpt-6-luna", effortLevel: "max" });
  });
});
