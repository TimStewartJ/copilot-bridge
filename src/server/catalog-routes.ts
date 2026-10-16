import type { Router } from "express";
import type { AppContext } from "./app-context.js";
import type { McpServerConfig } from "./mcp-config.js";
import { isRecord } from "../shared/is-record.js";
import { TaskGroupValidationError } from "./task-group-store.js";
import { InvalidTagColorError } from "./tag-store.js";
import { deleteHomeSkill, isValidSkillId, listSkills, readSkill } from "./skills-registry.js";

export function registerCatalogRoutes(router: Router, ctx: AppContext, getCopilotHome: () => string): void {
  router.get("/task-groups", (_req, res) => {
    const groups = ctx.taskGroupStore.listGroups();
    const groupsWithTags = groups.map((g) => ({
      ...g,
      tags: ctx.tagStore?.getEntityTags("task_group", g.id) ?? [],
    }));
    res.json({ groups: groupsWithTags });
  });

  router.post("/task-groups", (req, res) => {
    const { name, color } = req.body;
    if (!name) return res.status(400).json({ error: "name is required" });
    try {
      const group = ctx.taskGroupStore.createGroup(name, color);
      res.json({ group });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  router.patch("/task-groups/:id", (req, res) => {
    try {
      const group = ctx.taskGroupStore.updateGroup(req.params.id, req.body);
      const tags = ctx.tagStore?.getEntityTags("task_group", group.id) ?? [];
      res.json({ group: { ...group, tags } });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = err instanceof TaskGroupValidationError ? 400 : /Group .* not found/.test(message) ? 404 : 400;
      res.status(status).json({ error: message });
    }
  });

  router.delete("/task-groups/:id", (req, res) => {
    try {
      const result = ctx.taskGroupStore.deleteGroup(req.params.id);
      res.json({ success: true, deleted: result.deleted, ungroupedTaskCount: result.affectedTaskIds.length });
    } catch (err) {
      console.error("[task-groups] Delete failed:", err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.put("/task-groups/reorder", (req, res) => {
    const { groupIds } = req.body;
    if (!Array.isArray(groupIds)) return res.status(400).json({ error: "groupIds array is required" });
    try {
      res.json({ groups: ctx.taskGroupStore.reorderGroups(groupIds) });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  const getMcpServerStore = () => ctx.mcpServerStore ?? ctx.settingsStore.getMcpServerStore();
  router.get("/mcp-servers", (_req, res) => {
    const store = getMcpServerStore();
    if (!store) return res.status(501).json({ error: "MCP server registry not available" });
    res.json({ servers: store.listMcpServers() });
  });

  router.post("/mcp-servers", (req, res) => {
    const store = getMcpServerStore();
    if (!store) return res.status(501).json({ error: "MCP server registry not available" });
    if (!isRecord(req.body)) return res.status(400).json({ error: "request body is required" });
    const { name, config, enabledByDefault } = req.body;
    if (typeof name !== "string") return res.status(400).json({ error: "name is required" });
    if (enabledByDefault !== undefined && typeof enabledByDefault !== "boolean") {
      return res.status(400).json({ error: "enabledByDefault must be a boolean" });
    }
    try {
      const server = store.createMcpServer({ name, config: config as McpServerConfig, enabledByDefault });
      console.log("[mcp] MCP server registry changed — evicting cached sessions");
      void ctx.sessionManager.evictAllCachedSessions();
      res.status(201).json({ server });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.patch("/mcp-servers/:id", (req, res) => {
    const store = getMcpServerStore();
    if (!store) return res.status(501).json({ error: "MCP server registry not available" });
    if (!isRecord(req.body)) return res.status(400).json({ error: "request body is required" });
    const updates: { name?: string; config?: McpServerConfig; enabledByDefault?: boolean } = {};
    if ("name" in req.body) {
      if (typeof req.body.name !== "string") return res.status(400).json({ error: "name must be a string" });
      updates.name = req.body.name;
    }
    if ("config" in req.body) updates.config = req.body.config as McpServerConfig;
    if ("enabledByDefault" in req.body) {
      if (typeof req.body.enabledByDefault !== "boolean") {
        return res.status(400).json({ error: "enabledByDefault must be a boolean" });
      }
      updates.enabledByDefault = req.body.enabledByDefault;
    }
    try {
      const server = store.updateMcpServer(req.params.id, updates);
      console.log("[mcp] MCP server registry changed — evicting cached sessions");
      void ctx.sessionManager.evictAllCachedSessions();
      res.json({ server });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(/not found/i.test(message) ? 404 : 400).json({ error: message });
    }
  });

  router.delete("/mcp-servers/:id", (req, res) => {
    const store = getMcpServerStore();
    if (!store) return res.status(501).json({ error: "MCP server registry not available" });
    if (!store.getMcpServer(req.params.id)) return res.status(404).json({ error: "MCP server not found" });
    store.deleteMcpServer(req.params.id);
    console.log("[mcp] MCP server registry changed — evicting cached sessions");
    void ctx.sessionManager.evictAllCachedSessions();
    res.json({ success: true });
  });

  router.get("/skills", (_req, res) => {
    try {
      res.json({ skills: listSkills({ copilotHome: getCopilotHome() }) });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/skills/:id", (req, res) => {
    if (!isValidSkillId(req.params.id)) return res.status(400).json({ error: "invalid skill id" });
    try {
      const skill = readSkill({ copilotHome: getCopilotHome() }, req.params.id);
      if (!skill) return res.status(404).json({ error: "skill not found" });
      res.json({ skill });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.delete("/skills/:id", async (req, res) => {
    try {
      const result = await deleteHomeSkill({ copilotHome: getCopilotHome(), id: req.params.id });
      if (result === "invalid") return res.status(400).json({ error: "invalid skill id" });
      if (result === "not-found") return res.status(404).json({ error: "skill not found" });
      console.log("[skills] Home skill deleted — evicting cached sessions");
      void ctx.sessionManager.evictAllCachedSessions();
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/tags", (_req, res) => res.json({ tags: ctx.tagStore?.listTags() ?? [] }));
  router.post("/tags", (req, res) => {
    if (!ctx.tagStore) return res.status(501).json({ error: "Tags not available" });
    const { name, color } = req.body;
    if (!name) return res.status(400).json({ error: "name is required" });
    try {
      res.json({ tag: ctx.tagStore.createTag(name, color) });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  router.patch("/tags/:id", (req, res) => {
    if (!ctx.tagStore) return res.status(501).json({ error: "Tags not available" });
    try {
      const oldTag = ctx.tagStore.getTag(req.params.id);
      const tag = ctx.tagStore.updateTag(req.params.id, req.body);
      if (req.body.name !== undefined && oldTag && oldTag.name !== tag.name && ctx.docsStore) {
        const updated = ctx.docsStore.renameTagInDocs(oldTag.name, tag.name);
        if (updated > 0) {
          console.log(`[tags] Renamed tag in ${updated} doc(s): "${oldTag.name}" → "${tag.name}"`);
          ctx.docsIndex?.reindex();
        }
      }
      if (req.body.instructions !== undefined || req.body.name !== undefined) {
        console.log("[tags] Tag changed — evicting cached sessions");
        void ctx.sessionManager.evictAllCachedSessions();
      }
      res.json({ tag });
    } catch (err) {
      if (err instanceof InvalidTagColorError) return res.status(400).json({ error: err.message });
      res.status(404).json({ error: String(err) });
    }
  });

  router.delete("/tags/:id", (req, res) => {
    if (!ctx.tagStore) return res.status(501).json({ error: "Tags not available" });
    if (!ctx.tagStore.deleteTag(req.params.id)) return res.status(404).json({ error: `Tag ${req.params.id} not found` });
    console.log("[tags] Tag deleted — evicting cached sessions");
    void ctx.sessionManager.evictAllCachedSessions();
    res.json({ success: true });
  });

  router.put("/tags/reorder", (req, res) => {
    if (!ctx.tagStore) return res.status(501).json({ error: "Tags not available" });
    const { tagIds } = req.body;
    if (!Array.isArray(tagIds)) return res.status(400).json({ error: "tagIds array is required" });
    try {
      res.json({ tags: ctx.tagStore.reorderTags(tagIds) });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  router.get("/tags/:id/mcp", (req, res) => {
    if (!ctx.tagStore) return res.status(501).json({ error: "Tags not available" });
    res.json({ servers: ctx.tagStore.getTagMcpServers(req.params.id) });
  });

  router.put("/tags/:id/mcp-servers", (req, res) => {
    if (!ctx.tagStore) return res.status(501).json({ error: "Tags not available" });
    const serverIds = isRecord(req.body) ? req.body.serverIds : undefined;
    if (!Array.isArray(serverIds) || !serverIds.every((id) => typeof id === "string")) {
      return res.status(400).json({ error: "serverIds array is required" });
    }
    try {
      const servers = ctx.tagStore.replaceTagMcpServerRefs(req.params.id, serverIds);
      console.log("[tags] Tag MCP server selection changed — evicting cached sessions");
      void ctx.sessionManager.evictAllCachedSessions();
      res.json({ servers });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  router.post("/tags/:id/mcp-refs/:serverId", (req, res) => {
    if (!ctx.tagStore) return res.status(501).json({ error: "Tags not available" });
    try {
      const server = ctx.tagStore.addTagMcpServerRef(req.params.id, req.params.serverId);
      console.log("[tags] Tag MCP server selection changed — evicting cached sessions");
      void ctx.sessionManager.evictAllCachedSessions();
      res.json({ server });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  router.delete("/tags/:id/mcp-refs/:serverId", (req, res) => {
    if (!ctx.tagStore) return res.status(501).json({ error: "Tags not available" });
    ctx.tagStore.removeTagMcpServerRef(req.params.id, req.params.serverId);
    console.log("[tags] Tag MCP server selection changed — evicting cached sessions");
    void ctx.sessionManager.evictAllCachedSessions();
    res.json({ success: true });
  });

  router.get("/tags/related-docs", (req, res) => {
    if (!ctx.tagStore || !ctx.docsIndex) return res.json({ docs: [] });
    const ids = (req.query.tags as string || "").split(",").filter(Boolean);
    if (ids.length === 0) return res.json({ docs: [] });
    const names = ids.map((id) => ctx.tagStore!.getTag(id)).filter(Boolean).map((tag) => tag!.name);
    res.json({ docs: ctx.docsIndex.findDocsByTagNames(names) });
  });

  router.put("/tasks/:id/tags", (req, res) => {
    if (!ctx.tagStore) return res.status(501).json({ error: "Tags not available" });
    const { tagIds } = req.body;
    if (!Array.isArray(tagIds)) return res.status(400).json({ error: "tagIds array is required" });
    try {
      ctx.tagStore.setEntityTags("task", req.params.id, tagIds);
      const tags = ctx.tagStore.getEntityTags("task", req.params.id);
      console.log("[tags] Task tags changed — evicting cached sessions");
      void ctx.sessionManager.evictAllCachedSessions();
      res.json({ tags });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  router.put("/task-groups/:id/tags", (req, res) => {
    if (!ctx.tagStore) return res.status(501).json({ error: "Tags not available" });
    const { tagIds } = req.body;
    if (!Array.isArray(tagIds)) return res.status(400).json({ error: "tagIds array is required" });
    try {
      ctx.tagStore.setEntityTags("task_group", req.params.id, tagIds);
      const tags = ctx.tagStore.getEntityTags("task_group", req.params.id);
      console.log("[tags] Group tags changed — evicting cached sessions");
      void ctx.sessionManager.evictAllCachedSessions();
      res.json({ tags });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });
}
