import { describe, expect, it } from "vitest";
import { serializeSettingsPatch, type AppSettings } from "../api";
import { getSettingsDraftUpdates } from "./settings-draft";

describe("settings draft updates", () => {
  const saved: AppSettings = { model: "saved-model", contextTier: "long_context", theme: "dark", mcpServers: {} };

  it("does not turn an unchanged or cloned draft into a save", () => {
    expect(getSettingsDraftUpdates(saved, structuredClone(saved))).toEqual({});
  });

  it("does not dirty a form because an editor rebuilt object keys in a different order", () => {
    const original = { ...saved, providers: { ado: { project: "project", org: "org" } } };
    const draft = { ...saved, providers: { ado: { org: "org", project: "project" } } };
    expect(getSettingsDraftUpdates(original, draft)).toEqual({});
  });

  it("sends only the changed field, leaving model/context choices untouched", () => {
    expect(getSettingsDraftUpdates(saved, { ...saved, theme: "light" })).toEqual({ theme: "light" });
  });

  it("preserves explicit clearing for the existing API serializer", () => {
    const updates = getSettingsDraftUpdates(saved, { ...saved, model: undefined, contextTier: undefined });
    expect(updates).toHaveProperty("contextTier", undefined);
    expect(JSON.parse(serializeSettingsPatch(updates))).toEqual({ model: "", contextTier: "" });
  });

  it("does not duplicate independently saved policy and MCP writes", () => {
    expect(getSettingsDraftUpdates(saved, {
      ...saved,
      mcpServers: { local: { command: "node", args: [] } },
    })).toEqual({});
  });
});
