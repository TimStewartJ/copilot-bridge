import { describe, expect, it } from "vitest";
import { mcpObservationLabel, recentToolFailures, statusLineHasProblem } from "./mcp-status-display";
import type { ChatEntry } from "../api";

const tool = (name: string, success: boolean, result = "403 Forbidden"): ChatEntry => ({
  type: "tool", toolCall: { name, success, result, toolCallId: name },
});

describe("MCP status display", () => {
  it("identifies old and replayed observations with session provenance", () => {
    expect(mcpObservationLabel({ name: "demo", status: "connected", observedAt: new Date(100).toISOString(), provenance: "probe", sessionId: "123456789" }, 30_100)).toContain("may be stale");
    expect(mcpObservationLabel({ name: "demo", status: "connected", observedAt: new Date(100).toISOString(), provenance: "replay-event" }, 101)).toContain("may be stale");
    expect(mcpObservationLabel({ name: "demo", status: "connected" })).toBe("Observation time unavailable");
  });

  it("classifies failures separately and clears guidance after a later successful call", () => {
    const failures = recentToolFailures([tool("kusto-query", false), tool("calendar-query", false, "401 Unauthorized: token expired")]);
    expect(Object.fromEntries(failures.map(({ name, failure }) => [name, failure.category])))
      .toEqual({ "kusto-query": "permission", "calendar-query": "authentication" });
    expect(recentToolFailures([tool("kusto-query", false), tool("kusto-query", true)])).toEqual([]);
    expect(recentToolFailures([tool("kusto-query", true, "debug discovery protocol error then connected")])).toEqual([]);
  });

  const ready = { servers: [], statusState: "ready" as const, toolFailureCount: 0 };
  it.each([
    ["status still loading", { ...ready, statusState: "loading" as const }, false],
    ["a server connecting", { ...ready, servers: [{ name: "demo", status: "pending" as const }] }, false],
    ["status unreadable", { ...ready, statusState: "error" as const }, true],
    ["a server failed", { ...ready, servers: [{ name: "demo", status: "failed" as const }] }, true],
    ["a server needs sign-in", { ...ready, servers: [{ name: "demo", status: "needs-auth" as const }] }, true],
    ["tools failed to load", { ...ready, toolReadiness: { state: "failed" as const, startedAt: "2026-01-01T00:00:00.000Z" } }, true],
    ["a recent tool failure", { ...ready, toolFailureCount: 1 }, true],
  ])("marks the folded status line for %s: %s", (_case, input, expected) => {
    expect(statusLineHasProblem(input)).toBe(expected);
  });
});
