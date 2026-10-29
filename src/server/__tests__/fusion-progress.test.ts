import { describe, expect, it } from "vitest";
import { createFusionProgress } from "../fusion-progress.js";

const NAMES: Record<string, string> = { "gpt-6.1-sol": "GPT-6.1 Sol", "gpt-6-luna": "GPT-6 Luna", "claude-opus-5.5": "Claude Opus 5.5" };

function phase(type: string, phaseId: string, phaseKind: string, model: string, extra: Record<string, unknown> = {}) {
  return { type, data: { fusionId: "f1", phaseId, phaseKind, model, ...extra } };
}

describe("createFusionProgress", () => {
  it.each([
    ["Cascade: the primary answers, then a judge checks it", [
      [phase("assistant.fusion_phase_started", "p1", "primary", "gpt-6.1-sol"), "Copilot Fusion · GPT-6.1 Sol working"],
      [phase("assistant.fusion_phase_completed", "p1", "primary", "gpt-6.1-sol"), undefined],
      [phase("assistant.fusion_phase_started", "j1", "judge", "gpt-6-luna"), "Copilot Fusion · GPT-6 Luna checking the answer"],
      [phase("assistant.fusion_phase_started", "r1", "repair", "claude-opus-5.5"), "Copilot Fusion · Claude Opus 5.5 redoing the answer"],
    ]],
    ["Critique: reviewers side by side, then the revision", [
      [phase("assistant.fusion_phase_started", "d1", "draft", "gpt-6.1-sol"), "Copilot Fusion · GPT-6.1 Sol drafting"],
      [phase("assistant.fusion_phase_activity", "d1", "draft", "gpt-6.1-sol", { activity: "tool_completed" }), "Copilot Fusion · GPT-6.1 Sol drafting · 1 tool run"],
      [phase("assistant.fusion_phase_completed", "d1", "draft", "gpt-6.1-sol"), undefined],
      [phase("assistant.fusion_phase_started", "c1", "critic", "gpt-6-luna"), "Copilot Fusion · GPT-6 Luna reviewing · 1 tool run"],
      [phase("assistant.fusion_phase_started", "c2", "critic", "claude-opus-5.5"), "Copilot Fusion · 2 models reviewing · 1 tool run"],
      [phase("assistant.fusion_phase_completed", "c2", "critic", "claude-opus-5.5"), "Copilot Fusion · GPT-6 Luna reviewing · 1 tool run"],
      [phase("assistant.fusion_phase_completed", "c1", "critic", "gpt-6-luna"), undefined],
      [phase("assistant.fusion_phase_started", "v1", "revision", "gpt-6.1-sol"), "Copilot Fusion · GPT-6.1 Sol revising · 1 tool run"],
      [{ type: "session.fusion_commit_started", data: {} }, ""],
      [{ type: "session.fusion_completed", data: {} }, undefined],
    ]],
  ] as const)("%s", (_label, steps) => {
    const progress = createFusionProgress((id) => NAMES[id] ?? id);
    progress.observe({ type: "session.fusion_resolved", data: {} });
    for (const [event, status] of steps) expect(progress.observe(event), JSON.stringify(event)).toBe(status);
  });
});
