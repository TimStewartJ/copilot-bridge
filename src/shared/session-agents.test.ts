import { describe, expect, it } from "vitest";
import {
  emptyBackgroundAgentsSummary,
  hasSurfacedBackgroundAgents,
  isTerminalAgentStatus,
  summarizeBackgroundAgents,
  type SessionAgentTask,
} from "./session-agents.js";

function task(partial: Partial<SessionAgentTask> & Pick<SessionAgentTask, "id" | "status">): SessionAgentTask {
  return { executionMode: "background", ...partial };
}

describe("session-agents helpers", () => {
  it("classifies terminal statuses", () => {
    expect(isTerminalAgentStatus("completed")).toBe(true);
    expect(isTerminalAgentStatus("failed")).toBe(true);
    expect(isTerminalAgentStatus("cancelled")).toBe(true);
    expect(isTerminalAgentStatus("running")).toBe(false);
    expect(isTerminalAgentStatus("idle")).toBe(false);
  });

  it("summarizes only background-mode tasks", () => {
    const summary = summarizeBackgroundAgents(
      [
        task({ id: "a", status: "running" }),
        task({ id: "b", status: "idle" }),
        task({ id: "c", status: "failed" }),
        task({ id: "d", status: "completed" }),
        task({ id: "sync", status: "running", executionMode: "sync" }),
      ],
      "live",
    );
    expect(summary).toMatchObject({ running: 1, idle: 1, failed: 1, total: 4, source: "live" });
  });

  it("counts tasks with undefined executionMode as background", () => {
    const summary = summarizeBackgroundAgents(
      [task({ id: "a", status: "running", executionMode: undefined })],
      "live",
    );
    expect(summary.running).toBe(1);
    expect(summary.total).toBe(1);
  });

  it("only surfaces live, non-terminal background agents", () => {
    expect(hasSurfacedBackgroundAgents(undefined)).toBe(false);
    expect(hasSurfacedBackgroundAgents(emptyBackgroundAgentsSummary("unknown"))).toBe(false);
    // running but stale/lastSeen must not surface as live activity
    expect(
      hasSurfacedBackgroundAgents({ running: 2, idle: 0, failed: 0, total: 2, source: "lastSeen" }),
    ).toBe(false);
    expect(
      hasSurfacedBackgroundAgents({ running: 1, idle: 0, failed: 0, total: 1, source: "live" }),
    ).toBe(true);
    expect(
      hasSurfacedBackgroundAgents({ running: 0, idle: 1, failed: 0, total: 1, source: "live" }),
    ).toBe(true);
    // failed-only should not drive an active indicator
    expect(
      hasSurfacedBackgroundAgents({ running: 0, idle: 0, failed: 3, total: 3, source: "live" }),
    ).toBe(false);
  });
});
