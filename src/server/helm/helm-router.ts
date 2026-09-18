// REST routes for Helm conversations (mounted under /api/helm). Messages themselves go through
// the ordinary chat routes: a Helm conversation is a Bridge session.
import express from "express";
import { HelmError, type HelmService } from "./helm-service.js";

function sendError(res: express.Response, error: unknown): void {
  if (error instanceof HelmError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  res.status(/restart/i.test(message) ? 503 : 500).json({ error: message });
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() && value.length <= 200 ? value.trim() : undefined;
}

export function createHelmRouter(helm: HelmService): express.Router {
  const router = express.Router();

  router.get("/", async (_req, res) => {
    try {
      res.json(await helm.getState());
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post("/conversations", async (req, res) => {
    const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
    try {
      const conversation = await helm.createConversation({ model: optionalString(body.model) });
      res.status(201).json(conversation);
    } catch (error) {
      sendError(res, error);
    }
  });

  /** Reset: clears the current conversation without deleting anything. */
  router.post("/fresh", async (_req, res) => {
    try {
      res.json(await helm.startFresh());
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post("/conversations/:id/resume", async (req, res) => {
    try {
      res.json(await helm.resumeConversation(req.params.id));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.patch("/conversations/:id", async (req, res) => {
    const kept = (req.body as { kept?: unknown } | undefined)?.kept;
    if (typeof kept !== "boolean") return res.status(400).json({ error: "kept must be a boolean" });
    try {
      res.json(await helm.setKept(req.params.id, kept));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.delete("/conversations/:id", async (req, res) => {
    try {
      await helm.deleteConversation(req.params.id);
      res.json({ ok: true });
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
}
