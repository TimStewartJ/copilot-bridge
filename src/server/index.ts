// Copilot Web Bridge — Express server

import express from "express";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { config } from "./config.js";
import { SessionManager } from "./session-manager.js";
import * as taskStore from "./task-store.js";
import { getBus, hasBus } from "./event-bus.js";
import * as adoClient from "./ado-client.js";

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

app.get("/api/sessions", async (_req, res) => {
  try {
    const sessions = await sessionManager.listSessions();
    const sessionStateDir = join(homedir(), ".copilot", "session-state");

    const enriched = sessions
      .filter((s: any) => s.summary) // hide empty/zombie sessions
      .map((s: any) => {
        const id = s.sessionId;
        let diskSizeBytes = 0;
        try {
          const sessionDir = join(sessionStateDir, id);
          diskSizeBytes = getDirSize(sessionDir);
        } catch { /* session dir may not exist */ }
        const hasPlan = existsSync(join(sessionStateDir, id, "plan.md"));
        return { ...s, diskSizeBytes, busy: sessionManager.isSessionBusy(id), hasPlan };
      });

    res.json({ sessions: enriched });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/api/busy", (_req, res) => {
  const activeSessions = sessionManager.getActiveSessions();
  res.json({ busy: activeSessions.length > 0, count: activeSessions.length, sessionIds: activeSessions });
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

// ── Task routes ───────────────────────────────────────────────────

app.get("/api/tasks", (_req, res) => {
  res.json({ tasks: taskStore.listTasks() });
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

  const port = config.web.port;
  app.listen(port, () => {
    console.log(`[web] 🟢 Server running at http://localhost:${port}`);
    console.log(`[web] Open in browser or expose via: devtunnel host -p ${port}`);
  });
}

process.on("SIGINT", async () => {
  console.log("\n[web] Shutting down...");
  await sessionManager.shutdown();
  process.exit(0);
});

main().catch((err) => {
  console.error("[web] Fatal error:", err);
  process.exit(1);
});
