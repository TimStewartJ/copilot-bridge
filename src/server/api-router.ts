// API route handlers — extracted from index.ts for modularity

import express from "express";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { AppContext } from "./app-context.js";
import { isRestartPending, getRestartWaitingCount, clearRestartPending } from "./session-manager.js";
import * as scheduler from "./scheduler.js";
import { enrichWorkItems, enrichPullRequests, clearProviderCache, setSettingsGetter } from "./providers/index.js";

function getDirSize(dirPath: string): number {
  let size = 0;
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        size += getDirSize(fullPath);
      } else {
        size += statSync(fullPath).size;
      }
    }
  } catch { /* ignore errors */ }
  return size;
}

/** Resolve the .copilot home directory — uses ctx.copilotHome if set, otherwise homedir()/.copilot */
function getCopilotHome(ctx: AppContext): string {
  return ctx.copilotHome ?? join(homedir(), ".copilot");
}

export function createApiRouter(ctx: AppContext): express.Router {
  const router = express.Router();

  // Wire settings getter for providers (so they can resolve without module-level imports)
  setSettingsGetter(() => ctx.settingsStore.getSettings());

  // ── Enriched session list cache ─────────────────────────────────
  // Caches the expensive enriched session list (disk sizes, plan checks, metadata).
  // Invalidated by session create/delete/archive and globalBus events.
  // Disk sizes are stored separately so skipDiskSize requests don't zero them out.
  let enrichedSessionCache: { data: any[]; timestamp: number } | null = null;
  const diskSizeCache = new Map<string, number>();
  const ENRICHED_CACHE_TTL = 30_000; // 30 seconds

  function invalidateEnrichedCache() {
    enrichedSessionCache = null;
  }

  // Invalidate on session lifecycle events
  ctx.globalBus.subscribe((event: any) => {
    switch (event.type) {
      case "session:title":
      case "session:archived":
        invalidateEnrichedCache();
        break;
    }
  });

  // ── Session routes ──────────────────────────────────────────────

  router.get("/sessions", async (req, res) => {
    try {
      const includeArchived = req.query.includeArchived === "true";
      const skipDiskSize = req.query.skipDiskSize === "true";

      const now = Date.now();
      const cacheValid = enrichedSessionCache && (now - enrichedSessionCache.timestamp) < ENRICHED_CACHE_TTL;

      if (cacheValid) {
        // Serve from cache — only refresh volatile fields (busy status)
        const cached = enrichedSessionCache!.data.map((s: any) => ({
          ...s,
          diskSizeBytes: diskSizeCache.get(s.sessionId) ?? 0,
          busy: ctx.sessionManager.isSessionBusy(s.sessionId),
        }));
        const filtered = cached.filter((s: any) => includeArchived || !s.archived);
        return res.json({ sessions: filtered });
      }

      // Cache miss — rebuild
      const sessions = await ctx.sessionManager.listSessions();
      const sessionStateDir = join(getCopilotHome(ctx), "session-state");
      const meta = ctx.sessionMetaStore.listMeta();

      const enriched = sessions
        .filter((s: any) => s.summary)
        .filter((s: any) => !s.summary?.startsWith("Generate a concise"))
        .map((s: any) => {
          const id = s.sessionId;
          const archived = meta[id]?.archived === true;

          // Compute disk size: skip on polling, use cached for archived, compute for active
          if (!skipDiskSize && !archived) {
            try {
              const sessionDir = join(sessionStateDir, id);
              diskSizeCache.set(id, getDirSize(sessionDir));
            } catch { /* session dir may not exist */ }
          }

          const hasPlan = existsSync(join(sessionStateDir, id, "plan.md"));
          const archivedAt = meta[id]?.archivedAt ?? null;
          const generatedTitle = ctx.sessionTitles.getTitle(id);
          const summary = generatedTitle ?? s.summary;
          return {
            ...s,
            summary,
            diskSizeBytes: diskSizeCache.get(id) ?? 0,
            busy: ctx.sessionManager.isSessionBusy(id),
            hasPlan,
            archived,
            archivedAt,
            triggeredBy: meta[id]?.triggeredBy,
            scheduleId: meta[id]?.scheduleId,
            scheduleName: meta[id]?.scheduleName,
            scheduleEnabled: meta[id]?.scheduleId
              ? (ctx.scheduleStore.getSchedule(meta[id]!.scheduleId!)?.enabled ?? false)
              : undefined,
          };
        });

      // Update cache (store all sessions, filter happens on read)
      enrichedSessionCache = { data: enriched, timestamp: now };

      const filtered = enriched.filter((s: any) => includeArchived || !s.archived);
      res.json({ sessions: filtered });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.get("/busy", (_req, res) => {
    const sessions = ctx.sessionManager.getSessionActivity();
    res.json({
      busy: sessions.length > 0,
      count: sessions.length,
      sessionIds: sessions.map((s) => s.id),
      sessions,
    });
  });

  // POST /shutdown — graceful shutdown: abort active sessions, stop SDK, exit
  router.post("/shutdown", async (_req, res) => {
    if (ctx.isStaging) return res.status(404).json({ error: "Not available in staging" });
    console.log("[web] Graceful shutdown requested via API");
    res.json({ ok: true, message: "Shutting down..." });
    try {
      scheduler.shutdown();
      await ctx.sessionManager.gracefulShutdown();
    } catch (err) {
      console.error("[web] Error during graceful shutdown:", err);
    }
    process.exit(0);
  });

  // POST /restart-clear — manual escape hatch to dismiss a stale restart banner
  router.post("/restart-clear", (_req, res) => {
    if (ctx.isStaging) return res.status(404).json({ error: "Not available in staging" });
    clearRestartPending();
    res.json({ ok: true });
  });

  // GET /status-stream — global SSE for session lifecycle events
  router.get("/status-stream", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    let closed = false;

    const heartbeat = setInterval(() => {
      if (closed || res.writableEnded) return;
      try { res.write(`: heartbeat\n\n`); } catch { close(); }
    }, 15_000);

    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsub();
      if (!res.writableEnded) res.end();
    };

    const unsub = ctx.globalBus.subscribe((event) => {
      if (closed || res.writableEnded) return;
      try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch { close(); }
    });

    // Send authoritative restart state so clients don't have to guess
    if (isRestartPending()) {
      const count = getRestartWaitingCount();
      try { res.write(`data: ${JSON.stringify({ type: "server:restart-pending", waitingSessions: count })}\n\n`); }
      catch { close(); }
    } else {
      try { res.write(`data: ${JSON.stringify({ type: "server:restart-cleared" })}\n\n`); }
      catch { close(); }
    }

    res.on("error", () => { close(); });
    req.on("close", () => { close(); });
  });

  router.get("/sessions/:id/messages", async (req, res) => {
    try {
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
      const before = req.query.before ? parseInt(req.query.before as string, 10) : undefined;
      const { messages, total, hasMore } = await ctx.sessionManager.getSessionMessages(
        req.params.id,
        { limit, before },
      );
      const busy = ctx.sessionManager.isSessionBusy(req.params.id);
      res.json({ messages, busy, total, hasMore });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/sessions", async (req, res) => {
    try {
      const { name } = req.body ?? {};
      const result = await ctx.sessionManager.createSession();
      invalidateEnrichedCache();
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /sessions/:id/duplicate — duplicate an existing session
  router.post("/sessions/:id/duplicate", async (req, res) => {
    const sourceId = req.params.id;
    try {
      if (ctx.sessionManager.isSessionBusy(sourceId)) {
        return res.status(409).json({ error: "Cannot duplicate a busy session" });
      }
      const result = await ctx.sessionManager.duplicateSession(sourceId);
      invalidateEnrichedCache();

      // Copy title with "Copy of" prefix
      const originalTitle = ctx.sessionTitles.getTitle(sourceId);
      if (originalTitle) {
        ctx.sessionTitles.setTitle(result.sessionId, `Copy of ${originalTitle}`);
      }

      // Copy task links if the source session was linked to a task
      const linkedTask = ctx.taskStore.findTaskBySessionId(sourceId);
      if (linkedTask) {
        ctx.taskStore.linkSession(linkedTask.id, result.sessionId);
      }

      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /chat — fire and forget, starts work in background
  router.post("/chat", (req, res) => {
    const { sessionId, prompt, attachments } = req.body;

    if (!sessionId || !prompt) {
      return res.status(400).json({ error: "sessionId and prompt are required" });
    }

    if (ctx.sessionManager.isSessionBusy(sessionId)) {
      return res.status(429).json({ error: "Session is busy, please wait" });
    }

    // Auto-unarchive if user sends a message to an archived session
    const meta = ctx.sessionMetaStore.getMeta(sessionId);
    if (meta?.archived) {
      ctx.sessionMetaStore.setArchived(sessionId, false);
      ctx.globalBus.emit({ type: "session:archived", sessionId, archived: false });
      console.log(`[web] [${sessionId.slice(0, 8)}] auto-unarchived (user sent message)`);
    }

    const attachCount = Array.isArray(attachments) ? attachments.length : 0;
    console.log(`[web] [${sessionId.slice(0, 8)}] "${prompt.slice(0, 80)}"${attachCount ? ` (+${attachCount} attachment${attachCount > 1 ? "s" : ""})` : ""}`);

    try {
      ctx.sessionManager.startWork(sessionId, prompt, attachments);
      res.status(202).json({ status: "accepted" });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /sessions/:id/abort — abort an in-progress session turn
  router.post("/sessions/:id/abort", async (req, res) => {
    const sessionId = req.params.id;
    try {
      const aborted = await ctx.sessionManager.abortSession(sessionId);
      if (aborted) {
        res.json({ status: "aborted" });
      } else {
        res.status(409).json({ error: "Session is not busy" });
      }
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /sessions/:id/stream — SSE stream with snapshot + live events
  router.get("/sessions/:id/stream", (req, res) => {
    const sessionId = req.params.id;

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    let closed = false;
    let unsub: (() => void) | null = null;

    // SSE heartbeat — keeps connection alive through proxies/tunnels
    const heartbeat = setInterval(() => {
      if (closed || res.writableEnded) return;
      try {
        res.write(`: heartbeat\n\n`);
      } catch {
        close();
      }
    }, 15_000);

    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      if (unsub) unsub();
      if (!res.writableEnded) res.end();
    };

    const sendEvent = (event: any) => {
      if (closed || res.writableEnded) return;
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        close();
        return;
      }
      if (event.type === "done" || event.type === "error" || event.type === "aborted") {
        close();
      }
    };

    // Prevent unhandled 'error' events on the response from crashing the process
    res.on("error", () => { close(); });
    req.on("close", () => { close(); });

    const bus = ctx.eventBusRegistry.getBus(sessionId);

    if (!bus) {
      if (ctx.sessionManager.isSessionBusy(sessionId)) {
        sendEvent({ type: "thinking" });
        // Poll for bus — it should appear shortly after POST /api/chat
        const pollStart = Date.now();
        const waitForBus = setInterval(() => {
          if (closed) { clearInterval(waitForBus); return; }
          const newBus = ctx.eventBusRegistry.getBus(sessionId);
          if (newBus) {
            clearInterval(waitForBus);
            unsub = newBus.subscribe(sendEvent);
          } else if (Date.now() - pollStart > 10_000) {
            clearInterval(waitForBus);
            sendEvent({ type: "error", message: "Timed out waiting for session to start" });
          }
        }, 500);
      } else {
        sendEvent({ type: "idle" });
        close();
      }
      return;
    }

    // Subscribe — sends snapshot then streams live events
    unsub = bus.subscribe(sendEvent);
  });

  // GET /sessions/:id/plan — read plan.md from session state directory
  router.get("/sessions/:id/plan", (_req, res) => {
    const sessionId = _req.params.id;
    const planPath = join(getCopilotHome(ctx), "session-state", sessionId, "plan.md");

    try {
      if (!existsSync(planPath)) {
        return res.json({ content: null, lastModified: null });
      }
      const content = readFileSync(planPath, "utf-8");
      const lastModified = statSync(planPath).mtime.toISOString();
      res.json({ content, lastModified });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /sessions/:id/mcp-status — get MCP server connection status for a session
  router.get("/sessions/:id/mcp-status", async (req, res) => {
    try {
      const servers = await ctx.sessionManager.getMcpStatus(req.params.id);
      res.json({ servers });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // PATCH /sessions/:id — update session metadata (archive/unarchive)
  router.patch("/sessions/:id", (req, res) => {
    const { archived } = req.body;
    if (typeof archived !== "boolean") {
      return res.status(400).json({ error: "archived (boolean) is required" });
    }
    try {
      ctx.sessionMetaStore.setArchived(req.params.id, archived);
      ctx.globalBus.emit({ type: "session:archived", sessionId: req.params.id, archived });
      res.json({ ok: true, archived });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // DELETE /sessions/:id — permanently delete a session
  router.delete("/sessions/:id", async (req, res) => {
    const sessionId = req.params.id;
    try {
      await ctx.sessionManager.deleteSession(sessionId);
      invalidateEnrichedCache();
      ctx.sessionMetaStore.deleteMeta(sessionId);
      ctx.sessionTitles.deleteTitle(sessionId);
      // Unlink from any tasks that reference this session
      const tasks = ctx.taskStore.listTasks();
      for (const task of tasks) {
        if (task.sessionIds.includes(sessionId)) {
          ctx.taskStore.unlinkSession(task.id, sessionId);
        }
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /sessions/batch — bulk actions on multiple sessions
  router.post("/sessions/batch", async (req, res) => {
    const { action, sessionIds } = req.body;
    const validActions = ["archive", "unarchive", "delete", "markRead"];
    if (!validActions.includes(action)) {
      return res.status(400).json({ error: `action must be one of: ${validActions.join(", ")}` });
    }
    if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
      return res.status(400).json({ error: "sessionIds array is required" });
    }
    const errors: Record<string, string> = {};
    for (const sid of sessionIds) {
      try {
        switch (action) {
          case "archive":
            ctx.sessionMetaStore.setArchived(sid, true);
            break;
          case "unarchive":
            ctx.sessionMetaStore.setArchived(sid, false);
            break;
          case "delete": {
            await ctx.sessionManager.deleteSession(sid);
            invalidateEnrichedCache();
            ctx.sessionMetaStore.deleteMeta(sid);
            ctx.sessionTitles.deleteTitle(sid);
            const tasks = ctx.taskStore.listTasks();
            for (const task of tasks) {
              if (task.sessionIds.includes(sid)) {
                ctx.taskStore.unlinkSession(task.id, sid);
              }
            }
            break;
          }
          case "markRead":
            ctx.readStateStore.markRead(sid);
            break;
        }
      } catch (err) {
        errors[sid] = String(err);
      }
    }
    if (action === "markRead" && sessionIds.length > 0) {
      ctx.globalBus.emit({ type: "readstate:changed", readState: ctx.readStateStore.getReadState() });
    }
    res.json({ ok: Object.keys(errors).length === 0, errors });
  });

  // ── Task Group routes ─────────────────────────────────────────────

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
      res.status(404).json({ error: String(err) });
    }
  });

  router.delete("/task-groups/:id", (req, res) => {
    // Ungroup any tasks that belong to this group
    const tasks = ctx.taskStore.listTasks().filter((t) => t.groupId === req.params.id);
    for (const t of tasks) ctx.taskStore.updateTask(t.id, { groupId: undefined });
    ctx.tagStore?.setEntityTags("task_group", req.params.id, []);
    ctx.taskGroupStore.deleteGroup(req.params.id);
    res.json({ success: true });
  });

  router.put("/task-groups/reorder", (req, res) => {
    const { groupIds } = req.body;
    if (!Array.isArray(groupIds)) return res.status(400).json({ error: "groupIds array is required" });
    try {
      const groups = ctx.taskGroupStore.reorderGroups(groupIds);
      res.json({ groups });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  // ── Tag routes ──────────────────────────────────────────────────

  router.get("/tags", (_req, res) => {
    res.json({ tags: ctx.tagStore?.listTags() ?? [] });
  });

  router.post("/tags", (req, res) => {
    if (!ctx.tagStore) return res.status(501).json({ error: "Tags not available" });
    const { name, color } = req.body;
    if (!name) return res.status(400).json({ error: "name is required" });
    try {
      const tag = ctx.tagStore.createTag(name, color);
      res.json({ tag });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  router.patch("/tags/:id", (req, res) => {
    if (!ctx.tagStore) return res.status(501).json({ error: "Tags not available" });
    try {
      // Capture old name before update for doc tag rename propagation
      const oldTag = ctx.tagStore.getTag(req.params.id);
      const tag = ctx.tagStore.updateTag(req.params.id, req.body);

      // Propagate tag rename to doc frontmatter
      if (req.body.name !== undefined && oldTag && oldTag.name !== tag.name && ctx.docsStore) {
        const updated = ctx.docsStore.renameTagInDocs(oldTag.name, tag.name);
        if (updated > 0) {
          console.log(`[tags] Renamed tag in ${updated} doc(s): "${oldTag.name}" → "${tag.name}"`);
          ctx.docsIndex?.reindex();
        }
      }

      // Evict cached sessions if name or instructions changed
      if (req.body.instructions !== undefined || req.body.name !== undefined) {
        console.log("[tags] Tag changed — evicting cached sessions");
        ctx.sessionManager.evictAllCachedSessions();
      }
      res.json({ tag });
    } catch (err) {
      res.status(404).json({ error: String(err) });
    }
  });

  router.delete("/tags/:id", (req, res) => {
    if (!ctx.tagStore) return res.status(501).json({ error: "Tags not available" });
    ctx.tagStore.deleteTag(req.params.id);
    console.log("[tags] Tag deleted — evicting cached sessions");
    ctx.sessionManager.evictAllCachedSessions();
    res.json({ success: true });
  });

  router.put("/tags/reorder", (req, res) => {
    if (!ctx.tagStore) return res.status(501).json({ error: "Tags not available" });
    const { tagIds } = req.body;
    if (!Array.isArray(tagIds)) return res.status(400).json({ error: "tagIds array is required" });
    try {
      const tags = ctx.tagStore.reorderTags(tagIds);
      res.json({ tags });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  // Tag MCP servers
  router.get("/tags/:id/mcp", (req, res) => {
    if (!ctx.tagStore) return res.status(501).json({ error: "Tags not available" });
    res.json({ servers: ctx.tagStore.getTagMcpServers(req.params.id) });
  });

  router.put("/tags/:id/mcp/:serverName", (req, res) => {
    if (!ctx.tagStore) return res.status(501).json({ error: "Tags not available" });
    try {
      ctx.tagStore.setTagMcpServer(req.params.id, req.params.serverName, req.body);
      console.log("[tags] Tag MCP server changed — evicting cached sessions");
      ctx.sessionManager.evictAllCachedSessions();
      res.json({ success: true });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  router.delete("/tags/:id/mcp/:serverName", (req, res) => {
    if (!ctx.tagStore) return res.status(501).json({ error: "Tags not available" });
    ctx.tagStore.removeTagMcpServer(req.params.id, req.params.serverName);
    console.log("[tags] Tag MCP server removed — evicting cached sessions");
    ctx.sessionManager.evictAllCachedSessions();
    res.json({ success: true });
  });

  // Related docs by tag
  router.get("/tags/related-docs", (req, res) => {
    if (!ctx.tagStore || !ctx.docsIndex) return res.json({ docs: [] });
    const tagIds = (req.query.tags as string || "").split(",").filter(Boolean);
    if (tagIds.length === 0) return res.json({ docs: [] });
    const tagNames = tagIds
      .map((id) => ctx.tagStore!.getTag(id))
      .filter(Boolean)
      .map((t) => t!.name);
    const docs = ctx.docsIndex.findDocsByTagNames(tagNames);
    res.json({ docs });
  });

  // Set tags on a task
  router.put("/tasks/:id/tags", (req, res) => {
    if (!ctx.tagStore) return res.status(501).json({ error: "Tags not available" });
    const { tagIds } = req.body;
    if (!Array.isArray(tagIds)) return res.status(400).json({ error: "tagIds array is required" });
    try {
      ctx.tagStore.setEntityTags("task", req.params.id, tagIds);
      const tags = ctx.tagStore.getEntityTags("task", req.params.id);
      console.log("[tags] Task tags changed — evicting cached sessions");
      ctx.sessionManager.evictAllCachedSessions();
      res.json({ tags });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  // Set tags on a task group
  router.put("/task-groups/:id/tags", (req, res) => {
    if (!ctx.tagStore) return res.status(501).json({ error: "Tags not available" });
    const { tagIds } = req.body;
    if (!Array.isArray(tagIds)) return res.status(400).json({ error: "tagIds array is required" });
    try {
      ctx.tagStore.setEntityTags("task_group", req.params.id, tagIds);
      const tags = ctx.tagStore.getEntityTags("task_group", req.params.id);
      console.log("[tags] Group tags changed — evicting cached sessions");
      ctx.sessionManager.evictAllCachedSessions();
      res.json({ tags });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  // ── Task routes ───────────────────────────────────────────────────

  router.get("/tasks", (_req, res) => {
    const tasks = ctx.taskStore.listTasks();
    const tasksWithTags = tasks.map((t) => ({
      ...t,
      tags: ctx.tagStore?.getEntityTags("task", t.id) ?? [],
    }));
    res.json({ tasks: tasksWithTags });
  });

  router.put("/tasks/reorder", (req, res) => {
    const { taskIds } = req.body;
    if (!Array.isArray(taskIds)) return res.status(400).json({ error: "taskIds array is required" });
    try {
      const tasks = ctx.taskStore.reorderTasks(taskIds);
      res.json({ tasks });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  router.post("/tasks", (req, res) => {
    const { title, groupId } = req.body;
    if (!title) return res.status(400).json({ error: "title is required" });
    try {
      const task = ctx.taskStore.createTask(title, groupId);
      res.json({ task });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.get("/tasks/:id", (req, res) => {
    const task = ctx.taskStore.getTask(req.params.id);
    if (!task) return res.status(404).json({ error: "Task not found" });
    const tags = ctx.tagStore?.getEntityTags("task", task.id) ?? [];
    res.json({ task: { ...task, tags } });
  });

  // Enriched task data — fetches work item + PR metadata from configured providers
  router.get("/tasks/:id/enriched", async (req, res) => {
    const task = ctx.taskStore.getTask(req.params.id);
    if (!task) return res.status(404).json({ error: "Task not found" });

    try {
      const [workItems, pullRequests] = await Promise.all([
        enrichWorkItems(task.workItems),
        enrichPullRequests(task.pullRequests),
      ]);
      res.json({ task, workItems, pullRequests });
    } catch (err) {
      console.error("[enriched] Error:", err);
      res.json({ task, workItems: [], pullRequests: [] });
    }
  });

  router.patch("/tasks/:id", (req, res) => {
    try {
      const task = ctx.taskStore.updateTask(req.params.id, req.body);
      res.json({ task });
    } catch (err) {
      res.status(404).json({ error: String(err) });
    }
  });

  router.delete("/tasks/:id", (req, res) => {
    ctx.tagStore?.setEntityTags("task", req.params.id, []);
    ctx.taskStore.deleteTask(req.params.id);
    res.json({ ok: true });
  });

  router.post("/tasks/:id/link", (req, res) => {
    const { type, sessionId, workItemId, provider, repoId, repoName, prId } = req.body;
    try {
      let task;
      switch (type) {
        case "session":
          task = ctx.taskStore.linkSession(req.params.id, sessionId);
          break;
        case "workItem":
          task = ctx.taskStore.linkWorkItem(req.params.id, Number(workItemId), provider ?? "ado");
          break;
        case "pr":
          task = ctx.taskStore.linkPR(req.params.id, { repoId, repoName, prId: Number(prId), provider: provider ?? "ado" });
          break;
        default:
          return res.status(400).json({ error: `Unknown link type: ${type}` });
      }
      res.json({ task });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  router.delete("/tasks/:id/link", (req, res) => {
    const { type, sessionId, workItemId, provider, repoId, prId } = req.body;
    try {
      let task;
      switch (type) {
        case "session":
          task = ctx.taskStore.unlinkSession(req.params.id, sessionId);
          break;
        case "workItem":
          task = ctx.taskStore.unlinkWorkItem(req.params.id, Number(workItemId), provider);
          break;
        case "pr":
          task = ctx.taskStore.unlinkPR(req.params.id, repoId, Number(prId), provider);
          break;
        default:
          return res.status(400).json({ error: `Unknown link type: ${type}` });
      }
      res.json({ task });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  // Create a session linked to a task with pre-loaded context
  router.post("/tasks/:id/session", async (req, res) => {
    const task = ctx.taskStore.getTask(req.params.id);
    if (!task) return res.status(404).json({ error: "Task not found" });

    try {
      const prDescriptions = task.pullRequests.map(
        (pr) => `${pr.repoName || pr.repoId} PR #${pr.prId}`,
      );
      const group = task.groupId ? ctx.taskGroupStore.getGroup(task.groupId) : undefined;
      const groupNotes = group?.notes?.trim() ? { groupName: group.name, notes: group.notes } : null;
      const result = await ctx.sessionManager.createTaskSession(
        task.id,
        task.title,
        task.workItems,
        prDescriptions,
        task.notes,
        task.cwd,
        undefined,
        groupNotes,
      );
      invalidateEnrichedCache();

      // Auto-link session to task
      ctx.taskStore.linkSession(task.id, result.sessionId);

      res.json(result);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Todo routes ──────────────────────────────────────────────────

  router.get("/tasks/:taskId/todos", (req, res) => {
    res.json({ todos: ctx.todoStore.listTodos(req.params.taskId) });
  });

  router.post("/tasks/:taskId/todos", (req, res) => {
    const { text, deadline } = req.body;
    if (!text) return res.status(400).json({ error: "text is required" });
    try {
      const todo = ctx.todoStore.createTodo(req.params.taskId, text, deadline);
      res.json({ todo });
    } catch (err) {
      res.status(404).json({ error: String(err) });
    }
  });

  router.post("/todos", (req, res) => {
    const { text, deadline } = req.body;
    if (!text) return res.status(400).json({ error: "text is required" });
    try {
      const todo = ctx.todoStore.createTodo(null, text, deadline);
      res.json({ todo });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.patch("/todos/:id", (req, res) => {
    try {
      const todo = ctx.todoStore.updateTodo(req.params.id, req.body);
      res.json({ todo });
    } catch (err) {
      res.status(404).json({ error: String(err) });
    }
  });

  router.delete("/todos/:id", (req, res) => {
    ctx.todoStore.deleteTodo(req.params.id);
    res.json({ ok: true });
  });

  router.put("/tasks/:taskId/todos/reorder", (req, res) => {
    const { todoIds } = req.body;
    if (!Array.isArray(todoIds)) return res.status(400).json({ error: "todoIds array is required" });
    const todos = ctx.todoStore.reorderTodos(req.params.taskId, todoIds);
    res.json({ todos });
  });

  router.get("/todos/open", (_req, res) => {
    res.json({ todos: ctx.todoStore.listAllOpen() });
  });

  // ── Read State routes ─────────────────────────────────────────────

  router.get("/read-state", (_req, res) => {
    res.json(ctx.readStateStore.getReadState());
  });

  router.post("/read-state/:sessionId", (req, res) => {
    const ts = ctx.readStateStore.markRead(req.params.sessionId);
    ctx.globalBus.emit({ type: "readstate:changed", readState: ctx.readStateStore.getReadState() });
    res.json({ ok: true, lastReadAt: ts });
  });

  router.delete("/read-state/:sessionId", (req, res) => {
    ctx.readStateStore.markUnread(req.params.sessionId);
    ctx.globalBus.emit({ type: "readstate:changed", readState: ctx.readStateStore.getReadState() });
    res.json({ ok: true });
  });

  // ── Dashboard endpoint ───────────────────────────────────────────

  router.get("/dashboard", async (_req, res) => {
    try {
      const sessions = await ctx.sessionManager.listSessions();
      const sessionStateDir = join(getCopilotHome(ctx), "session-state");
      const meta = ctx.sessionMetaStore.listMeta();
      const readState = ctx.readStateStore.getReadState();
      const tasks = ctx.taskStore.listTasks();
      const taskSessionIds = new Set(tasks.flatMap((t) => t.sessionIds));

      // Enrich sessions (lightweight — skip disk size for dashboard)
      const enrichedSessions = sessions
        .filter((s: any) => s.summary)
        .filter((s: any) => !s.summary?.startsWith("Generate a concise")) // hide leaked title-generation sessions
        .map((s: any) => {
          const id = s.sessionId;
          const archived = meta[id]?.archived === true;
          const generatedTitle = ctx.sessionTitles.getTitle(id);
          const summary = generatedTitle ?? s.summary;
          const busy = ctx.sessionManager.isSessionBusy(id);
          const hasPlan = existsSync(join(sessionStateDir, id, "plan.md"));
          return { ...s, summary, busy, hasPlan, archived };
        })
        .filter((s: any) => !s.archived);

      const sessionById = new Map(enrichedSessions.map((s: any) => [s.sessionId, s]));

      // Helper: is session unread?
      const isUnread = (sessionId: string, modifiedTime?: string): boolean => {
        if (!modifiedTime) return false;
        const lastRead = readState[sessionId];
        if (!lastRead) return true;
        return new Date(modifiedTime).getTime() > new Date(lastRead).getTime();
      };

      // Busy sessions
      const busySessions = enrichedSessions
        .filter((s: any) => s.busy)
        .map((s: any) => {
          const taskId = tasks.find((t) => t.sessionIds.includes(s.sessionId))?.id;
          const bus = ctx.eventBusRegistry.getBus(s.sessionId);
          return {
            sessionId: s.sessionId,
            title: s.summary,
            taskId: taskId ?? null,
            intentText: bus?.getIntentText() ?? null,
          };
        });

      // Unread sessions (not busy — busy is separate)
      const unreadSessions = enrichedSessions
        .filter((s: any) => !s.busy && isUnread(s.sessionId, s.modifiedTime))
        .map((s: any) => {
          const taskId = tasks.find((t) => t.sessionIds.includes(s.sessionId))?.id;
          return {
            sessionId: s.sessionId,
            title: s.summary,
            taskId: taskId ?? null,
            modifiedTime: s.modifiedTime,
          };
        });

      // Active + paused tasks with enrichment
      const inFlightTasks = tasks.filter((t) => t.status === "active" || t.status === "paused");

      // Batch-fetch all work items across all in-flight tasks
      const allWorkItemRefs = inFlightTasks.flatMap((t) => t.workItems);
      const uniqueWIRefs = allWorkItemRefs.filter((ref, i, arr) =>
        arr.findIndex((r) => r.id === ref.id && r.provider === ref.provider) === i,
      );
      const allPRs = inFlightTasks.flatMap((t) => t.pullRequests);
      const uniquePRs = allPRs.filter((pr, i, arr) =>
        arr.findIndex((p) => p.repoId === pr.repoId && p.prId === pr.prId && p.provider === pr.provider) === i,
      );

      const [allWorkItems, allEnrichedPRs] = await Promise.all([
        enrichWorkItems(uniqueWIRefs),
        enrichPullRequests(uniquePRs),
      ]);

      const wiMap = new Map(allWorkItems.map((wi) => [`${wi.provider}:${wi.id}`, wi]));
      const prMap = new Map(allEnrichedPRs.map((pr) => [`${pr.provider}:${pr.repoId}:${pr.prId}`, pr]));

      const activeTasks = inFlightTasks.map((task) => {
        // Work item state summary
        const byState: Record<string, number> = {};
        for (const wiRef of task.workItems) {
          const wi = wiMap.get(`${wiRef.provider}:${wiRef.id}`);
          const state = wi?.state ?? "Unknown";
          byState[state] = (byState[state] ?? 0) + 1;
        }

        // PR status summary
        let prActive = 0;
        let prCompleted = 0;
        for (const pr of task.pullRequests) {
          const enriched = prMap.get(`${pr.provider}:${pr.repoId}:${pr.prId}`);
          if (enriched?.status === "active") prActive++;
          else if (enriched?.status === "completed") prCompleted++;
        }

        // Unread check — busy sessions excluded (busy is a separate signal)
        const hasUnread = task.sessionIds.some((sid) => {
          const session = sessionById.get(sid);
          return session && !session.busy && isUnread(sid, session.modifiedTime);
        });

        // Last activity across task sessions
        const sessionTimes = task.sessionIds
          .map((sid) => sessionById.get(sid)?.modifiedTime)
          .filter(Boolean) as string[];
        const lastActivity = sessionTimes.length > 0
          ? sessionTimes.sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0]
          : task.updatedAt;

        // Has busy session?
        const hasBusySession = task.sessionIds.some((sid) =>
          sessionById.get(sid)?.busy,
        );

        // Todo summary
        const todos = ctx.todoStore.listTodos(task.id);
        const todoDone = todos.filter((t) => t.done).length;
        const today = new Date().toISOString().slice(0, 10);
        const todoOverdue = todos.filter((t) => !t.done && t.deadline && t.deadline < today).length;

        return {
          task,
          workItemSummary: { total: task.workItems.length, byState },
          prSummary: { total: task.pullRequests.length, active: prActive, completed: prCompleted },
          todoSummary: { total: todos.length, done: todoDone, open: todos.length - todoDone, overdue: todoOverdue },
          hasUnread,
          hasBusySession,
          lastActivity,
        };
      });

      // Sort: unread first, then busy, then most recent
      activeTasks.sort((a, b) => {
        if (a.hasUnread !== b.hasUnread) return a.hasUnread ? -1 : 1;
        if (a.hasBusySession !== b.hasBusySession) return a.hasBusySession ? -1 : 1;
        return new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime();
      });

      // Last active task (most recently updated active task)
      const lastActiveTask = activeTasks.find((t) => t.task.status === "active") ?? null;

      // Orphan sessions: not linked to any task, unread or active in last 24h
      const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
      const orphanSessions = enrichedSessions
        .filter((s: any) => {
          if (taskSessionIds.has(s.sessionId)) return false;
          const unread = isUnread(s.sessionId, s.modifiedTime);
          const recent = s.modifiedTime && new Date(s.modifiedTime).getTime() > oneDayAgo;
          return s.busy || unread || recent;
        })
        .map((s: any) => ({
          sessionId: s.sessionId,
          title: s.summary,
          modifiedTime: s.modifiedTime,
          branch: s.context?.branch ?? null,
          busy: s.busy ?? false,
          unread: isUnread(s.sessionId, s.modifiedTime),
        }));

      // Open todos across all active tasks and global todos
      const taskGroups = ctx.taskGroupStore.listGroups();
      const enrichTodo = (todo: ReturnType<typeof ctx.todoStore.listAllOpen>[number]) => {
        const task = todo.taskId ? tasks.find((t) => t.id === todo.taskId) : null;
        const taskTitle = task?.title ?? (todo.taskId ? "Unknown" : null);
        const taskGroupColor = task?.groupId
          ? ctx.taskGroupStore.getGroup(task.groupId)?.color ?? null
          : null;
        const taskOrder = task?.order ?? 0;
        const taskStatus = task?.status ?? null;
        const taskGroupId = task?.groupId ?? null;
        const taskGroupOrder = taskGroupId
          ? taskGroups.find((g) => g.id === taskGroupId)?.order ?? null
          : null;
        return { ...todo, taskTitle, taskGroupColor, taskOrder, taskStatus, taskGroupId, taskGroupOrder };
      };

      const openTodos = ctx.todoStore.listAllOpen().map(enrichTodo);

      // Recently completed todos
      const completedTodos = ctx.todoStore.listRecentlyCompleted().map(enrichTodo);

      res.json({
        busySessions,
        unreadSessions,
        lastActiveTask,
        orphanSessions,
        openTodos,
        completedTodos,
      });
    } catch (err) {
      console.error("[dashboard] Error:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Schedule routes ───────────────────────────────────────────────

  router.get("/schedules", (_req, res) => {
    const taskId = typeof _req.query.taskId === "string" ? _req.query.taskId : undefined;
    res.json(ctx.scheduleStore.listSchedules(taskId));
  });

  router.post("/schedules", (req, res) => {
    try {
      const { taskId, name, prompt, type, cron: cronExpr, runAt, timezone, reuseSession, maxRuns, expiresAt } = req.body;
      if (!taskId || !name || !prompt || !type) {
        return res.status(400).json({ error: "taskId, name, prompt, and type are required" });
      }
      if (type === "cron" && !cronExpr) {
        return res.status(400).json({ error: "cron expression is required for cron schedules" });
      }
      if (type === "once" && !runAt) {
        return res.status(400).json({ error: "runAt is required for one-shot schedules" });
      }
      if (!ctx.taskStore.getTask(taskId)) {
        return res.status(404).json({ error: "Task not found" });
      }

      const schedule = ctx.scheduleStore.createSchedule({ taskId, name, prompt, type, cron: cronExpr, runAt, timezone, reuseSession, maxRuns, expiresAt });

      // Register cron job if applicable
      if (schedule.type === "cron") {
        scheduler.registerSchedule(schedule.id);
      } else if (schedule.type === "once" && schedule.runAt) {
        // For one-shot schedules, set up a setTimeout
        const delay = new Date(schedule.runAt).getTime() - Date.now();
        if (delay > 0) {
          setTimeout(() => {
            scheduler.triggerSchedule(schedule.id).catch((err) => {
              console.error(`[scheduler] One-shot trigger failed for "${schedule.name}":`, err);
            });
          }, delay);
        }
      }

      console.log(`[schedules] Created schedule "${schedule.name}" (${schedule.type})`);
      ctx.globalBus.emit({ type: "schedule:changed", taskId: schedule.taskId, scheduleId: schedule.id });
      res.status(201).json(schedule);
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  router.patch("/schedules/:id", (req, res) => {
    try {
      const schedule = ctx.scheduleStore.updateSchedule(req.params.id, req.body);

      // Re-register cron job if timing or enabled state changed
      if (schedule.type === "cron") {
        if (schedule.enabled) {
          scheduler.registerSchedule(schedule.id);
        } else {
          scheduler.unregisterSchedule(schedule.id);
        }
      }

      console.log(`[schedules] Updated schedule "${schedule.name}"`);
      ctx.globalBus.emit({ type: "schedule:changed", taskId: schedule.taskId, scheduleId: schedule.id });
      res.json(schedule);
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  router.delete("/schedules/:id", (req, res) => {
    try {
      const schedule = ctx.scheduleStore.getSchedule(req.params.id);
      const taskId = schedule?.taskId;
      scheduler.unregisterSchedule(req.params.id);
      ctx.scheduleStore.deleteSchedule(req.params.id);
      console.log(`[schedules] Deleted schedule ${req.params.id}`);
      ctx.globalBus.emit({ type: "schedule:changed", taskId, scheduleId: req.params.id });
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  router.post("/schedules/:id/trigger", async (req, res) => {
    try {
      const result = await scheduler.triggerSchedule(req.params.id);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  router.get("/schedules/status", (_req, res) => {
    res.json({
      globalPause: scheduler.isGlobalPaused(),
      scheduleCount: ctx.scheduleStore.listSchedules().length,
      enabledCount: ctx.scheduleStore.getEnabledSchedules().length,
    });
  });

  router.post("/schedules/pause", (req, res) => {
    const { paused } = req.body;
    scheduler.setGlobalPause(paused !== false);
    res.json({ globalPause: scheduler.isGlobalPaused() });
  });

  // ── Settings routes ───────────────────────────────────────────────

  router.get("/settings", (_req, res) => {
    try {
      res.json(ctx.settingsStore.getSettings());
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.patch("/settings", (req, res) => {
    try {
      const prev = ctx.settingsStore.getSettings();
      const updated = ctx.settingsStore.updateSettings(req.body);
      clearProviderCache();

      // If MCP servers changed, evict cached sessions so they re-resume with new config
      if (JSON.stringify(prev.mcpServers) !== JSON.stringify(updated.mcpServers)) {
        console.log("[settings] MCP servers changed — evicting cached sessions for re-resume");
        ctx.sessionManager.evictAllCachedSessions();
      }

      console.log("[settings] Settings updated");
      res.json(updated);
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  // GET /mcp-status — global MCP server status from any recent session
  router.get("/mcp-status", (_req, res) => {
    try {
      const servers = ctx.sessionManager.getLatestMcpStatus();
      res.json({ servers });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Docs / Knowledge Base ─────────────────────────────────────────

  if (ctx.docsStore && ctx.docsIndex) {
    const docs = ctx.docsStore;
    const docsIdx = ctx.docsIndex;

    router.get("/docs/tree", (_req, res) => {
      try {
        const tree = docs.listTree();
        const hasRootIndex = docs.readPage("index") !== null;
        res.json({ tree, hasRootIndex });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    router.get("/docs/search", (req, res) => {
      try {
        const q = String(req.query.q || "");
        const limit = Math.min(Number(req.query.limit) || 50, 200);
        const offset = Number(req.query.offset) || 0;
        res.json(docsIdx.search(q, limit, offset));
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // Wikilink resolution
    router.get("/docs/resolve", (req, res) => {
      try {
        const target = String(req.query.target || "");
        if (!target) return res.status(400).json({ error: "target is required" });
        const resolved = docsIdx.resolveWikilink(target);
        if (!resolved) return res.status(404).json({ error: "Page not found", target });
        res.json(resolved);
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    router.post("/docs/resolve", (req, res) => {
      try {
        const { targets } = req.body;
        if (!Array.isArray(targets)) return res.status(400).json({ error: "targets array is required" });
        res.json(docsIdx.resolveWikilinks(targets));
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    router.post("/docs/reindex", (_req, res) => {
      try {
        const result = docsIdx.reindex();
        res.json(result);
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // Page CRUD — explicit sub-path to avoid wildcard conflicts
    router.get("/docs/pages/*path", (req, res) => {
      try {
        const raw = (req.params as any).path;
        const pagePath = Array.isArray(raw) ? raw.join("/") : String(raw);
        const page = docs.readPage(pagePath);
        if (!page) return res.status(404).json({ error: "Page not found" });
        res.json(page);
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    router.put("/docs/pages/*path", (req, res) => {
      try {
        const raw = (req.params as any).path;
        const pagePath = Array.isArray(raw) ? raw.join("/") : String(raw);
        const { content } = req.body;
        if (typeof content !== "string") return res.status(400).json({ error: "content is required" });
        const page = docs.writePage(pagePath, content);
        docsIdx.indexPage(page);
        res.json({ path: page.path, success: true });
      } catch (err: any) {
        res.status(400).json({ error: err.message || String(err) });
      }
    });

    router.delete("/docs/pages/*path", (req, res) => {
      try {
        const raw = (req.params as any).path;
        const pagePath = Array.isArray(raw) ? raw.join("/") : String(raw);
        docsIdx.removePage(pagePath);
        const deleted = docs.deletePage(pagePath);
        res.json({ deleted });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // DB collection routes — use wildcard (*) to support nested folders (e.g. areas/cooking/recipes)
    const paramPath = (raw: any): string => Array.isArray(raw) ? raw.join("/") : String(raw);

    router.get("/docs/schema/*folder", (req, res) => {
      try {
        const folder = paramPath((req.params as any).folder);
        const schema = docs.readSchema(folder);
        if (!schema) return res.status(404).json({ error: "Schema not found" });
        const entries = docs.listDbEntries(folder);
        res.json({ ...schema, entryCount: entries.length });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    router.put("/docs/schema/*folder", (req, res) => {
      try {
        const folder = paramPath((req.params as any).folder);
        const { name, fields } = req.body;
        if (!name || !Array.isArray(fields)) return res.status(400).json({ error: "name and fields are required" });
        const schema = docs.writeSchema(folder, { name, fields });
        res.json({ ...schema, success: true });
      } catch (err: any) {
        res.status(400).json({ error: err.message || String(err) });
      }
    });

    router.get("/docs/db/*folder", (req, res) => {
      try {
        const folder = paramPath((req.params as any).folder);
        const limit = Math.min(Number(req.query.limit) || 10000, 10000);
        const offset = Number(req.query.offset) || 0;
        const sortField = req.query._sort as string | undefined;
        const sortOrder = (req.query._order as string | undefined) === "asc" ? "asc" as const : "desc" as const;

        // Extract field filters from query (skip meta params)
        const filters: Record<string, any> = {};
        for (const [key, value] of Object.entries(req.query)) {
          if (key.startsWith("_") || key === "limit" || key === "offset") continue;
          filters[key] = value;
        }

        const result = docsIdx.queryByFolder(
          folder,
          Object.keys(filters).length ? filters : undefined,
          sortField ? { field: sortField, order: sortOrder } : undefined,
          limit,
          offset,
        );
        res.json(result);
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    router.post("/docs/db/*folder", (req, res) => {
      try {
        const folder = paramPath((req.params as any).folder);
        const { fields, body } = req.body;
        if (!fields || typeof fields !== "object") return res.status(400).json({ error: "fields object is required" });
        const entry = docs.addDbEntry(folder, fields, body);
        // Index the new page
        const page = docs.readPage(entry.path);
        if (page) docsIdx.indexPage(page);
        res.json({ path: entry.path, slug: entry.slug, success: true });
      } catch (err: any) {
        res.status(400).json({ error: err.message || String(err) });
      }
    });

    router.patch("/docs/db/*path", (req, res) => {
      try {
        const fullPath = paramPath((req.params as any).path);
        const lastSlash = fullPath.lastIndexOf("/");
        if (lastSlash === -1) return res.status(400).json({ error: "Path must be folder/slug" });
        const folder = fullPath.slice(0, lastSlash);
        const slug = fullPath.slice(lastSlash + 1);
        const { fields, body } = req.body;
        if (!fields || typeof fields !== "object") return res.status(400).json({ error: "fields object is required" });
        const entry = docs.updateDbEntry(folder, slug, fields, body);
        // Re-index the updated page
        const page = docs.readPage(entry.path);
        if (page) docsIdx.indexPage(page);
        res.json({ path: entry.path, success: true });
      } catch (err: any) {
        res.status(400).json({ error: err.message || String(err) });
      }
    });
  }

  // ── Telemetry routes ────────────────────────────────────────────

  router.post("/telemetry", (req, res) => {
    if (!ctx.telemetryStore) return res.status(501).json({ error: "Telemetry not available" });
    const { name, sessionId, duration, metadata } = req.body;
    if (!name || typeof duration !== "number") {
      return res.status(400).json({ error: "name (string) and duration (number) are required" });
    }
    ctx.telemetryStore.recordSpan({ name, sessionId, duration, metadata, source: "client" });
    res.json({ ok: true });
  });

  router.get("/telemetry", (_req, res) => {
    if (!ctx.telemetryStore) return res.status(501).json({ error: "Telemetry not available" });
    const { name, sessionId, source, limit, since } = _req.query as Record<string, string>;
    const spans = ctx.telemetryStore.querySpans({
      name, sessionId, source: source as any,
      limit: limit ? parseInt(limit, 10) : undefined,
      since,
    });
    res.json(spans);
  });

  router.get("/telemetry/stats", (_req, res) => {
    if (!ctx.telemetryStore) return res.status(501).json({ error: "Telemetry not available" });
    const { since } = _req.query as Record<string, string>;
    const stats = ctx.telemetryStore.getStats({ since });
    res.json(stats);
  });

  return router;
}
