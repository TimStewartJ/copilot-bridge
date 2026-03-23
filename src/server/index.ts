// Copilot Web Bridge — Express server

import "./log-timestamps.js";
import express from "express";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { config } from "./config.js";
import { SessionManager, isRestartPending, getRestartWaitingCount, clearRestartPending } from "./session-manager.js";
import * as taskStore from "./task-store.js";
import * as taskGroupStore from "./task-group-store.js";
import * as sessionMetaStore from "./session-meta-store.js";
import * as settingsStore from "./settings-store.js";
import * as sessionTitles from "./session-titles.js";
import * as scheduleStore from "./schedule-store.js";
import * as scheduler from "./scheduler.js";
import { getBus, hasBus } from "./event-bus.js";
import { startRestartWatcher, notifyWebhook, gitHash, getTunnelUrl, discoverTunnelUrl } from "./restart-handler.js";
import * as adoClient from "./ado-client.js";
import * as readStateStore from "./read-state-store.js";
import * as globalBus from "./global-bus.js";
import { pruneOrphanedWorktrees } from "./staging-tools.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

const sessionManager = new SessionManager();

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

// ── API routes ────────────────────────────────────────────────────

app.get("/api/sessions", async (req, res) => {
  try {
    const includeArchived = req.query.includeArchived === "true";
    const sessions = await sessionManager.listSessions();
    const sessionStateDir = join(homedir(), ".copilot", "session-state");
    const meta = sessionMetaStore.listMeta();

    const enriched = sessions
      .filter((s: any) => s.summary) // hide empty/zombie sessions
      .filter((s: any) => !s.summary?.startsWith("Generate a concise")) // hide leaked title-generation sessions
      .map((s: any) => {
        const id = s.sessionId;
        let diskSizeBytes = 0;
        try {
          const sessionDir = join(sessionStateDir, id);
          diskSizeBytes = getDirSize(sessionDir);
        } catch { /* session dir may not exist */ }
        const hasPlan = existsSync(join(sessionStateDir, id, "plan.md"));
        const archived = meta[id]?.archived === true;
        const archivedAt = meta[id]?.archivedAt ?? null;
        // Prefer LLM-generated title over raw first-message summary
        const generatedTitle = sessionTitles.getTitle(id);
        const summary = generatedTitle ?? s.summary;
        return {
          ...s,
          summary,
          diskSizeBytes,
          busy: sessionManager.isSessionBusy(id),
          hasPlan,
          archived,
          archivedAt,
          triggeredBy: meta[id]?.triggeredBy,
          scheduleId: meta[id]?.scheduleId,
          scheduleName: meta[id]?.scheduleName,
        };
      })
      .filter((s: any) => includeArchived || !s.archived);

    res.json({ sessions: enriched });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/api/busy", (_req, res) => {
  const activeSessions = sessionManager.getActiveSessions();
  res.json({ busy: activeSessions.length > 0, count: activeSessions.length, sessionIds: activeSessions });
});

// POST /api/restart-clear — manual escape hatch to dismiss a stale restart banner
app.post("/api/restart-clear", (_req, res) => {
  clearRestartPending();
  res.json({ ok: true });
});

// GET /api/status-stream — global SSE for session lifecycle events
app.get("/api/status-stream", (req, res) => {
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

  const unsub = globalBus.subscribe((event) => {
    if (closed || res.writableEnded) return;
    try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch { close(); }
  });

  // Send initial restart state so reconnecting clients catch up
  if (isRestartPending()) {
    const count = getRestartWaitingCount();
    try { res.write(`data: ${JSON.stringify({ type: "server:restart-pending", waitingSessions: count })}\n\n`); }
    catch { close(); }
  }

  res.on("error", () => { close(); });
  req.on("close", () => { close(); });
});

app.get("/api/sessions/:id/messages", async (req, res) => {
  try {
    const messages = await sessionManager.getSessionMessages(req.params.id);
    const busy = sessionManager.isSessionBusy(req.params.id);
    res.json({ messages, busy });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/sessions", async (req, res) => {
  try {
    const { name } = req.body ?? {};
    const result = await sessionManager.createSession();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/chat — fire and forget, starts work in background
app.post("/api/chat", (req, res) => {
  const { sessionId, prompt } = req.body;

  if (!sessionId || !prompt) {
    return res.status(400).json({ error: "sessionId and prompt are required" });
  }

  if (sessionManager.isSessionBusy(sessionId)) {
    return res.status(429).json({ error: "Session is busy, please wait" });
  }

  console.log(`[web] [${sessionId.slice(0, 8)}] "${prompt.slice(0, 80)}"`);

  try {
    sessionManager.startWork(sessionId, prompt);
    res.status(202).json({ status: "accepted" });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// GET /api/sessions/:id/stream — SSE stream with snapshot + live events
app.get("/api/sessions/:id/stream", (req, res) => {
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
    if (event.type === "done" || event.type === "error") {
      close();
    }
  };

  // Prevent unhandled 'error' events on the response from crashing the process
  res.on("error", () => { close(); });
  req.on("close", () => { close(); });

  const bus = getBus(sessionId);

  if (!bus) {
    if (sessionManager.isSessionBusy(sessionId)) {
      sendEvent({ type: "thinking" });
      // Poll for bus — it should appear shortly after POST /api/chat
      const pollStart = Date.now();
      const waitForBus = setInterval(() => {
        if (closed) { clearInterval(waitForBus); return; }
        const newBus = getBus(sessionId);
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

// GET /api/sessions/:id/plan — read plan.md from session state directory
app.get("/api/sessions/:id/plan", (_req, res) => {
  const sessionId = _req.params.id;
  const planPath = join(homedir(), ".copilot", "session-state", sessionId, "plan.md");

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

// PATCH /api/sessions/:id — update session metadata (archive/unarchive)
app.patch("/api/sessions/:id", (req, res) => {
  const { archived } = req.body;
  if (typeof archived !== "boolean") {
    return res.status(400).json({ error: "archived (boolean) is required" });
  }
  try {
    sessionMetaStore.setArchived(req.params.id, archived);
    res.json({ ok: true, archived });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// DELETE /api/sessions/:id — permanently delete a session
app.delete("/api/sessions/:id", async (req, res) => {
  const sessionId = req.params.id;
  try {
    await sessionManager.deleteSession(sessionId);
    sessionMetaStore.deleteMeta(sessionId);
    sessionTitles.deleteTitle(sessionId);
    // Unlink from any tasks that reference this session
    const tasks = taskStore.listTasks();
    for (const task of tasks) {
      if (task.sessionIds.includes(sessionId)) {
        taskStore.unlinkSession(task.id, sessionId);
      }
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── Task Group routes ─────────────────────────────────────────────

app.get("/api/task-groups", (_req, res) => {
  res.json({ groups: taskGroupStore.listGroups() });
});

app.post("/api/task-groups", (req, res) => {
  const { name, color } = req.body;
  if (!name) return res.status(400).json({ error: "name is required" });
  try {
    const group = taskGroupStore.createGroup(name, color);
    res.json({ group });
  } catch (err) {
    res.status(400).json({ error: String(err) });
  }
});

app.patch("/api/task-groups/:id", (req, res) => {
  try {
    const group = taskGroupStore.updateGroup(req.params.id, req.body);
    res.json({ group });
  } catch (err) {
    res.status(404).json({ error: String(err) });
  }
});

app.delete("/api/task-groups/:id", (req, res) => {
  // Ungroup any tasks that belong to this group
  const tasks = taskStore.listTasks().filter((t) => t.groupId === req.params.id);
  for (const t of tasks) taskStore.updateTask(t.id, { groupId: undefined });
  taskGroupStore.deleteGroup(req.params.id);
  res.json({ success: true });
});

app.put("/api/task-groups/reorder", (req, res) => {
  const { groupIds } = req.body;
  if (!Array.isArray(groupIds)) return res.status(400).json({ error: "groupIds array is required" });
  try {
    const groups = taskGroupStore.reorderGroups(groupIds);
    res.json({ groups });
  } catch (err) {
    res.status(400).json({ error: String(err) });
  }
});

// ── Task routes ───────────────────────────────────────────────────

app.get("/api/tasks", (_req, res) => {
  res.json({ tasks: taskStore.listTasks() });
});

app.put("/api/tasks/reorder", (req, res) => {
  const { taskIds } = req.body;
  if (!Array.isArray(taskIds)) return res.status(400).json({ error: "taskIds array is required" });
  try {
    const tasks = taskStore.reorderTasks(taskIds);
    res.json({ tasks });
  } catch (err) {
    res.status(400).json({ error: String(err) });
  }
});

app.post("/api/tasks", (req, res) => {
  const { title } = req.body;
  if (!title) return res.status(400).json({ error: "title is required" });
  try {
    const task = taskStore.createTask(title);
    res.json({ task });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/api/tasks/:id", (req, res) => {
  const task = taskStore.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: "Task not found" });
  res.json({ task });
});

// Enriched task data — fetches work item + PR metadata from ADO
app.get("/api/tasks/:id/enriched", async (req, res) => {
  const task = taskStore.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: "Task not found" });

  try {
    const [workItems, pullRequests] = await Promise.all([
      adoClient.fetchWorkItems(task.workItemIds),
      adoClient.fetchPullRequests(task.pullRequests),
    ]);
    res.json({ task, workItems, pullRequests });
  } catch (err) {
    console.error("[enriched] Error:", err);
    // Graceful fallback — return task with empty enrichment
    res.json({
      task,
      workItems: task.workItemIds.map((id) => ({
        id,
        title: null,
        state: null,
        type: null,
        assignedTo: null,
        areaPath: null,
        url: `https://my-org.visualstudio.com/MyProject/_workitems/edit/${id}`,
      })),
      pullRequests: task.pullRequests.map((pr) => ({
        repoId: pr.repoId,
        repoName: pr.repoName ?? null,
        prId: pr.prId,
        title: null,
        status: null,
        createdBy: null,
        reviewerCount: 0,
        url: `https://my-org.visualstudio.com/MyProject/_git/${pr.repoName ?? pr.repoId}/pullrequest/${pr.prId}`,
      })),
    });
  }
});

app.patch("/api/tasks/:id", (req, res) => {
  try {
    const task = taskStore.updateTask(req.params.id, req.body);
    res.json({ task });
  } catch (err) {
    res.status(404).json({ error: String(err) });
  }
});

app.delete("/api/tasks/:id", (req, res) => {
  taskStore.deleteTask(req.params.id);
  res.json({ ok: true });
});

app.post("/api/tasks/:id/link", (req, res) => {
  const { type, sessionId, workItemId, repoId, repoName, prId } = req.body;
  try {
    let task;
    switch (type) {
      case "session":
        task = taskStore.linkSession(req.params.id, sessionId);
        break;
      case "workItem":
        task = taskStore.linkWorkItem(req.params.id, Number(workItemId));
        break;
      case "pr":
        task = taskStore.linkPR(req.params.id, { repoId, repoName, prId: Number(prId) });
        break;
      default:
        return res.status(400).json({ error: `Unknown link type: ${type}` });
    }
    res.json({ task });
  } catch (err) {
    res.status(400).json({ error: String(err) });
  }
});

app.delete("/api/tasks/:id/link", (req, res) => {
  const { type, sessionId, workItemId, repoId, prId } = req.body;
  try {
    let task;
    switch (type) {
      case "session":
        task = taskStore.unlinkSession(req.params.id, sessionId);
        break;
      case "workItem":
        task = taskStore.unlinkWorkItem(req.params.id, Number(workItemId));
        break;
      case "pr":
        task = taskStore.unlinkPR(req.params.id, repoId, Number(prId));
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
app.post("/api/tasks/:id/session", async (req, res) => {
  const task = taskStore.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: "Task not found" });

  try {
    const prDescriptions = task.pullRequests.map(
      (pr) => `${pr.repoName || pr.repoId} PR #${pr.prId}`,
    );
    const result = await sessionManager.createTaskSession(
      task.id,
      task.title,
      task.workItemIds,
      prDescriptions,
      task.notes,
      task.cwd,
    );

    // Auto-link session to task
    taskStore.linkSession(task.id, result.sessionId);

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── Read State routes ─────────────────────────────────────────────

app.get("/api/read-state", (_req, res) => {
  res.json(readStateStore.getReadState());
});

app.post("/api/read-state/:sessionId", (req, res) => {
  const ts = readStateStore.markRead(req.params.sessionId);
  res.json({ ok: true, lastReadAt: ts });
});

// ── Dashboard endpoint ───────────────────────────────────────────

app.get("/api/dashboard", async (_req, res) => {
  try {
    const sessions = await sessionManager.listSessions();
    const sessionStateDir = join(homedir(), ".copilot", "session-state");
    const meta = sessionMetaStore.listMeta();
    const readState = readStateStore.getReadState();
    const tasks = taskStore.listTasks();
    const taskSessionIds = new Set(tasks.flatMap((t) => t.sessionIds));

    // Enrich sessions (lightweight — skip disk size for dashboard)
    const enrichedSessions = sessions
      .filter((s: any) => s.summary)
      .filter((s: any) => !s.summary?.startsWith("Generate a concise")) // hide leaked title-generation sessions
      .map((s: any) => {
        const id = s.sessionId;
        const archived = meta[id]?.archived === true;
        const generatedTitle = sessionTitles.getTitle(id);
        const summary = generatedTitle ?? s.summary;
        const busy = sessionManager.isSessionBusy(id);
        const hasPlan = existsSync(join(sessionStateDir, id, "plan.md"));
        return { ...s, summary, busy, hasPlan, archived };
      })
      .filter((s: any) => !s.archived);

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
        const bus = getBus(s.sessionId);
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

    // Batch-fetch all work item IDs across all in-flight tasks
    const allWorkItemIds = [...new Set(inFlightTasks.flatMap((t) => t.workItemIds))];
    const allPRs = inFlightTasks.flatMap((t) => t.pullRequests);
    const uniquePRs = allPRs.filter((pr, i, arr) =>
      arr.findIndex((p) => p.repoId === pr.repoId && p.prId === pr.prId) === i,
    );

    const [allWorkItems, allEnrichedPRs] = await Promise.all([
      adoClient.fetchWorkItems(allWorkItemIds),
      adoClient.fetchPullRequests(uniquePRs),
    ]);

    const wiMap = new Map(allWorkItems.map((wi) => [wi.id, wi]));
    const prMap = new Map(allEnrichedPRs.map((pr) => [`${pr.repoId}:${pr.prId}`, pr]));

    const activeTasks = inFlightTasks.map((task) => {
      // Work item state summary
      const byState: Record<string, number> = {};
      for (const wiId of task.workItemIds) {
        const wi = wiMap.get(wiId);
        const state = wi?.state ?? "Unknown";
        byState[state] = (byState[state] ?? 0) + 1;
      }

      // PR status summary
      let prActive = 0;
      let prCompleted = 0;
      for (const pr of task.pullRequests) {
        const enriched = prMap.get(`${pr.repoId}:${pr.prId}`);
        if (enriched?.status === "active") prActive++;
        else if (enriched?.status === "completed") prCompleted++;
      }

      // Unread check across all task sessions
      const hasUnread = task.sessionIds.some((sid) => {
        const session = enrichedSessions.find((s: any) => s.sessionId === sid);
        return session && (session.busy || isUnread(sid, session.modifiedTime));
      });

      // Last activity across task sessions
      const sessionTimes = task.sessionIds
        .map((sid) => enrichedSessions.find((s: any) => s.sessionId === sid)?.modifiedTime)
        .filter(Boolean) as string[];
      const lastActivity = sessionTimes.length > 0
        ? sessionTimes.sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0]
        : task.updatedAt;

      // Has busy session?
      const hasBusySession = task.sessionIds.some((sid) =>
        enrichedSessions.find((s: any) => s.sessionId === sid)?.busy,
      );

      return {
        task,
        workItemSummary: { total: task.workItemIds.length, byState },
        prSummary: { total: task.pullRequests.length, active: prActive, completed: prCompleted },
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

    res.json({
      busySessions,
      unreadSessions,
      lastActiveTask,
      activeTasks,
      orphanSessions,
    });
  } catch (err) {
    console.error("[dashboard] Error:", err);
    res.status(500).json({ error: String(err) });
  }
});

// ── Schedule routes ───────────────────────────────────────────────

app.get("/api/schedules", (_req, res) => {
  const taskId = typeof _req.query.taskId === "string" ? _req.query.taskId : undefined;
  res.json(scheduleStore.listSchedules(taskId));
});

app.post("/api/schedules", (req, res) => {
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
    if (!taskStore.getTask(taskId)) {
      return res.status(404).json({ error: "Task not found" });
    }

    const schedule = scheduleStore.createSchedule({ taskId, name, prompt, type, cron: cronExpr, runAt, timezone, reuseSession, maxRuns, expiresAt });

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
    res.status(201).json(schedule);
  } catch (err) {
    res.status(400).json({ error: String(err) });
  }
});

app.patch("/api/schedules/:id", (req, res) => {
  try {
    const schedule = scheduleStore.updateSchedule(req.params.id, req.body);

    // Re-register cron job if timing or enabled state changed
    if (schedule.type === "cron") {
      if (schedule.enabled) {
        scheduler.registerSchedule(schedule.id);
      } else {
        scheduler.unregisterSchedule(schedule.id);
      }
    }

    console.log(`[schedules] Updated schedule "${schedule.name}"`);
    res.json(schedule);
  } catch (err) {
    res.status(400).json({ error: String(err) });
  }
});

app.delete("/api/schedules/:id", (req, res) => {
  try {
    scheduler.unregisterSchedule(req.params.id);
    scheduleStore.deleteSchedule(req.params.id);
    console.log(`[schedules] Deleted schedule ${req.params.id}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: String(err) });
  }
});

app.post("/api/schedules/:id/trigger", async (req, res) => {
  try {
    const result = await scheduler.triggerSchedule(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: String(err) });
  }
});

app.get("/api/schedules/status", (_req, res) => {
  res.json({
    globalPause: scheduler.isGlobalPaused(),
    scheduleCount: scheduleStore.listSchedules().length,
    enabledCount: scheduleStore.getEnabledSchedules().length,
  });
});

app.post("/api/schedules/pause", (req, res) => {
  const { paused } = req.body;
  scheduler.setGlobalPause(paused !== false);
  res.json({ globalPause: scheduler.isGlobalPaused() });
});

// ── Settings routes ───────────────────────────────────────────────

app.get("/api/settings", (_req, res) => {
  try {
    res.json(settingsStore.getSettings());
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.patch("/api/settings", (req, res) => {
  try {
    const updated = settingsStore.updateSettings(req.body);
    console.log("[settings] Settings updated");
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: String(err) });
  }
});

// ── Static files (Vite build output) ──────────────────────────────

const distPath = join(__dirname, "..", "..", "dist", "client");
app.use(express.static(distPath));
app.get("/{*splat}", (_req, res) => {
  res.sendFile(join(distPath, "index.html"));
});

// ── Start ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("╔════════════════════════════════════════╗");
  console.log("║      Copilot Web Bridge                ║");
  console.log("╚════════════════════════════════════════╝");
  console.log();

  await sessionManager.initialize();

  // Clean up any orphaned staging worktrees from previous sessions
  pruneOrphanedWorktrees();

  // Initialize scheduler after session manager is ready
  scheduler.initialize(sessionManager);

  const port = config.web.port;
  app.listen(port, () => {
    console.log(`[web] 🟢 Server running at http://localhost:${port}`);
  });

  // Start restart signal watcher (also discovers tunnel URL)
  startRestartWatcher();

  // Webhook 1: server is up
  await notifyWebhook(`🤖 Copilot Bridge is online! (${gitHash()}, PID ${process.pid})`);

  // Webhook 2: tunnel URL (may take a moment to be available)
  const tunnelUrl = getTunnelUrl();
  if (tunnelUrl) {
    await notifyWebhook(`🔗 Tunnel ready`, tunnelUrl);
  } else {
    // Retry after a short delay — tunnel PM2 process may still be starting
    setTimeout(async () => {
      const url = discoverTunnelUrl();
      if (url) {
        await notifyWebhook(`🔗 Tunnel ready`, url);
      }
    }, 15_000);
  }
}

process.on("SIGINT", async () => {
  console.log("\n[web] Shutting down...");
  scheduler.shutdown();
  await sessionManager.shutdown();
  process.exit(0);
});

main().catch((err) => {
  console.error("[web] Fatal error:", err);
  process.exit(1);
});
