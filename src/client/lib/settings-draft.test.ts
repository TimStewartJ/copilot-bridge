import { describe, expect, it } from "vitest";
import { sameSettingValue } from "./settings-draft";

describe("settings draft updates", () => {
  it("does not dirty a form because an editor rebuilt object keys in a different order", () => {
    const original = { ado: { project: "project", org: "org" } };
    const draft = { ado: { org: "org", project: "project" } };
    expect(sameSettingValue(original, draft)).toBe(true);
  });
});
