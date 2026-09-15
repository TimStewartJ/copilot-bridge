import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { McpServerStatus, McpStatusResponse } from "../../api";
import { queryKeys } from "../../queryClient";
import { createReactDomHarness } from "../../test-react-harness";
import { useMcpStatusQuery, useMcpStatusSnapshotQuery } from "./useMcpStatus";

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const { createReactDomHarness } = await import("../../test-react-harness");
  const harness = await createReactDomHarness();
  try { return await importOriginal<typeof import("@tanstack/react-query")>(); }
  finally { await harness.cleanup(); }
});

describe("MCP hook export compatibility", () => {
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
