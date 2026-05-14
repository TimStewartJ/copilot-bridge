import { describe, expect, it } from "vitest";
import {
  isSessionStatePathSegment,
  parseWorkspaceYamlBoolean,
  parseWorkspaceYamlScalar,
  parseWorkspaceYamlSessionName,
  parseWorkspaceYamlSessionNameMetadata,
} from "../session-workspace-yaml.js";

describe("session workspace yaml parsing", () => {
  it("reads plain and quoted top-level scalar values", () => {
    expect(parseWorkspaceYamlSessionName("created_at: 2026-05-08T10:00:00.000Z\nname: Review catalog adapter\n"))
      .toBe("Review catalog adapter");
    expect(parseWorkspaceYamlSessionName("name: \"Fix Login: Redirect\"\nsummary: Old summary\n"))
      .toBe("Fix Login: Redirect");
    expect(parseWorkspaceYamlScalar("name: null\nsummary: Fallback summary\n", "name")).toBeUndefined();
  });

  it("reads block scalar names and normalizes display whitespace", () => {
    const literal = [
      "created_at: 2026-05-08T10:00:00.000Z",
      "name: |-",
      "  Fix Login",
      "  Redirect",
      "summary: Old summary",
    ].join("\n");
    const folded = [
      "created_at: 2026-05-08T10:00:00.000Z",
      "name: >",
      "  Investigate stale",
      "  session names",
    ].join("\n");

    expect(parseWorkspaceYamlSessionName(literal)).toBe("Fix Login Redirect");
    expect(parseWorkspaceYamlSessionName(folded)).toBe("Investigate stale session names");
  });

  it("falls back to summary and ignores invalid yaml", () => {
    expect(parseWorkspaceYamlSessionName("summary: Summary only\n")).toBe("Summary only");
    expect(parseWorkspaceYamlSessionName("name: [unterminated\n")).toBeUndefined();
  });

  it("reads session name metadata including explicit user naming", () => {
    const content = [
      "name: Manual title",
      "summary: Original prompt",
      "user_named: true",
    ].join("\n");

    expect(parseWorkspaceYamlBoolean(content, "user_named")).toBe(true);
    expect(parseWorkspaceYamlSessionNameMetadata(content)).toEqual({
      name: "Manual title",
      summary: "Original prompt",
      effectiveName: "Manual title",
      userNamed: true,
    });
    expect(parseWorkspaceYamlSessionNameMetadata("summary: Prompt\nuser_named: false\n")).toEqual({
      name: undefined,
      summary: "Prompt",
      effectiveName: "Prompt",
      userNamed: false,
    });
  });

  it("rejects unsafe session-state path segments", () => {
    expect(isSessionStatePathSegment("session-1")).toBe(true);
    expect(isSessionStatePathSegment("..")).toBe(false);
    expect(isSessionStatePathSegment("nested/session")).toBe(false);
    expect(isSessionStatePathSegment("nested\\session")).toBe(false);
  });
});
