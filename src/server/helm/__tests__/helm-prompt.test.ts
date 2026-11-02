import { describe, expect, it } from "vitest";
import { buildHelmChatGuidance } from "../helm-prompt.js";
import { buildThinkerSystemPrompt } from "../thinker/prompt.js";

describe("buildThinkerSystemPrompt", () => {
  it("aims the brief at what Tim missed and what went stale, and skips what he is on now", () => {
    const prompt = buildThinkerSystemPrompt({ timeZone: "America/Los_Angeles", bridges: [{ id: "local", label: "PC" }], autonomy: "routine" });
    expect(prompt).toContain("find what Tim might have missed and what has gone stale");
    expect(prompt).toContain("a reply or question that has sat unanswered for more than about a day");
    expect(prompt).toContain("a task whose lastEngagedAt is less than 4 hours before now, and work an agent is actively doing for him");
    expect(prompt).toContain("a revisit date (nextTouchAt) has passed");
    expect(prompt).toContain("move it to watching or drop it");
  });
});

describe("buildHelmChatGuidance", () => {
  it("explains Bridge links, the default work model and the time zone", () => {
    const prompt = buildHelmChatGuidance({ timeZone: "America/Los_Angeles", defaultWorkModel: "claude-opus-5" });
    expect(prompt).toMatch(/^<helm>[\s\S]*<\/helm>$/);
    expect(prompt).toContain("bridge://session/<ref>");
    expect(prompt).toContain("(claude-opus-5)");
    expect(prompt).toContain("Local time zone: America/Los_Angeles.");
  });

  it("uses the task index and find for tasks, decides a task before starting work, reports progress and flags automated sessions", () => {
    const prompt = buildHelmChatGuidance({ timeZone: "America/Los_Angeles" });
    expect(prompt).toContain("starts with a helm_task_index");
    expect(prompt).toContain("check task_list or find");
    expect(prompt).toContain("start_session with the taskId of the task the work belongs to");
    expect(prompt).toContain("noTask with a reason only when no task fits");
    expect(prompt).toContain("call find first");
    expect(prompt).toContain("report its progress");
    expect(prompt).toContain("is automated: say so");
    expect(prompt).not.toContain("Names the user uses");
  });

  it("includes the user's names list when there is one", () => {
    const prompt = buildHelmChatGuidance({ timeZone: "America/Los_Angeles", glossary: "devbox = Timmy PC" });
    expect(prompt).toContain("Names the user uses (speech recognition may mishear them; map what you hear onto these): devbox = Timmy PC");
  });
});
