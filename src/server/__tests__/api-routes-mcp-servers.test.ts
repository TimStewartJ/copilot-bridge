import { describe, expect, it, vi } from "vitest";
import {
  createMockSessionManager,
  createTestApp,
  request,
} from "./api-routes-test-helpers.js";

const localConfig = { command: "alpha-mcp", args: ["serve"] };
const updatedLocalConfig = { command: "beta-mcp", args: ["serve"], env: { DEBUG: "1" } };
const remoteConfig = { type: "http" as const, url: "https://mcp.example.test/mcp" };

describe("MCP server registry routes", () => {
  it("supports registry CRUD/default toggles and evicts cached sessions", async () => {
    const sessionManager = createMockSessionManager();
    const evictSpy = vi.fn();
    sessionManager.evictAllCachedSessions = evictSpy;
    const { app } = createTestApp({ sessionManager });

    const empty = await request(app).get("/api/mcp-servers");
    expect(empty.status).toBe(200);
    expect(empty.body.servers).toEqual([]);

    const created = await request(app)
      .post("/api/mcp-servers")
      .send({ name: "Alpha", config: localConfig, enabledByDefault: true });

    expect(created.status).toBe(201);
    expect(created.body.server).toMatchObject({
      id: expect.any(String),
      name: "Alpha",
      config: localConfig,
      enabledByDefault: true,
    });
    expect(evictSpy).toHaveBeenCalledTimes(1);

    const defaultSettings = await request(app).get("/api/settings");
    expect(defaultSettings.body.mcpServers).toEqual({ Alpha: localConfig });

    const patched = await request(app)
      .patch(`/api/mcp-servers/${created.body.server.id}`)
      .send({ name: "Beta", config: updatedLocalConfig, enabledByDefault: false });

    expect(patched.status).toBe(200);
    expect(patched.body.server).toMatchObject({
      id: created.body.server.id,
      name: "Beta",
      config: updatedLocalConfig,
      enabledByDefault: false,
    });
    expect(evictSpy).toHaveBeenCalledTimes(2);

    const settingsAfterToggle = await request(app).get("/api/settings");
    expect(settingsAfterToggle.body.mcpServers).toEqual({});

    const listed = await request(app).get("/api/mcp-servers");
    expect(listed.body.servers.map((server: any) => server.name)).toEqual(["Beta"]);

    const deleted = await request(app).delete(`/api/mcp-servers/${created.body.server.id}`);
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ success: true });
    expect(evictSpy).toHaveBeenCalledTimes(3);

    const afterDelete = await request(app).get("/api/mcp-servers");
    expect(afterDelete.body.servers).toEqual([]);
  });

  it("serves registry routes through settingsStore fallback when context omits mcpServerStore", async () => {
    const sessionManager = createMockSessionManager();
    const { app } = createTestApp({ sessionManager, mcpServerStore: undefined });

    const empty = await request(app).get("/api/mcp-servers");
    expect(empty.status).toBe(200);
    expect(empty.body.servers).toEqual([]);

    const created = await request(app)
      .post("/api/mcp-servers")
      .send({ name: "Fallback", config: localConfig, enabledByDefault: true });

    expect(created.status).toBe(201);
    expect(created.body.server).toMatchObject({
      name: "Fallback",
      config: localConfig,
      enabledByDefault: true,
    });
  });

  it("sets tag MCP selections by registry ID, de-duplicates, cascades delete, and evicts", async () => {
    const sessionManager = createMockSessionManager();
    const evictSpy = vi.fn();
    sessionManager.evictAllCachedSessions = evictSpy;
    const { app, ctx } = createTestApp({ sessionManager });
    const tag = ctx.tagStore!.createTag("Tools");
    const alpha = ctx.mcpServerStore!.createMcpServer({ name: "Alpha", config: localConfig });
    const beta = ctx.mcpServerStore!.createMcpServer({ name: "Beta", config: remoteConfig });

    const selected = await request(app)
      .put(`/api/tags/${tag.id}/mcp-servers`)
      .send({ serverIds: [beta.id, alpha.id, alpha.id] });

    expect(selected.status).toBe(200);
    expect(selected.body.servers.map((server: any) => server.serverId)).toEqual([alpha.id, beta.id]);
    expect(selected.body.servers.map((server: any) => server.serverName)).toEqual(["Alpha", "Beta"]);
    expect(evictSpy).toHaveBeenCalledTimes(1);

    const legacyRead = await request(app).get(`/api/tags/${tag.id}/mcp`);
    expect(legacyRead.body.servers.map((server: any) => server.serverId)).toEqual([alpha.id, beta.id]);

    const deleted = await request(app).delete(`/api/mcp-servers/${alpha.id}`);
    expect(deleted.status).toBe(200);
    expect(evictSpy).toHaveBeenCalledTimes(2);
    expect(ctx.tagStore!.getTagMcpServerIds(tag.id)).toEqual([beta.id]);
  });

  it("supports incremental tag refs and legacy tag MCP routes with cache eviction", async () => {
    const sessionManager = createMockSessionManager();
    const evictSpy = vi.fn();
    sessionManager.evictAllCachedSessions = evictSpy;
    const { app, ctx, db } = createTestApp({ sessionManager });
    const tag = ctx.tagStore!.createTag("Legacy Tools");
    const alpha = ctx.mcpServerStore!.createMcpServer({ name: "Alpha", config: localConfig });

    const added = await request(app).post(`/api/tags/${tag.id}/mcp-refs/${alpha.id}`);
    expect(added.status).toBe(200);
    expect(added.body.server).toMatchObject({ serverId: alpha.id, serverName: "Alpha" });
    expect(ctx.tagStore!.getTagMcpServerIds(tag.id)).toEqual([alpha.id]);

    const removed = await request(app).delete(`/api/tags/${tag.id}/mcp-refs/${alpha.id}`);
    expect(removed.status).toBe(200);
    expect(ctx.tagStore!.getTagMcpServerIds(tag.id)).toEqual([]);

    const legacyPut = await request(app)
      .put(`/api/tags/${tag.id}/mcp/legacy-linear`)
      .send(remoteConfig);
    expect(legacyPut.status).toBe(200);
    expect(ctx.tagStore!.getTagMcpServers(tag.id)).toEqual([
      expect.objectContaining({
        serverId: expect.any(String),
        serverName: "legacy-linear",
        config: remoteConfig,
      }),
    ]);
    expect(ctx.mcpServerStore!.getMcpServerByName("legacy-linear")).toMatchObject({
      config: remoteConfig,
      enabledByDefault: false,
    });

    const legacyDelete = await request(app).delete(`/api/tags/${tag.id}/mcp/legacy-linear`);
    expect(legacyDelete.status).toBe(200);
    expect(ctx.tagStore!.getTagMcpServers(tag.id)).toEqual([]);
    expect((db.prepare("SELECT COUNT(*) AS count FROM tag_mcp_servers").get() as any).count).toBe(0);
    expect(evictSpy).toHaveBeenCalledTimes(4);
  });

  it("validates registry mutations and does not evict on rejected changes", async () => {
    const sessionManager = createMockSessionManager();
    const evictSpy = vi.fn();
    sessionManager.evictAllCachedSessions = evictSpy;
    const { app, ctx } = createTestApp({ sessionManager });
    const existing = ctx.mcpServerStore!.createMcpServer({ name: "Alpha", config: localConfig });
    const tag = ctx.tagStore!.createTag("Tools");

    const invalidCreate = await request(app)
      .post("/api/mcp-servers")
      .send({ name: "Broken", config: { type: "http", url: "" } });
    expect(invalidCreate.status).toBe(400);
    expect(invalidCreate.body.error).toMatch(/Invalid MCP server config/);

    const duplicateCreate = await request(app)
      .post("/api/mcp-servers")
      .send({ name: "alpha", config: updatedLocalConfig });
    expect(duplicateCreate.status).toBe(400);
    expect(duplicateCreate.body.error).toMatch(/already exists/);

    const missingPatch = await request(app)
      .patch("/api/mcp-servers/missing-server")
      .send({ enabledByDefault: true });
    expect(missingPatch.status).toBe(404);

    const invalidPatch = await request(app)
      .patch(`/api/mcp-servers/${existing.id}`)
      .send({ enabledByDefault: "yes" });
    expect(invalidPatch.status).toBe(400);
    expect(ctx.mcpServerStore!.getMcpServer(existing.id)!.enabledByDefault).toBe(false);

    const missingDelete = await request(app).delete("/api/mcp-servers/missing-server");
    expect(missingDelete.status).toBe(404);

    const missingTagSelection = await request(app)
      .put(`/api/tags/${tag.id}/mcp-servers`)
      .send({ serverIds: ["missing-server"] });
    expect(missingTagSelection.status).toBe(400);
    expect(ctx.tagStore!.getTagMcpServerIds(tag.id)).toEqual([]);
    expect(evictSpy).not.toHaveBeenCalled();
  });

  it("routes legacy settings mcpServers into registry defaults without persisting settings-owned definitions", async () => {
    const sessionManager = createMockSessionManager();
    const evictSpy = vi.fn();
    sessionManager.evictAllCachedSessions = evictSpy;
    const { app, ctx, db } = createTestApp({ sessionManager });

    const res = await request(app)
      .patch("/api/settings")
      .send({ mcpServers: { Legacy: remoteConfig } });

    expect(res.status).toBe(200);
    expect(res.body.mcpServers).toEqual({ Legacy: remoteConfig });
    expect(ctx.mcpServerStore!.getMcpServerByName("Legacy")).toMatchObject({
      name: "Legacy",
      config: remoteConfig,
      enabledByDefault: true,
    });
    const rawSettings = JSON.parse((db.prepare("SELECT value FROM settings WHERE key = 'app'").get() as any).value);
    expect(rawSettings.mcpServers).toBeUndefined();
    expect(evictSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects legacy settings mcpServers that collide with tag-scoped registry entries", async () => {
    const sessionManager = createMockSessionManager();
    const evictSpy = vi.fn();
    sessionManager.evictAllCachedSessions = evictSpy;
    const { app, ctx } = createTestApp({ sessionManager });

    const tagScoped = ctx.mcpServerStore!.createMcpServer({
      name: "Scoped",
      config: { command: "tag-only", args: [] },
      enabledByDefault: false,
    });

    const res = await request(app)
      .patch("/api/settings")
      .send({ mcpServers: { Scoped: { command: "legacy-default", args: [] } } });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("non-default registry server");
    expect(ctx.mcpServerStore!.getMcpServer(tagScoped.id)).toMatchObject({
      name: "Scoped",
      config: { command: "tag-only", args: [] },
      enabledByDefault: false,
    });
    expect(evictSpy).not.toHaveBeenCalled();
  });
});
