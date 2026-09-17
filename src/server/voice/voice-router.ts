// REST routes for the local speech engine and hands-free voice mode (mounted under /api/voice).
import express from "express";
import { openSseConnection } from "../sse-response.js";
import type { VoiceGateway } from "./voice-gateway.js";

function readToken(req: express.Request): unknown {
  return req.get("x-voice-token") ?? req.query.token;
}

/** Rejects requests a browser marks as coming from another site (CSRF for side-effecting routes). */
function rejectCrossSite(req: express.Request, res: express.Response): boolean {
  const site = req.get("sec-fetch-site")?.toLowerCase();
  if (site && site !== "same-origin" && site !== "same-site" && site !== "none") {
    res.status(403).json({ error: "Voice mode requests must come from the Bridge UI." });
    return true;
  }
  return false;
}

export function createVoiceRouter(gateway: VoiceGateway): express.Router {
  const router = express.Router();

  router.get("/status", (_req, res) => {
    res.json(gateway.getStatus());
  });

  router.post("/install", (req, res) => {
    if (rejectCrossSite(req, res)) return;
    const status = gateway.installer.getStatus();
    if (!status.supported) {
      return res.status(400).json({ error: `The local speech engine isn't supported on ${status.target}.`, status });
    }
    void gateway.installer.install().catch(() => undefined);
    res.status(202).json(gateway.installer.getStatus());
  });

  router.post("/conversations", (req, res) => {
    if (rejectCrossSite(req, res)) return;
    if (!gateway.installer.getStatus().installed) {
      return res.status(409).json({ error: "Voice mode isn't installed yet." });
    }
    const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
    res.json(gateway.createConversation(body.settings));
  });

  router.get("/conversations/:id/events", (req, res) => {
    const token = readToken(req);
    let detach: (() => void) | undefined;
    const sse = openSseConnection(req, res, () => detach?.());
    detach = gateway.attachHttpEvents(req.params.id, token, sse);
    if (!detach) sse.send({ type: "ended", reason: "Voice conversation not found" }, undefined, true);
  });

  router.post(
    "/conversations/:id/audio",
    express.raw({ type: "application/octet-stream", limit: "1mb" }),
    (req, res) => {
      const seq = Number(req.query.seq);
      if (!Number.isInteger(seq) || seq < 0 || !Buffer.isBuffer(req.body)) {
        return res.status(400).json({ error: "seq and a binary PCM body are required" });
      }
      const accepted = gateway.acceptHttpAudio(req.params.id, readToken(req), seq, req.body);
      res.status(accepted ? 204 : 404).end();
    },
  );

  router.post("/conversations/:id/control", (req, res) => {
    const accepted = gateway.acceptHttpControl(req.params.id, readToken(req), req.body);
    res.status(accepted ? 204 : 404).end();
  });

  return router;
}
