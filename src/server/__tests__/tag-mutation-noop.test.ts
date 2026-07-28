import { describe, expect, it, vi } from "vitest";
import type { ApiRouteTestState } from "./api-routes-test-helpers.js";
import { installApiRouteTestHooks, request } from "./api-routes-test-helpers.js";
import { createTagToolDefinitions } from "../tools/tag-tools.js";

let app: ApiRouteTestState["app"];
let ctx: ApiRouteTestState["ctx"];

installApiRouteTestHooks((state) => {
  ({ app, ctx } = state);
});

function toolHandler(name: string) {
  const tool = createTagToolDefinitions(ctx).find((definition) => definition.name === name);
  if (!tool) throw new Error(`Tool ${name} not registered`);
  return (args: any) => (tool.handler as any)(args, { sessionId: "test-session", requestId: 1 });
}

describe("tag mutations reject silent no-ops", () => {
  it("PATCH /api/tags/:id rejects an unknown colour instead of reporting success", async () => {
    const tag = ctx.tagStore!.createTag("release", "blue");
    const evict = vi.spyOn(ctx.sessionManager, "evictAllCachedSessions");

    const res = await request(app).patch(`/api/tags/${tag.id}`).send({ color: "chartreuse" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid tag color/);
    expect(ctx.tagStore!.getTag(tag.id)!.color).toBe("blue");
    expect(evict).not.toHaveBeenCalled();
  });

  it("PATCH /api/tags/:id persists a valid colour without evicting cached sessions", async () => {
    const tag = ctx.tagStore!.createTag("release", "blue");
    const evict = vi.spyOn(ctx.sessionManager, "evictAllCachedSessions");

    const res = await request(app).patch(`/api/tags/${tag.id}`).send({ color: "rose" });

    expect(res.status).toBe(200);
    expect(ctx.tagStore!.getTag(tag.id)!.color).toBe("rose");
    // Colour is not part of the session prompt, so it must not nuke the cache.
    expect(evict).not.toHaveBeenCalled();
  });

  it("PATCH /api/tags/:id evicts exactly once when instructions actually change", async () => {
    const tag = ctx.tagStore!.createTag("release", "blue");
    const evict = vi.spyOn(ctx.sessionManager, "evictAllCachedSessions");

    await request(app).patch(`/api/tags/${tag.id}`).send({ instructions: "Be careful" }).expect(200);

    expect(evict).toHaveBeenCalledTimes(1);
    expect(ctx.tagStore!.getTag(tag.id)!.instructions).toBe("Be careful");
  });

  it("DELETE /api/tags/:id does not evict when the tag does not exist", async () => {
    const evict = vi.spyOn(ctx.sessionManager, "evictAllCachedSessions");

    const res = await request(app).delete("/api/tags/missing-tag-id");

    expect(res.status).toBe(404);
    expect(evict).not.toHaveBeenCalled();
  });

  it("DELETE /api/tags/:id evicts exactly once for a real deletion", async () => {
    const tag = ctx.tagStore!.createTag("release");
    const evict = vi.spyOn(ctx.sessionManager, "evictAllCachedSessions");

    await request(app).delete(`/api/tags/${tag.id}`).expect(200);

    expect(evict).toHaveBeenCalledTimes(1);
    expect(ctx.tagStore!.getTag(tag.id)).toBeUndefined();
  });
});

describe("tag tools mirror the REST no-op rules", () => {
  it("tag_update fails on an invalid colour without evicting", async () => {
    const tag = ctx.tagStore!.createTag("release", "blue");
    const evict = vi.spyOn(ctx.sessionManager, "evictAllCachedSessions");

    const result = await toolHandler("tag_update")({ tagId: tag.id, color: "chartreuse" });

    expect(result).toMatchObject({ resultType: "failure" });
    expect(ctx.tagStore!.getTag(tag.id)!.color).toBe("blue");
    expect(evict).not.toHaveBeenCalled();
  });

  it("tag_update does not evict for a colour-only change", async () => {
    const tag = ctx.tagStore!.createTag("release", "blue");
    const evict = vi.spyOn(ctx.sessionManager, "evictAllCachedSessions");

    await toolHandler("tag_update")({ tagId: tag.id, color: "amber" });

    expect(ctx.tagStore!.getTag(tag.id)!.color).toBe("amber");
    expect(evict).not.toHaveBeenCalled();
  });

  it("tag_delete fails without evicting when the tag is missing", async () => {
    const evict = vi.spyOn(ctx.sessionManager, "evictAllCachedSessions");

    const result = await toolHandler("tag_delete")({ tagId: "missing-tag-id" });

    expect(result).toMatchObject({ resultType: "failure" });
    expect(evict).not.toHaveBeenCalled();
  });
});

describe("bulk tag MCP assignment still works", () => {
  it("PUT /api/tags/:id/mcp-servers replaces the selection and evicts once", async () => {
    const tag = ctx.tagStore!.createTag("release");
    const server = ctx.mcpServerStore!.createMcpServer({
      name: "linear",
      config: { command: "linear-mcp", args: [] },
    });
    const evict = vi.spyOn(ctx.sessionManager, "evictAllCachedSessions");

    const res = await request(app)
      .put(`/api/tags/${tag.id}/mcp-servers`)
      .send({ serverIds: [server.id] });

    expect(res.status).toBe(200);
    expect(res.body.servers.map((entry: any) => entry.serverName)).toContain("linear");
    expect(ctx.tagStore!.getTagMcpServers(tag.id).map((entry: any) => entry.serverName)).toContain("linear");
    expect(evict).toHaveBeenCalledTimes(1);
  });
});
