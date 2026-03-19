// Copilot Web Bridge — Express server with chat UI

import express from "express";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { config } from "./config.js";
import { SessionManager } from "./session-manager.js";
import { chatHtml } from "./ui.js";

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

// ── Chat UI ───────────────────────────────────────────────────────

app.get("/", (_req, res) => {
  res.type("html").send(chatHtml);
});

// ── API routes ────────────────────────────────────────────────────

app.get("/api/sessions", async (_req, res) => {
  try {
    const sessions = await sessionManager.listSessions();
    const sessionStateDir = join(homedir(), ".copilot", "session-state");

    const enriched = sessions.map((s: any) => {
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

// ── Start ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("╔════════════════════════════════════════╗");
  console.log("║      Copilot Web Bridge — PoC         ║");
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
