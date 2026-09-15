import { describe, expect, it } from "vitest";
import type { McpStatusResponse, SessionToolReadinessSnapshot } from "../../api";
import { getMcpStatusQueryOptions } from "./useMcpStatus";

function intervalFor(data: McpStatusResponse | undefined) {
  const { refetchInterval } = getMcpStatusQueryOptions("demo");
  if (typeof refetchInterval !== "function") return refetchInterval;
  return refetchInterval({ state: { data } } as Parameters<typeof refetchInterval>[0]);
}

const readiness = (state: SessionToolReadinessSnapshot["state"]): SessionToolReadinessSnapshot => ({ state, startedAt: "2026-09-15T17:00:00Z" });

describe("MCP observation and readiness queries", () => {
  it("polls initializing readiness without treating healthy discovery as failure", () => {
    expect(intervalFor({ servers: [], toolReadiness: readiness("initializing") })).toBe(2_000);
  });

  it("stops readiness polling when the outcome is known", () => {
    for (const state of ["ready", "failed"] as const) {
      expect(intervalFor({ servers: [], toolReadiness: readiness(state) })).toBe(false);
    }
    expect(intervalFor({ servers: [], toolReadiness: null })).toBe(false);
    expect(intervalFor(undefined)).toBe(false);
  });

  it("refreshes readiness missing from a connection-only stream cache update", () => {
    expect(intervalFor({ servers: [{ name: "demo", status: "connected" }] })).toBe(2_000);
  });

  it("never starts an endpoint query without a session", () => {
    expect(getMcpStatusQueryOptions(null).enabled).toBe(false);
    expect(getMcpStatusQueryOptions("demo").staleTime).toBe(30_000);
  });
});
