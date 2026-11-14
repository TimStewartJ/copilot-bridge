import type { Router } from "express";
import type { AppContext } from "./app-context.js";
import type { McpServerConfig } from "./mcp-config.js";
import { isRecord } from "../shared/is-record.js";
import { TaskGroupValidationError } from "./task-group-store.js";
import { InvalidTagColorError } from "./tag-store.js";
import { customizeSkill, deleteHomeSkill, isValidSkillId, readSkill, scanSkills, writeHomeSkill } from "./skills-registry.js";
import { runGit } from "./git-command.js";
import { isCanonicalSessionId } from "./outbound-attachments.js";
import { isValidSkillPackId } from "../shared/skill-packs.js";
import { describePlaybook, type PlaybookInfo } from "../shared/workflow-vocabulary.js";
import { join } from "node:path";

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
      // agent-text-audit: error (the Bridge's own error messages)
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
      // agent-text-audit: error (the Bridge's own error messages)
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

  const skillOptions = () => ({
    copilotHome: getCopilotHome(),
    packs: ctx.skillPacks?.activeRoots(undefined, { ignoreTags: true }) ?? [],
  });
  const usageByName = () => new Map((ctx.skillUsageStore?.list() ?? []).map((usage) => [usage.skillName, usage]));

  router.get("/skills", async (_req, res) => {
    try {
      const skills = ctx.skillCatalog ? await ctx.skillCatalog.refresh() : await scanSkills(skillOptions());
      const usage = usageByName();
      res.json({
        skills: skills.map((skill) => {
          const used = usage.get(skill.id) ?? usage.get(skill.name);
          return used ? { ...skill, useCount: used.useCount, lastUsedAt: used.lastUsedAt } : skill;
        }),
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/playbooks", async (_req, res) => {
    try {
      const skills = ctx.skillCatalog ? ctx.skillCatalog.current().length > 0 ? ctx.skillCatalog.current() : await ctx.skillCatalog.refresh() : await scanSkills(skillOptions());
      const playbooks: PlaybookInfo[] = skills
        .filter((skill) => skill.kind === "playbook")
        .map((skill) => ({
          id: skill.id,
          label: skill.label ?? skill.name,
          description: describePlaybook(skill.description),
          family: skill.family ?? "meta",
          evidence: skill.evidence,
          source: skill.source,
          ...(skill.packName ? { packName: skill.packName } : {}),
        }));
      res.json({ playbooks });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/skills/:id", async (req, res) => {
    if (!isValidSkillId(req.params.id)) return res.status(400).json({ error: "invalid skill id" });
    try {
      const skill = await readSkill(skillOptions(), req.params.id);
      if (!skill) return res.status(404).json({ error: "skill not found" });
      res.json({ skill });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.put("/skills/:id", async (req, res) => {
    if (!isValidSkillId(req.params.id)) return res.status(400).json({ error: "invalid skill id" });
    const raw = req.body?.raw;
    if (typeof raw !== "string") return res.status(400).json({ error: "raw must be the full SKILL.md text" });
    try {
      const result = await writeHomeSkill(skillOptions(), req.params.id, raw);
      if (result.status === "invalid") return res.status(400).json({ error: result.error });
      if (result.status !== "written") return res.status(404).json({ error: "Only skills in your home skills folder can be edited." });
      void ctx.skillCatalog?.refresh().catch(() => undefined);
      res.json({ skill: result.skill });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/skills/:id/customize", async (req, res) => {
    if (!isValidSkillId(req.params.id)) return res.status(400).json({ error: "invalid skill id" });
    try {
      const result = await customizeSkill(skillOptions(), req.params.id);
      if (result.status === "exists") return res.status(409).json({ error: "This skill already has a copy in your home skills folder." });
      if (result.status === "invalid") return res.status(400).json({ error: result.error });
      if (result.status !== "written") return res.status(404).json({ error: "skill not found" });
      void ctx.skillCatalog?.refresh().catch(() => undefined);
      res.json({ skill: result.skill });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/skills/:id/history", async (req, res) => {
    if (!isValidSkillId(req.params.id)) return res.status(400).json({ error: "invalid skill id" });
    try {
      const skill = await readSkill(skillOptions(), req.params.id);
      if (!skill) return res.status(404).json({ error: "skill not found" });
      const skillDir = join(skill.skillsDir, skill.id);
      const log = await runGit(skillDir, ["log", "-n", "20", "--format=%h%x09%cI%x09%s", "--", "SKILL.md"]);
      if (!log.ok) return res.json({ commits: [], tracked: false });
      const commits = log.output.split(/\r?\n/).filter(Boolean).map((line) => {
        const [hash, at, ...subject] = line.split("\t");
        return { hash: hash ?? "", at: at ?? "", subject: subject.join("\t") };
      });
      res.json({ commits, tracked: true });
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
      void ctx.skillCatalog?.refresh().catch(() => undefined);
      void ctx.sessionManager.evictAllCachedSessions();
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/skill-packs", async (_req, res) => {
    try {
      res.json({
        packs: ctx.settingsStore.getSettings().skillPacks ?? [],
        statuses: await ctx.skillPacks?.listStatuses() ?? [],
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/skill-packs/:id/sync", async (req, res) => {
    if (!ctx.skillPacks) return res.status(501).json({ error: "Skill packs are not available" });
    if (!isValidSkillPackId(req.params.id)) return res.status(400).json({ error: "invalid pack id" });
    try {
      const status = await ctx.skillPacks.sync(req.params.id);
      res.json({ status });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // agent-text-audit: error (the Bridge's own error messages)
      res.status(/not configured/i.test(message) ? 404 : 500).json({ error: message });
    }
  });

  router.get("/unattended-runs", (_req, res) => {
    const store = ctx.unattendedRunStore;
    if (!store) return res.json({ runs: [] });
    const runs = store.list().flatMap((run) => {
      const state = ctx.bridgeSessionStateStore?.getState(run.sessionId);
      if (state?.archived) return [];
      const task = ctx.taskStore.findTaskBySessionId(run.sessionId);
      return [{
        ...run,
        ...(task ? { taskId: task.id, taskTitle: task.title } : {}),
        ...(state?.titleOverride ? { title: state.titleOverride } : {}),
      }];
    });
    res.json({ runs });
  });

  // Asks the chat to review its unattended turns with a reviewer on a different model family.
  router.post("/unattended-runs/:sessionId/review", (req, res) => {
    const sessionId = req.params.sessionId;
    if (!isCanonicalSessionId(sessionId)) return res.status(400).json({ error: "Valid sessionId is required" });
    if (!ctx.unattendedRunStore?.list().some((run) => run.sessionId === sessionId)) {
      return res.status(404).json({ error: "Nothing ran unattended in this chat." });
    }
    try {
      ctx.sessionManager.startWork(sessionId, "/review-unattended");
      res.json({ success: true });
    } catch (err) {
      res.status(409).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.delete("/unattended-runs/:sessionId", (req, res) => {
    const sessionId = req.params.sessionId;
    if (!isCanonicalSessionId(sessionId)) return res.status(400).json({ error: "Valid sessionId is required" });
    ctx.unattendedRunStore?.clear(sessionId);
    res.json({ success: true });
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
