import { describe, expect, it } from "vitest";
import { getToolCallStatus, getToolCallStatusLabel } from "./tool-call-status";

describe("tool call status helpers", () => {
  it("treats incomplete tool calls as running", () => {
    expect(getToolCallStatus({})).toBe("running");
    expect(getToolCallStatusLabel("running")).toBe("Running");
  });

  it("marks completed tool calls as done", () => {
    expect(getToolCallStatus({ completedAt: "2026-04-22T20:00:00.000Z" })).toBe("done");
    expect(getToolCallStatus({ success: true })).toBe("done");
  });

  it("keeps failures distinct from successful completion", () => {
    expect(getToolCallStatus({ success: false })).toBe("failed");
    expect(getToolCallStatus({ success: false, completedAt: "2026-04-22T20:00:00.000Z", result: "traceback" })).toBe("failed");
    expect(getToolCallStatusLabel("failed")).toBe("Failed");
  });

  it("keeps partial output running until completion is explicit", () => {
    expect(getToolCallStatus({ result: "Agent summary" })).toBe("running");
  });
});
