// REST routes for Helm's brief, memory and looks, mounted under /api/helm next to the conversation routes.
import express from "express";
import { HelmError } from "../helm-service.js";
import type { HelmThinker } from "./thinker.js";

function sendError(res: express.Response, error: unknown): void {
  if (error instanceof HelmError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  res.status(502).json({ error: message });
}

function body(req: express.Request): Record<string, unknown> {
  return req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
}

export function createHelmThinkerRouter(thinker: HelmThinker): express.Router {
  const router = express.Router();
  const noStore: express.RequestHandler = (_req, res, next) => { res.set("Cache-Control", "no-store"); next(); };
  router.use(noStore);

  router.get("/brief", async (_req, res) => {
    try { res.json(await thinker.getBrief()); } catch (error) { sendError(res, error); }
  });

  router.post("/think", async (req, res) => {
    const rebuild = body(req).rebuild;
    if (rebuild !== undefined && typeof rebuild !== "boolean") {
      res.status(400).json({ error: "rebuild must be true or false" });
      return;
    }
    try { res.status(202).json(await thinker.think({ trigger: "manual", rebuild: rebuild === true })); }
    catch (error) { sendError(res, error); }
  });

  router.post("/brief/:runId/items/:itemId/act", async (req, res) => {
    try { res.json(await thinker.act(req.params.runId, req.params.itemId, body(req))); }
    catch (error) { sendError(res, error); }
  });

  router.post("/brief/:runId/items/:itemId/feedback", (req, res) => {
    try { thinker.feedback(req.params.runId, req.params.itemId, body(req)); res.json({ ok: true }); }
    catch (error) { sendError(res, error); }
  });

  router.post("/handled/:id/undo", (req, res) => {
    try { res.json(thinker.undoHandled(req.params.id)); } catch (error) { sendError(res, error); }
  });

  router.get("/memory", (_req, res) => {
    try {
      const entries = thinker.listMemory();
      res.json({ entries, sourceNames: thinker.sourceNames(entries.flatMap((entry) => entry.fromSources)) });
    } catch (error) { sendError(res, error); }
  });

  router.post("/memory", (req, res) => {
    try { res.status(201).json(thinker.addMemory(body(req))); } catch (error) { sendError(res, error); }
  });

  router.patch("/memory/:id", (req, res) => {
    try { res.json(thinker.updateMemory(req.params.id, body(req))); } catch (error) { sendError(res, error); }
  });

  router.get("/runs", (_req, res) => {
    try { res.json({ runs: thinker.listRuns() }); } catch (error) { sendError(res, error); }
  });

  router.get("/thinker/settings", (_req, res) => {
    try { res.json(thinker.getSettings()); } catch (error) { sendError(res, error); }
  });

  router.patch("/thinker/settings", async (req, res) => {
    try { res.json(await thinker.patchSettings(req.body)); } catch (error) { sendError(res, error); }
  });

  // Starts the MCP server to read its tools, so it is a POST although it changes nothing.
  router.post("/sources/tools", async (req, res) => {
    try { res.json(await thinker.listSourceTools(body(req).serverId)); } catch (error) { sendError(res, error); }
  });

  return router;
}
