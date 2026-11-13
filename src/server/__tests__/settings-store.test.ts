import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resolve } from "node:path";
import { setupTestDb } from "./helpers.js";
import { createSettingsStore, isImageGenerationEnabled } from "../settings-store.js";
import type { SettingsStore } from "../settings-store.js";
import type { DatabaseSync } from "../db.js";
import { testExecutablePath } from "./test-paths.js";
import {
  DEFAULT_RESPONSE_STYLE_GUIDANCE,
  MAX_RESPONSE_STYLE_GUIDANCE_LENGTH,
  resolveResponseStyle,
} from "../../shared/response-style.js";

let db: DatabaseSync;
let store: SettingsStore;

beforeEach(() => {
  db = setupTestDb();
  store = createSettingsStore(db);
});

function writeRawSettings(value: string): void {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES ('app', ?) ON CONFLICT(key) DO UPDATE SET value = ?",
  ).run(value, value);
}

function readRawSettings(): string {
  return (db.prepare("SELECT value FROM settings WHERE key = 'app'").get() as { value: string }).value;
}

describe("settings-store", () => {
  it("keeps chat mic settings when other settings change, and refuses invalid ones", () => {
    store.updateSettings({ chatMic: { speechModel: "parakeet-unified-en", keepHeldRecordings: true } });
    store.updateSettings({ theme: "dark" });
    expect(createSettingsStore(db).getSettings().chatMic).toEqual({ speechModel: "parakeet-unified-en", keepHeldRecordings: true });

    const before = readRawSettings();
    for (const chatMic of [{ speechModel: "whisper" }, { keepHeldRecordings: "yes" }]) {
      expect(() => store.updateSettings({ chatMic } as never)).toThrow("chatMic.");
    }
    expect(readRawSettings()).toBe(before);
  });
  it("persists response-style settings without changing identity, custom instructions, or other preferences", () => {
    store.updateSettings({ identity: "Bridge", customInstructions: "Prefer TypeScript.", theme: "dark" });
    const responseStyle = { detail: "detailed" as const, guidance: "Use precise terms.\nKeep useful examples." };
    expect(store.updateSettings({ responseStyle }).responseStyle).toEqual(responseStyle);
    expect(createSettingsStore(db).getSettings()).toMatchObject({
      identity: "Bridge", customInstructions: "Prefer TypeScript.", theme: "dark", responseStyle,
    });
  });

  it("normalizes blank guidance and resets explicitly to adaptive defaults", () => {
    expect(store.updateSettings({ responseStyle: { detail: "concise", guidance: " \r\n " } }).responseStyle).toEqual({
      detail: "concise", guidance: DEFAULT_RESPONSE_STYLE_GUIDANCE,
    });
    expect(store.updateSettings({ responseStyle: resolveResponseStyle() }).responseStyle).toEqual(resolveResponseStyle());
    writeRawSettings(JSON.stringify({ responseStyle: {} }));
    expect(store.getSettings().responseStyle).toEqual(resolveResponseStyle());
    writeRawSettings(JSON.stringify({ responseStyle: { detail: "detailed" } }));
    expect(store.getSettings().responseStyle).toEqual({ detail: "detailed", guidance: DEFAULT_RESPONSE_STYLE_GUIDANCE });
  });

  it("accepts exactly the guidance limit and rejects one more character without modifying persisted settings", () => {
    const responseStyle = { detail: "adaptive" as const, guidance: "x".repeat(MAX_RESPONSE_STYLE_GUIDANCE_LENGTH) };
    expect(store.updateSettings({ responseStyle }).responseStyle).toEqual(responseStyle);
    const before = readRawSettings();
    expect(() => store.updateSettings({ responseStyle: { ...responseStyle, guidance: responseStyle.guidance + "x" } }))
      .toThrow(`at most ${MAX_RESPONSE_STYLE_GUIDANCE_LENGTH} characters`);
    expect(readRawSettings()).toBe(before);
  });

  it.each([
    ["a scalar", "natural", "responseStyle must be an object"],
    ["an array", [], "responseStyle must be an object"],
    ["an unknown detail", { detail: "brief" }, "responseStyle.detail must be adaptive, concise, or detailed"],
    ["non-string guidance", { guidance: 123 }, "responseStyle.guidance must be a string"],
    ["an unsupported key", { mood: "friendly" }, 'responseStyle key "mood" is not supported'],
  ] as const)("rejects %s in a JSON-boundary update without changing settings", (_label, responseStyle, message) => {
    store.updateSettings({ theme: "dark" });
    const before = readRawSettings();
    expect(() => Reflect.apply(store.updateSettings, store, [{ responseStyle }])).toThrow(message);
    expect(readRawSettings()).toBe(before);
  });

  it("fails visibly on invalid persisted response-style settings and leaves the row untouched", () => {
    const raw = JSON.stringify({ responseStyle: { detail: "brief" } });
    writeRawSettings(raw);
    expect(() => store.getSettings()).toThrow("Persisted app settings are unreadable");
    expect(readRawSettings()).toBe(raw);
  });

  it("serves MCP servers from the registry and never persists them in the settings row", () => {
    const remoteConfig = {
      type: "http" as const,
      url: "https://mcp.linear.app/mcp",
      headers: { Authorization: "******" },
      tools: ["linear_search"],
    };
    store.getMcpServerStore().createMcpServer({ name: "linear", config: remoteConfig, enabledByDefault: true });

    const updated = store.updateSettings({ theme: "dark" });

    expect(updated.mcpServers).toEqual({ linear: remoteConfig });
    expect(store.getMcpServers()).toEqual({ linear: remoteConfig });
    expect(JSON.parse(readRawSettings())).toEqual({ theme: "dark" });
  });

  it("prepareSettingsUpdate normalizes without persisting", () => {
    store.updateSettings({ theme: "dark" });

    const prepared = store.prepareSettingsUpdate({
      model: " gpt-5.6-sol ",
      modelPresets: {
        preset2: { model: " claude-opus-5 ", reasoningEffort: " high " },
      },
    });

    expect(prepared.current.theme).toBe("dark");
    expect(prepared.next).toMatchObject({
      model: "gpt-5.6-sol",
      modelPresets: {
        preset2: { model: "claude-opus-5", reasoningEffort: "high" },
      },
    });
    expect(store.getSettings().theme).toBe("dark");
    expect(store.getSettings().model).toBeUndefined();
    expect(store.getSettings().modelPresets).toBeUndefined();
  });

  it("updateSettings persists and clears reasoningEffort and model", () => {
    // reasoningEffort
    const updated = store.updateSettings({ reasoningEffort: "high" });
    expect(updated.reasoningEffort).toBe("high");
    expect(store.getSettings().reasoningEffort).toBe("high");
    const cleared = store.updateSettings({ reasoningEffort: undefined });
    expect(cleared.reasoningEffort).toBeUndefined();
    expect(store.getSettings().reasoningEffort).toBeUndefined();

    // model
    const updated2 = store.updateSettings({ model: "gpt-5.4" });
    expect(updated2.model).toBe("gpt-5.4");
    expect(store.getSettings().model).toBe("gpt-5.4");
    const cleared2 = store.updateSettings({ model: undefined });
    expect(cleared2.model).toBeUndefined();
    expect(store.getSettings().model).toBeUndefined();
  });

  it("updateSettings persists and clears browser diagnostics settings", () => {
    const updated = store.updateSettings({
      browser: {
        executablePath: " C:\\Browsers\\chrome.exe ",
        masterProfileDirectory: " C:\\Bridge\\browser-profile ",
        headed: true,
      },
    });

    expect(updated.browser).toEqual({
      executablePath: "C:\\Browsers\\chrome.exe",
      masterProfileDirectory: "C:\\Bridge\\browser-profile",
      headed: true,
    });

    const reloaded = store.getSettings();
    expect(reloaded.browser).toEqual(updated.browser);

    const pathOnly = store.updateSettings({
      browser: {
        executablePath: " C:\\Browsers\\chrome.exe ",
        headed: false,
      },
    });
    expect(pathOnly.browser).toEqual({
      executablePath: "C:\\Browsers\\chrome.exe",
    });

    const headedOnly = store.updateSettings({ browser: { headed: true } });
    expect(headedOnly.browser).toEqual({ headed: true });

    const cleared = store.updateSettings({ browser: {} });
    expect(cleared.browser).toBeUndefined();
    expect(store.getSettings().browser).toBeUndefined();
  });

  it("persists and validates deferred worker model settings", () => {
    expect(store.getSettings().deferWorker).toBeUndefined();

    const updated = store.updateSettings({
      deferWorker: {
        model: " gpt-5-mini ",
        reasoningEffort: " high ",
        contextTier: "long_context",
      },
    });
    expect(updated.deferWorker).toEqual({
      model: "gpt-5-mini",
      reasoningEffort: "high",
      contextTier: "long_context",
    });
    expect(store.getSettings().deferWorker).toEqual(updated.deferWorker);
    expect(() => store.updateSettings({
      deferWorker: { contextTier: "invalid" as any },
    })).toThrow("deferWorker.contextTier must be default or long_context");
  });

  it("stores Helm's names list trimmed, drops an empty one and rejects one that is too long", () => {
    expect(store.updateSettings({ helm: { glossary: "  devbox = Timmy PC  " } }).helm).toEqual({ glossary: "devbox = Timmy PC" });
    expect(store.updateSettings({ helm: { glossary: "   " } }).helm).toBeUndefined();
    expect(() => store.updateSettings({ helm: { glossary: "x".repeat(2_001) } })).toThrow("helm.glossary must be text of at most 2000 characters");
  });

  it("keeps Tether's retired Helm model and effort values as written, and validates them", () => {
    const legacy = { model: "", typedReasoningEffort: "high", spokenReasoningEffort: "low" };
    expect(store.updateSettings({ helm: { voice: "af_heart", legacy } }).helm).toEqual({ voice: "af_heart", legacy });
    expect(store.getSettings().helm?.legacy).toEqual(legacy);
    expect(() => store.updateSettings({ helm: "max" as any })).toThrow("helm must be an object");
    expect(() => store.updateSettings({ helm: { legacy: { typedReasoningEffort: 5 as any } } })).toThrow("helm.legacy.typedReasoningEffort must be text");
  });

  it("rejects non-boolean browser headed settings", () => {
    expect(() => store.updateSettings({
      browser: { headed: "true" } as any,
    })).toThrow("browser.headed must be a boolean");
  });

  it("stores only the image budget fields that differ from the defaults and validates them", () => {
    expect(store.getSettings().imageBudget).toBeUndefined();
    expect(store.updateSettings({ imageBudget: { enabled: true } }).imageBudget).toBeUndefined();
    expect(store.updateSettings({ imageBudget: { enabled: false } }).imageBudget).toEqual({ enabled: false });
    expect(store.updateSettings({ imageBudget: { ceilingsMb: { "claude-*": 25, "gpt-5.4-mini": 40 } } }).imageBudget)
      .toEqual({ ceilingsMb: { "claude-*": 25, "gpt-5.4-mini": 40 } });
    expect(store.updateSettings({ imageBudget: { ceilingsMb: {} } }).imageBudget).toEqual({ ceilingsMb: {} });
    expect(store.updateSettings({ imageBudget: null as any }).imageBudget).toBeUndefined();

    expect(() => store.updateSettings({ imageBudget: { ceilingsMb: { "claude opus": 30 } } }))
      .toThrow("imageBudget.ceilingsMb has an invalid model pattern: claude opus");
    expect(() => store.updateSettings({ imageBudget: { ceilingsMb: { "claude-*": 0 } } }))
      .toThrow("imageBudget.ceilingsMb.claude-* must be a number of MB above 0 and at most 1000");
    expect(() => store.updateSettings({ imageBudget: { enabled: "no" } as any }))
      .toThrow("imageBudget.enabled must be a boolean");
    expect(() => store.updateSettings({ imageBudget: [] as any })).toThrow("imageBudget must be an object");
  });

  it("stores trimmed deploy guards, clears empty ones and validates them", () => {
    const denylistFile = resolve("denylist.txt");
    expect(store.getSettings().deployGuards).toBeUndefined();
    expect(store.updateSettings({
      deployGuards: { blockedEmailPatterns: [" *@corp.example.com "], denylistFile: ` ${denylistFile} ` },
    }).deployGuards).toEqual({ blockedEmailPatterns: ["*@corp.example.com"], denylistFile });
    expect(createSettingsStore(db).getSettings().deployGuards).toEqual({
      blockedEmailPatterns: ["*@corp.example.com"], denylistFile,
    });
    expect(store.updateSettings({ deployGuards: { blockedEmailPatterns: [], denylistFile: "" } }).deployGuards)
      .toBeUndefined();

    for (const [deployGuards, message] of [
      [{ denylistFile: "relative/denylist.txt" }, "deployGuards.denylistFile must be an absolute path"],
      [{ blockedEmailPatterns: ["ok@example.com", " "] }, "entries must be non-empty text of at most 200 characters"],
      [{ blockedEmailPatterns: ["x".repeat(201)] }, "entries must be non-empty text of at most 200 characters"],
      [{ blockedEmailPatterns: Array.from({ length: 21 }, (_, i) => `${i}@example.com`) }, "a list of at most 20 patterns"],
      [{ blockedEmailPatterns: "*@example.com" }, "a list of at most 20 patterns"],
      [{ other: true }, 'deployGuards key "other" is not supported'],
      [[], "deployGuards must be an object"],
    ] as const) {
      expect(() => store.updateSettings({ deployGuards } as any)).toThrow(message);
    }
  });

  it("keeps experimental features off unless set and validates the Fusion context limit", () => {
    expect(store.getSettings().experimental).toBeUndefined();
    expect(store.updateSettings({ experimental: { fusionContextTokens: 600_000 } }).experimental)
      .toEqual({ fusionContextTokens: 600_000 });
    expect(store.updateSettings({ experimental: {} }).experimental).toBeUndefined();
    for (const fusionContextTokens of [100_000, 1_200_000, 300_000.5, "600000"]) {
      expect(() => store.updateSettings({ experimental: { fusionContextTokens } as any }))
        .toThrow("experimental.fusionContextTokens must be a whole number from 128000 to 1000000");
    }
    expect(() => store.updateSettings({ experimental: [] as any })).toThrow("experimental must be an object");
  });

  it("keeps computer use off unless it is explicitly enabled", () => {
    expect(store.getSettings().computerUse).toBeUndefined();

    expect(store.updateSettings({ computerUse: { enabled: true } }).computerUse).toEqual({ enabled: true });
    expect(store.getSettings().computerUse).toEqual({ enabled: true });
    expect(store.updateSettings({ identity: "unrelated" }).computerUse).toEqual({ enabled: true });

    expect(store.updateSettings({ computerUse: { enabled: false } }).computerUse).toBeUndefined();
    store.updateSettings({ computerUse: { enabled: true } });
    expect(store.updateSettings({ computerUse: {} }).computerUse).toBeUndefined();
    expect(store.getSettings().computerUse).toBeUndefined();

    expect(() => store.updateSettings({
      computerUse: { enabled: "true" } as any,
    })).toThrow("computerUse.enabled must be a boolean");
    expect(() => store.updateSettings({
      computerUse: "on" as any,
    })).toThrow("computerUse must be an object");
  });

  it("keeps image generation on unless it is explicitly turned off", () => {
    expect(isImageGenerationEnabled(store.getSettings())).toBe(true);

    expect(store.updateSettings({ imageGeneration: { enabled: false } }).imageGeneration).toEqual({ enabled: false });
    expect(store.updateSettings({ identity: "unrelated" }).imageGeneration).toEqual({ enabled: false });
    expect(isImageGenerationEnabled(store.getSettings())).toBe(false);

    for (const on of [{ enabled: true }, {}, null]) {
      store.updateSettings({ imageGeneration: { enabled: false } });
      expect(store.updateSettings({ imageGeneration: on as any }).imageGeneration).toBeUndefined();
      expect(isImageGenerationEnabled(store.getSettings())).toBe(true);
    }

    expect(() => store.updateSettings({
      imageGeneration: { enabled: "false" } as any,
    })).toThrow("imageGeneration.enabled must be a boolean");
  });

  it("persists and validates remembered model presets", () => {
    const updated = store.updateSettings({
      modelPresets: {
        preset1: { model: "gpt-5.6-sol", reasoningEffort: "high" },
        preset2: { model: "claude-opus-5", contextTier: "long_context" },
      },
      lastModelPreset: "preset2",
    });
    expect(updated.modelPresets).toEqual({
      preset1: { model: "gpt-5.6-sol", reasoningEffort: "high" },
      preset2: { model: "claude-opus-5", contextTier: "long_context" },
    });
    expect(store.getSettings().lastModelPreset).toBe("preset2");

    expect(() => store.updateSettings({
      modelPresets: { preset4: { model: "gemini-3.1-pro" } } as any,
    })).toThrow('modelPresets key "preset4" is not a known preset slot');
    expect(() => store.updateSettings({
      lastModelPreset: "preset4" as any,
    })).toThrow("lastModelPreset must be preset1, preset2, or preset3");
  });

  it("migrates remembered model-family defaults into preset slots", () => {
    const updated = store.updateSettings({
      familyDefaults: {
        gpt: { model: "gpt-5.6-sol", reasoningEffort: "high" },
        claude: { model: "claude-opus-5", contextTier: "long_context" },
      },
      lastModelFamily: "claude",
    });

    expect(updated.modelPresets).toEqual({
      preset1: { model: "gpt-5.6-sol", reasoningEffort: "high" },
      preset2: { model: "claude-opus-5", contextTier: "long_context" },
    });
    expect(updated.lastModelPreset).toBe("preset2");
    expect(updated.familyDefaults).toBeUndefined();
    expect(updated.lastModelFamily).toBeUndefined();
  });

  it.each([
    ["malformed JSON", "{"],
    ["null", "null"],
    ["an array", "[]"],
  ])("fails visibly when the persisted row contains %s", (_label, raw) => {
    writeRawSettings(raw);

    expect(() => store.getSettings()).toThrow("Persisted app settings are unreadable");
    expect(readRawSettings()).toBe(raw);
  });

  it.each([
    ["browser settings", { browser: { headed: "true" } }],
    ["model preset settings", { modelPresets: { preset1: { model: "gpt-5.6-sol", contextTier: "invalid" } } }],
    ["defer worker settings", { deferWorker: { contextTier: "invalid" } }],
  ])("rejects invalid nested persisted %s", (_label, raw) => {
    writeRawSettings(JSON.stringify(raw));

    expect(() => store.getSettings()).toThrow("Persisted app settings are unreadable");
  });

  it("hydrates and normalizes valid legacy app settings", () => {
    const executablePath = testExecutablePath("chromium");
    writeRawSettings(JSON.stringify({
      providers: { github: { owner: "octo", defaultRepo: "bridge" } },
      theme: "dark",
      identity: "Bridge operator",
      model: " gpt-5.6-sol ",
      reasoningEffort: " high ",
      contextTier: "long_context",
      familyDefaults: {
        gpt: { model: " gpt-5.6-sol ", reasoningEffort: " high " },
      },
      browser: {
        executablePath: ` ${executablePath} `,
        headed: true,
      },
      mcpServers: {
        legacy: { command: "legacy", args: [] },
      },
      obsoleteSetting: true,
    }));

    expect(store.getSettings()).toEqual({
      providers: { github: { owner: "octo", defaultRepo: "bridge" } },
      mcpServers: {},
      theme: "dark",
      identity: "Bridge operator",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      contextTier: "long_context",
      modelPresets: {
        preset1: { model: "gpt-5.6-sol", reasoningEffort: "high" },
      },
      browser: {
        executablePath,
        headed: true,
      },
    });
  });

  it("stores and clears the reduced-motion override and rejects unknown values", () => {
    store.updateSettings({ motion: "reduce" });
    expect(store.getSettings().motion).toBe("reduce");
    store.updateSettings({ motion: "full" });
    expect(store.getSettings().motion).toBe("full");
    expect(() => store.updateSettings({ motion: "slow" } as never)).toThrow("motion must be system, reduce, or full");
    expect(store.getSettings().motion).toBe("full");
    store.updateSettings({ motion: "" } as never);
    expect(store.getSettings().motion).toBeUndefined();
  });

  it("does not overwrite an unreadable row when a later update is attempted", () => {
    const raw = "{broken";
    writeRawSettings(raw);

    expect(() => store.updateSettings({ theme: "light" }))
      .toThrow("Persisted app settings are unreadable");
    expect(readRawSettings()).toBe(raw);
  });

});

describe("settings-store model A/B test", () => {
  const TIERS = { preset2: { model: "model-standard" }, preset3: { model: "model-deep", reasoningEffort: "high" } };
  const ON = { enabled: true, a: "preset2", b: "preset3" } as const;
  afterEach(() => vi.useRealTimers());

  it("starts a test when it is turned on or what an arm runs changes, and keeps its start when turned off", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-02T09:00:00.000Z"));
    store.updateSettings({ modelPresets: TIERS });
    // The server owns the start time, whatever a client sends.
    expect(store.updateSettings({ modelAbTest: { ...ON, startedAt: "2020-01-01T00:00:00.000Z" } }).modelAbTest)
      .toEqual({ ...ON, startedAt: "2026-03-02T09:00:00.000Z" });

    vi.setSystemTime(new Date("2026-03-02T10:00:00.000Z"));
    store.updateSettings({ theme: "dark" });
    expect(store.updateSettings({ modelAbTest: ON }).modelAbTest?.startedAt).toBe("2026-03-02T09:00:00.000Z");
    expect(store.updateSettings({ modelPresets: { ...TIERS, preset3: { model: "model-deep", reasoningEffort: "low" } } }).modelAbTest?.startedAt)
      .toBe("2026-03-02T10:00:00.000Z");

    vi.setSystemTime(new Date("2026-03-02T11:00:00.000Z"));
    expect(store.updateSettings({ modelAbTest: { ...ON, enabled: false } }).modelAbTest)
      .toEqual({ ...ON, enabled: false, startedAt: "2026-03-02T10:00:00.000Z" });
  });

  it("refuses a test on a tier without a model, and ends one whose tier loses its model", () => {
    store.updateSettings({ modelPresets: { preset2: TIERS.preset2 } });
    expect(() => store.updateSettings({ modelAbTest: ON })).toThrow("The Deep tier has no model yet");
    expect(() => store.updateSettings({ modelAbTest: { ...ON, b: "preset2" } })).toThrow("must be different tiers");

    store.updateSettings({ modelPresets: TIERS, modelAbTest: ON });
    expect(store.updateSettings({ modelPresets: { preset2: TIERS.preset2 } }).modelAbTest).toMatchObject({ enabled: false });
  });
});
