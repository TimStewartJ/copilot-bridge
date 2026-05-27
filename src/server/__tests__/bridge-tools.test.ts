import { describe, expect, it, vi } from "vitest";
import { createBridgeTools } from "../bridge-tools.js";
import { BridgeToolsMcpServer, registerAllBridgeTools } from "../agent-tools-mcp/index.js";
import { createDocsToolDefinitions } from "../tools/docs-tools.js";
import { createTestApp, makeTestRuntimePaths } from "./helpers.js";
import { initializeDocsFts } from "../db.js";

describe("createBridgeTools", () => {
  it("provides compatibility access to MCP-backed report_intent definitions", () => {
    const { ctx } = createTestApp();
    const tool = createBridgeTools(ctx).find((candidate) => candidate.name === "report_intent");
    expect(tool).toBeTruthy();
    expect(tool?.scope).toBeUndefined();
  });

  it("provides compatibility access to MCP-backed self-admin and staging definitions", () => {
    const { ctx } = createTestApp();
    const toolNames = new Set(createBridgeTools(ctx).map((tool) => tool.name));
    expect(toolNames.has("self_restart")).toBe(true);
    expect(toolNames.has("self_update")).toBe(true);
    expect(toolNames.has("staging_init")).toBe(true);
    expect(toolNames.has("staging_deploy")).toBe(true);
  });

  it("docs_search returns a diagnosable tool failure when docs FTS is unhealthy", async () => {
    const { ctx, db } = createTestApp();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      db.exec("DROP TABLE docs_fts");
      db.exec("CREATE TABLE docs_fts(dummy TEXT)");
      initializeDocsFts(db, { repair: false });

      const tool = createDocsToolDefinitions(ctx).find((candidate) => candidate.name === "docs_search");
      expect(tool).toBeTruthy();
      const result = await tool!.handler({ query: "xylophone" }, {} as any) as any;

      expect(result).toMatchObject({
        resultType: "failure",
        code: "docs_fts_unavailable",
        operation: "search docs",
        health: {
          ok: false,
          status: "unavailable",
          code: "docs_fts_init_failed",
        },
      });
      expect(result.textResultForLlm).toContain("Docs full-text search is unavailable");
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("registerAllBridgeTools (MCP)", () => {
  it("hides git-backed tools in release mode while keeping self_restart available", () => {
    const runtimePaths = makeTestRuntimePaths("release-tools-mcp", { distributionMode: "release" });
    const { ctx } = createTestApp({ runtimePaths });
    const server = new BridgeToolsMcpServer(ctx);
    registerAllBridgeTools(server, ctx);
    const toolNames = new Set(server.getToolNames());

    expect(toolNames.has("self_restart")).toBe(true);
    expect(toolNames.has("self_update")).toBe(false);
    expect(toolNames.has("staging_init")).toBe(false);
    expect(toolNames.has("staging_deploy")).toBe(false);
  });

  it("exposes git-backed tools in non-release mode", () => {
    const { ctx } = createTestApp();
    const server = new BridgeToolsMcpServer(ctx);
    registerAllBridgeTools(server, ctx);
    const toolNames = new Set(server.getToolNames());

    expect(toolNames.has("self_restart")).toBe(true);
    expect(toolNames.has("self_update")).toBe(true);
    expect(toolNames.has("staging_init")).toBe(true);
    expect(toolNames.has("staging_deploy")).toBe(true);
  });
});
