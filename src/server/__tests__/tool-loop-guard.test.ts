import { describe, expect, it } from "vitest";
import { createToolLoopGuard, getNoOpShellReason } from "../tool-loop-guard.js";

describe("tool loop guard (detection only)", () => {
  it("detects explicit no-op and marker shell calls", () => {
    expect(getNoOpShellReason({
      toolName: "bash",
      command: "true",
      description: "No-op",
    })).toContain("no-op");
    expect(getNoOpShellReason({
      toolName: "bash",
      command: "echo deploy tool should be next",
      description: "Marker",
    })).toContain("marker");
  });

  it("does not treat useful shell probes as no-ops", () => {
    expect(getNoOpShellReason({
      toolName: "bash",
      command: "true",
      description: "Health probe",
    })).toBeUndefined();
    expect(getNoOpShellReason({
      toolName: "bash",
      command: "pwd",
      description: "Print current directory",
    })).toBeUndefined();
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
