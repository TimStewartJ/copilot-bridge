import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { McpStatusResponse } from "../../api";
import { queryKeys } from "../../queryClient";
import { advanceTimersByTimeAct, createReactDomHarness } from "../../test-react-harness";
import { useMcpStatusSnapshotQuery } from "./useMcpStatus";
import { fetchMcpStatusSnapshot } from "../../api";

vi.mock("../../api", () => ({ fetchMcpStatusSnapshot: vi.fn() }));

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const { createReactDomHarness } = await import("../../test-react-harness");
  const harness = await createReactDomHarness();
  try { return await importOriginal<typeof import("@tanstack/react-query")>(); }
  finally { await harness.cleanup(); }
});

describe("MCP status snapshot hook", () => {
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
});
