import { describe, expect, it } from "vitest";
import { setupTestDb } from "./helpers.js";
import { createSettingsStore } from "../settings-store.js";
import { resolveModelRole } from "../model-roles.js";
import { buildSubagentPlan, subagentSettingsForModel } from "../../shared/subagent-settings.js";

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
    store.updateSettings({ modelRoles: { chat: { tier: "preset2" }, background: { tier: "preset1" } } });
    let settings = store.getSettings();
    expect(settings).toMatchObject({ model: "gpt-6.1-sol", reasoningEffort: "max", contextTier: "long_context" });
    expect(settings.deferWorker).toEqual(PRESETS.preset1);

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
    expect(() => store.updateSettings({ modelRoles: { reviewers: { model: "x" } } } as never)).toThrow(/takes a tier/);
    // Helm's own look at all Bridges was once a role of its own; it is Helm now.
    expect(() => store.updateSettings({ modelRoles: { thinker: { tier: "preset3" } } } as never)).toThrow(/not a known role/);
    expect(() => store.updateSettings({ modelRoles: { subagents: { tier: "preset9" } } } as never)).toThrow(/preset1/);
    store.updateSettings({ modelRoles: { subagents: { model: "gpt-6.1-sol", reasoningEffort: "xhigh" }, helm: { model: "claude-opus-5.5", reasoningEffort: "high" } } });
    expect(store.getSettings().modelRoles).toEqual({
      subagents: { model: "gpt-6.1-sol", reasoningEffort: "xhigh" },
      helm: { model: "claude-opus-5.5", reasoningEffort: "high" },
    });
  });
});

describe("Helm's model from before it was a role of its own", () => {
  it("becomes a custom Helm role with the typed effort, and the efforts are kept only for Tether", () => {
    const store = storeWith({ model: "gpt-6-luna", helm: { model: "gpt-6.1-sol", typedReasoningEffort: "max", spokenReasoningEffort: "none", voice: "af_heart" } });
    const settings = store.getSettings();
    expect(settings.modelRoles).toEqual({ helm: { model: "gpt-6.1-sol", reasoningEffort: "max" } });
    expect(settings.helm).toEqual({ voice: "af_heart", legacy: { typedReasoningEffort: "max", spokenReasoningEffort: "none" } });
    // Choosing Automatic later sticks: nothing brings the old model back.
    store.updateSettings({ modelRoles: {}, helm: settings.helm });
    expect(store.getSettings().modelRoles).toEqual({});
  });

  it("leaves a Helm role that is already set alone", () => {
    const store = storeWith({ modelPresets: PRESETS, modelRoles: { helm: { tier: "preset3" } }, helm: { model: "claude-opus-5.5" } });
    expect(store.getSettings().modelRoles).toEqual({ helm: { tier: "preset3" } });
    expect(store.getSettings().helm).toBeUndefined();
  });
});

describe("model roles when a tier or model goes away", () => {
  it("a role on a tier that loses its model keeps what it last ran on", () => {
    const store = storeWith({ model: "gpt-6.1-sol", modelPresets: PRESETS, modelRoles: { chat: { tier: "preset2" }, helm: { tier: "preset3" } } });
    const { preset1 } = PRESETS;
    const updated = store.updateSettings({ modelPresets: { preset1 } });
    expect(updated.modelRoles).toEqual({});
    expect(updated.model).toBe("gpt-6.1-sol");
  });

  it("says honestly that work on an older setting may fail when its tier's model is unavailable", () => {
    const settings = { modelPresets: PRESETS, modelRoles: { chat: { tier: "preset2" as const }, helm: { tier: "preset2" as const } } };
    const models = MODELS.filter((model) => model.id !== "gpt-6.1-sol");
    expect(resolveModelRole(settings, "chat", models)).toMatchObject({ source: "tier", model: "gpt-6.1-sol", warning: expect.stringMatching(/may fail/) });
    // Helm checks its model when it starts, so it falls back to Automatic instead.
    expect(resolveModelRole(settings, "helm", models)).toMatchObject({ source: "automatic", warning: "gpt-6.1-sol isn't available, so this uses your default chat model, or the strongest when that's a router." });
  });
});

describe("resolveModelRole", () => {
  const settings = { modelPresets: PRESETS, modelRoles: { helm: { tier: "preset3" as const }, helper: { tier: "preset1" as const }, handsFree: { tier: "preset1" as const }, subagents: { model: "old-model" } } };

  it("resolves a tier with an effort the model supports, small jobs at the lowest effort and hands-free at low", () => {
    expect(resolveModelRole(settings, "helm", MODELS)).toEqual({ role: "helm", source: "tier", tier: "preset3", model: "claude-opus-5.5", reasoningEffort: "high", contextTier: "long_context" });
    expect(resolveModelRole(settings, "helper", MODELS)).toMatchObject({ model: "gpt-6-luna", reasoningEffort: "none" });
    // The tier says max; hands-free has to answer in about a second.
    expect(resolveModelRole(settings, "handsFree", MODELS)).toMatchObject({ model: "gpt-6-luna", reasoningEffort: "low" });
  });

  it("falls back to Automatic, with a warning, when the model can't be used or the tier is empty", () => {
    expect(resolveModelRole(settings, "subagents", MODELS)).toMatchObject({ source: "automatic", warning: expect.stringMatching(/isn't available/) });
    expect(resolveModelRole({ modelRoles: { helm: { tier: "preset2" } } }, "helm", MODELS)).toMatchObject({ source: "automatic", warning: expect.stringMatching(/no model yet/) });
    expect(resolveModelRole(settings, "background", MODELS)).toEqual({ role: "background", source: "automatic" });
  });

  it("runs a role nobody set on its default tier, and says what it uses while that tier is empty", () => {
    expect(resolveModelRole({ modelPresets: PRESETS }, "helm", MODELS)).toMatchObject({ source: "tier", tier: "preset3", isDefault: true, model: "claude-opus-5.5" });
    expect(resolveModelRole({ modelPresets: PRESETS }, "subagents", MODELS)).toMatchObject({ tier: "preset1", isDefault: true, model: "gpt-6-luna" });
    expect(resolveModelRole({}, "handsFree", MODELS)).toMatchObject({ source: "automatic", isDefault: true, warning: "The Fast tier has no model yet, so this uses the Small jobs model." });
    // Reviewers stay on the chat's own model, and the field-backed roles on their older setting.
    expect(resolveModelRole({ modelPresets: PRESETS }, "reviewers", MODELS)).toEqual({ role: "reviewers", source: "automatic" });
    expect(resolveModelRole({ modelPresets: PRESETS }, "chat", MODELS)).toEqual({ role: "chat", source: "automatic" });
  });
});

describe("sub-agent plan", () => {
  const TIERS = [PRESETS.preset3, PRESETS.preset2, PRESETS.preset1];
  const plan = (modelRoles: Record<string, unknown>) => {
    const settings = { modelPresets: PRESETS, modelRoles } as never;
    return buildSubagentPlan({
      helpers: resolveModelRole(settings, "subagents", MODELS),
      reviewers: resolveModelRole(settings, "reviewers", MODELS),
      tiers: TIERS,
    }, MODELS);
  };

  it("runs helpers and reviewers on their roles, or on the built-in helper default and the chat's model", () => {
    const automatic = plan({}).agents;
    expect(automatic.task).toEqual({ model: "gpt-6-luna", effortLevel: "max" });
    expect(automatic.research).toEqual(automatic.task);
    expect(automatic["code-review"]).toEqual({ model: "inherit" });
    expect(automatic["general-purpose"]).toEqual({ model: "inherit" });
    const tiered = plan({ subagents: { tier: "preset2" }, reviewers: { tier: "preset3" } }).agents;
    expect(tiered.explore).toEqual({ model: "gpt-6.1-sol", effortLevel: "max" });
    expect(tiered["security-review"]).toEqual({ model: "claude-opus-5.5", effortLevel: "high" });
  });

  it.each([
    ["claude-opus-5.5", { model: "gpt-6.1-sol", effortLevel: "max" }],
    ["gpt-6-luna", { model: "claude-opus-5.5", effortLevel: "high" }],
    // A router's family is unknown, so Copilot picks the critic itself.
    ["auto", undefined],
    [undefined, undefined],
  ])("gives rubber-duck in a %s chat the strongest tier from the other family", (chat, expected) => {
    expect(subagentSettingsForModel(plan({}), chat).agents["rubber-duck"]).toEqual(expected);
  });

  it("leaves rubber-duck to Copilot when every tier is from the chat's family", () => {
    const gptOnly = buildSubagentPlan({ tiers: [PRESETS.preset2, PRESETS.preset1] }, MODELS);
    expect(subagentSettingsForModel(gptOnly, "gpt-6.1-sol").agents).not.toHaveProperty("rubber-duck");
    expect(subagentSettingsForModel(gptOnly, "claude-opus-5.5").agents["rubber-duck"]).toEqual({ model: "gpt-6.1-sol", effortLevel: "max" });
  });
});

