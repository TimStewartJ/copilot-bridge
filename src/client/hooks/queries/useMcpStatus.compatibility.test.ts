import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { McpServerStatus, McpStatusResponse } from "../../api";
import { queryKeys } from "../../queryClient";
import { advanceTimersByTimeAct, createReactDomHarness } from "../../test-react-harness";
import { useMcpStatusQuery, useMcpStatusSnapshotQuery } from "./useMcpStatus";
import { fetchMcpStatusSnapshot } from "../../api";

vi.mock("../../api", () => ({ fetchMcpStatusSnapshot: vi.fn() }));

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const { createReactDomHarness } = await import("../../test-react-harness");
  const harness = await createReactDomHarness();
  try { return await importOriginal<typeof import("@tanstack/react-query")>(); }
  finally { await harness.cleanup(); }
});

describe("MCP hook export compatibility", () => {
  it("reconciles ready tools plus pending servers even when no more stream events arrive", async () => {
    const harness = await createReactDomHarness();
    vi.useFakeTimers();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    const initial: McpStatusResponse = {
      servers: [{ name: "demo", status: "pending" }],
      toolReadiness: { state: "ready", startedAt: new Date().toISOString() },
    };
    const connected: McpStatusResponse = { ...initial, servers: [{ name: "demo", status: "connected" }] };
    vi.mocked(fetchMcpStatusSnapshot).mockResolvedValue(connected);
    client.setQueryData(queryKeys.mcpStatus("demo"), initial);
    let snapshot!: ReturnType<typeof useMcpStatusSnapshotQuery>;
    function Probe() { snapshot = useMcpStatusSnapshotQuery("demo"); return null; }
    try {
      await harness.render(createElement(QueryClientProvider, { client }, createElement(Probe)));
      expect(snapshot.data).toEqual(initial);
      await advanceTimersByTimeAct(harness.act, 30_000);
      await advanceTimersByTimeAct(harness.act, 1);
      expect(snapshot.data).toEqual(connected);
      expect(fetchMcpStatusSnapshot).toHaveBeenCalledOnce();
    } finally {
      await harness.cleanup();
      client.clear();
      vi.clearAllMocks();
    }
  });

  it("preserves legacy array data while the snapshot hook exposes independent readiness", async () => {
    const harness = await createReactDomHarness();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    const response: McpStatusResponse = {
      servers: [{ name: "demo", status: "connected" }],
      toolReadiness: { state: "ready", startedAt: "2026-09-15T17:00:00Z" },
    };
    client.setQueryData(queryKeys.mcpStatus("demo"), response);
    let legacy!: ReturnType<typeof useMcpStatusQuery>;
    let snapshot!: ReturnType<typeof useMcpStatusSnapshotQuery>;
    function Probe() {
      legacy = useMcpStatusQuery("demo");
      snapshot = useMcpStatusSnapshotQuery("demo");
      return null;
    }
    try {
      await harness.render(createElement(QueryClientProvider, { client }, createElement(Probe)));
      const legacyServers: McpServerStatus[] | undefined = legacy.data;
      expect(legacyServers).toEqual(response.servers);
      expect(snapshot.data).toEqual(response);
      expect(Array.isArray(legacy.data)).toBe(true);
      expect(client.getQueryData(queryKeys.mcpStatus("demo"))).toEqual(response);
    } finally {
      await harness.cleanup();
      client.clear();
    }
  });
});
