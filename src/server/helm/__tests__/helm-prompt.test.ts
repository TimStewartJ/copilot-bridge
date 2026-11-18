import { describe, expect, it } from "vitest";
import { buildHelmChatGuidance } from "../helm-prompt.js";
import { buildThinkerSystemPrompt } from "../thinker/prompt.js";

describe("buildThinkerSystemPrompt", () => {
  it("aims the brief at what the user missed and what went stale, and skips what they are on now", () => {
    const prompt = buildThinkerSystemPrompt({ timeZone: "America/Los_Angeles", bridges: [{ id: "local", label: "PC" }], autonomy: "routine" });
    expect(prompt).toContain("find what the user might have missed and what has gone stale");
    expect(prompt).toContain("a reply or question that has sat unanswered for more than about a day");
    expect(prompt).toContain("a task whose lastEngagedAt is less than 4 hours before now, and work an agent is actively doing for them");
    expect(prompt).toContain("a revisit date (nextTouchAt) has passed");
    expect(prompt).toContain("move it to watching or drop it");
    expect(prompt).not.toContain("The user's name is");
  });

  it("names the user when Settings has their name", () => {
    const prompt = buildThinkerSystemPrompt({ timeZone: "UTC", bridges: [], autonomy: "routine", userName: "Alex Example" });
    expect(prompt).toContain("The user's name is Alex Example.");
  });
});

describe("buildHelmChatGuidance", () => {
  it("explains Bridge links, the default work model and the time zone", () => {
    const prompt = buildHelmChatGuidance({ timeZone: "America/Los_Angeles", defaultWorkModel: "claude-opus-5", glossary: "Atlas = Atlas project" });
    expect(prompt).toMatch(/^<helm>[\s\S]*<\/helm>$/);
    expect(prompt).toContain("bridge://session/<ref>");
    expect(prompt).toContain("(claude-opus-5)");
    expect(prompt).toContain("Atlas = Atlas project");
    expect(prompt).toContain("Local time zone: America/Los_Angeles.");
  });
});
