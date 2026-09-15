import type { McpServerStatus, McpStatusSnapshot } from "./session-runner.js";

export const MCP_STATUS_FRESHNESS_MS = 30_000;
export type McpStatusProvenance = "live-event" | "replay-event" | "probe";

export function stampMcpStatusSnapshot(
  snapshot: McpStatusSnapshot,
  sessionId: string,
  provenance: McpStatusProvenance,
  observedAt = Date.now(),
  changedServerName?: string,
): McpStatusSnapshot {
  return {
    ...snapshot,
    observedAt,
    provenance,
    sessionId,
    servers: snapshot.servers.map((server) => changedServerName && server.name !== changedServerName ? server : ({
      ...server,
      observedAt: new Date(observedAt).toISOString(),
      provenance,
      sessionId,
    })),
  };
}

export function isMcpStatusFresh(snapshot: McpStatusSnapshot, now = Date.now()): boolean {
  // Legacy in-memory snapshots remain usable, but cannot outrank timestamped observations.
  return snapshot.observedAt === undefined
    || (snapshot.provenance !== "replay-event" && now - snapshot.observedAt < MCP_STATUS_FRESHNESS_MS);
}

export function latestMcpStatus(snapshots: Iterable<McpStatusSnapshot>): McpServerStatus[] {
  let latest: McpStatusSnapshot | undefined;
  for (const snapshot of snapshots) {
    if (!latest || (snapshot.observedAt ?? 0) >= (latest.observedAt ?? 0)) latest = snapshot;
  }
  // An authoritative empty observation must not resurrect an older server list.
  return latest?.servers ?? [];
}
