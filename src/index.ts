// Copilot Web Bridge — Express server with chat UI

import express from "express";
import { config } from "./config.js";
import { SessionManager } from "./session-manager.js";
import { chatHtml } from "./ui.js";

const app = express();
app.use(express.json());

const sessionManager = new SessionManager();

// ── Chat UI ───────────────────────────────────────────────────────

app.get("/", (_req, res) => {
  res.type("html").send(chatHtml);
});

// ── API routes ────────────────────────────────────────────────────

app.get("/api/sessions", (_req, res) => {
  res.json({ sessions: sessionManager.listSessions() });
});

app.post("/api/sessions", async (req, res) => {
  try {
    const { name } = req.body ?? {};
    const session = await sessionManager.createSession(name);
    res.json({ session });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post("/api/chat", async (req, res) => {
  const { sessionId, prompt } = req.body;

  if (!sessionId || !prompt) {
    return res.status(400).json({ error: "sessionId and prompt are required" });
  }

  const session = sessionManager.getSession(sessionId);
  if (!session) {
    return res.status(404).json({ error: "Session not found" });
  }

  if (sessionManager.isSessionBusy(sessionId)) {
    return res.status(429).json({ error: "Session is busy, please wait" });
  }

  console.log(`[web] [${session.name}] "${prompt.slice(0, 80)}"`);

  try {
    const response = await sessionManager.sendMessage(sessionId, prompt);
    console.log(`[web] [${session.name}] Response sent (${response.length} chars)`);
    res.json({ response, session: sessionManager.getSession(sessionId) });
  } catch (err) {
    console.error(`[web] Error:`, err);
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
