import { describe, expect, it } from "vitest";
import { createToolLoopGuard, getNoOpShellReason } from "../tool-loop-guard.js";

describe("tool loop guard (detection only)", () => {
  it("flags shell calls by their command alone, whatever the agent says they are for", () => {
    expect(getNoOpShellReason({ toolName: "bash", command: "true" })).toBeDefined();
    expect(getNoOpShellReason({ toolName: "bash", command: "printf ''" })).toBeDefined();
    expect(getNoOpShellReason({ toolName: "bash", command: "echo deploy tool should be next" })).toBeUndefined();
    expect(getNoOpShellReason({ toolName: "bash", command: "pwd" })).toBeUndefined();
  });

  it("reports a candidate for repeated identical mutating calls without blocking them", () => {
    const guard = createToolLoopGuard({ duplicateMutatingThreshold: 3 });

    expect(guard.detectCandidate("task_update_momentum", { taskId: "task-1", nextAction: "Review" })).toBeUndefined();
    expect(guard.detectCandidate("task_update_momentum", { nextAction: "Review", taskId: "task-1" })).toBeUndefined();
    const candidate = guard.detectCandidate("task_update_momentum", { taskId: "task-1", nextAction: "Review" });
    expect(candidate).toMatchObject({
      reason: "repeated_mutating_call",
      count: 3,
    });
  });

  it("never reports candidates for status/list/read tools even when repeated", () => {
    const guard = createToolLoopGuard({ duplicateMutatingThreshold: 2 });

    for (let i = 0; i < 5; i++) {
      expect(guard.detectCandidate("bridge-tools-management_job_status", { jobId: "job-1" })).toBeUndefined();
    }
  });
});
