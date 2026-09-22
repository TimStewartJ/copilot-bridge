import { describe, expect, it } from "vitest";
import { isMcpStatusFresh, latestMcpStatus, stampMcpStatusSnapshot } from "../mcp-status.js";
import { applyMcpServerStatusChange, type McpStatusSnapshot } from "../session-runner.js";

const snapshot = (time: number, name = "demo", provenance: "probe" | "replay-event" = "probe") =>
  stampMcpStatusSnapshot({ servers: [{ name, status: "connected" }], complete: true }, name, provenance, time);

describe("MCP status observations", () => {
  it("selects observation time, not insertion order, including updates to existing keys", () => {
    const cache = new Map<string, McpStatusSnapshot>();
    cache.set("old", snapshot(100, "old"));
    cache.set("new", snapshot(200, "new"));
    expect(latestMcpStatus(cache.values())[0].name).toBe("new");
    cache.set("old", snapshot(300, "old"));
    expect(latestMcpStatus(cache.values())[0].name).toBe("old");
  });

  it("keeps authoritative empty lists instead of resurrecting older servers", () => {
    const empty = stampMcpStatusSnapshot({ servers: [], complete: true }, "empty", "live-event", 300);
    expect(latestMcpStatus([snapshot(100), empty])).toEqual([]);
  });

  it("bounds freshness and never treats replay as a fresh connection probe", () => {
    expect(isMcpStatusFresh(snapshot(100), 30_099)).toBe(true);
    expect(isMcpStatusFresh(snapshot(100), 30_100)).toBe(false);
    expect(isMcpStatusFresh(snapshot(100, "demo", "replay-event"), 101)).toBe(false);
  });

  it.each(["pending", "unknown"] as const)("requires a probe for %s events and bounds repeated probe reads", (status) => {
    const observation: McpStatusSnapshot = { servers: [{ name: "demo", status }], complete: true };
    expect(isMcpStatusFresh(stampMcpStatusSnapshot(observation, "session", "live-event", 100), 101)).toBe(false);
    expect(isMcpStatusFresh(stampMcpStatusSnapshot(observation, "session", "replay-event", 100), 101)).toBe(false);
    const probed = stampMcpStatusSnapshot(observation, "session", "probe", 100);
    expect(isMcpStatusFresh(probed, 2_099)).toBe(true);
    expect(isMcpStatusFresh(probed, 2_100)).toBe(false);
  });

  it("includes provenance without replacing the SDK source", () => {
    const stamped = stampMcpStatusSnapshot({ servers: [{ name: "demo", status: "connected", source: "sdk" }], complete: true }, "session", "probe", 100);
    expect(stamped.servers[0]).toMatchObject({ source: "sdk", sessionId: "session", provenance: "probe", observedAt: new Date(100).toISOString() });
  });

  it("does not refresh unchanged server observations on an incremental update", () => {
    const original = stampMcpStatusSnapshot({ servers: [{ name: "a", status: "connected" }, { name: "b", status: "pending" }], complete: true }, "session", "probe", 100);
    const update = applyMcpServerStatusChange(original, { serverName: "b", status: "connected" });
    const stamped = stampMcpStatusSnapshot(update.snapshot, "session", "live-event", 200, "b");
    expect(stamped.servers[0].observedAt).toBe(new Date(100).toISOString());
    expect(stamped.servers[0].provenance).toBe("probe");
    expect(stamped.servers[1].observedAt).toBe(new Date(200).toISOString());
  });

  it("clears transient discovery errors when the server later connects", () => {
    const failed: McpStatusSnapshot = { servers: [{ name: "demo", status: "failed", error: "discovery protocol error" }], complete: true };
    const connected = applyMcpServerStatusChange(failed, { serverName: "demo", status: "connected" });
    expect(connected.snapshot.servers[0].status).toBe("connected");
    expect(connected.snapshot.servers[0].error).toBeUndefined();
  });
});
