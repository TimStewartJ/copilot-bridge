// Copilot Web Bridge — Express server

import express from "express";
import { readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { config } from "./config.js";
import { SessionManager } from "./session-manager.js";
import * as taskStore from "./task-store.js";

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
        return { ...s, diskSizeBytes };
      });

    res.json({ sessions: enriched });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/api/sessions/:id/messages", async (req, res) => {
  try {
    const messages = await sessionManager.getSessionMessages(req.params.id);
    res.json({ messages });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/sessions", async (req, res) => {
  try {
    const { name } = req.body ?? {};
    const result = await sessionManager.createSession(name);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post("/api/chat", async (req, res) => {
  const { sessionId, prompt } = req.body;

  if (!sessionId || !prompt) {
    return res.status(400).json({ error: "sessionId and prompt are required" });
  }

  if (sessionManager.isSessionBusy(sessionId)) {
    return res.status(429).json({ error: "Session is busy, please wait" });
  }

  console.log(`[web] [${sessionId.slice(0, 8)}] "${prompt.slice(0, 80)}"`);
  const startTime = Date.now();

  try {
    const response = await sessionManager.sendMessage(sessionId, prompt);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[web] [${sessionId.slice(0, 8)}] Response sent (${response.length} chars, ${elapsed}s)`);
    res.json({ response });
  } catch (err) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.error(`[web] Error after ${elapsed}s:`, err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
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
      task.title,
      task.workItemIds,
      prDescriptions,
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
