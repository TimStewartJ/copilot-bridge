// HTTP routes for triggers, mounted under /api by the API router.

import type express from "express";
import type { AppContext } from "../app-context.js";
import { isCanonicalSessionId } from "../outbound-attachments.js";
import {
  listTriggerDeliveries,
  listTriggerWorkerRuns,
  sortTriggerViews,
  toTriggerView,
} from "./activity.js";
import { findUnknownFields, formatUnknownFieldsError } from "../request-fields.js";
import { normalizeTriggerId, type TriggerResult } from "./service.js";

type RejectCrossSite = (req: express.Request, res: express.Response, actionLabel: string) => boolean;

const CREATE_FIELDS = [
  "name", "prompt", "then", "sessionId", "taskId", "title", "modelTier", "playbook", "keepChats",
  "delaySeconds", "runAt", "intervalSeconds", "cron", "timezone", "check", "maxRuns", "expiresAt",
];
const UPDATE_FIELDS = [
  "name", "prompt", "title", "modelTier", "playbook", "keepChats",
  "delaySeconds", "runAt", "intervalSeconds", "cron", "timezone", "check", "maxRuns", "expiresAt", "active",
];

export function registerTriggerRoutes(router: express.Router, ctx: AppContext, rejectCrossSite: RejectCrossSite): void {
  const service = () => ctx.triggerService;
  const store = () => ctx.triggerStore;

  function send(res: express.Response, result: TriggerResult, status = 200) {
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    return res.status(status).json(toTriggerView(result.trigger));
  }

  /** Stopped triggers whose last message failed to reach the chat can send it again. */
  function failedDeliveryTriggerIds(sessionId: string): Set<string> {
    return new Set(listTriggerDeliveries(ctx.deferredPromptStore, sessionId)
      .filter((delivery) => delivery.status === "failed")
      .map((delivery) => delivery.triggerId));
  }

  // A chat's triggers with their recent worker runs and messages, or a task's triggers.
  router.get("/triggers", (req, res) => {
    const triggerStore = store();
    if (!triggerStore) return res.status(503).json({ error: "Triggers are unavailable." });
    const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : undefined;
    const taskId = typeof req.query.taskId === "string" ? req.query.taskId.trim() : undefined;
    if (!sessionId && !taskId) return res.status(400).json({ error: "sessionId or taskId is required." });
    if (sessionId && !isCanonicalSessionId(sessionId)) return res.status(400).json({ error: "Valid sessionId is required." });
    const includeInactive = req.query.includeInactive !== "false";
    if (sessionId) {
      const failed = failedDeliveryTriggerIds(sessionId);
      return res.json({
        sessionId,
        triggers: sortTriggerViews(triggerStore.list({ sessionId, includeInactive })
          .map((trigger) => toTriggerView(trigger, { failedDelivery: failed.has(trigger.id) }))),
        recentRuns: listTriggerWorkerRuns(ctx.telemetryStore, sessionId, { deferredPromptStore: ctx.deferredPromptStore }),
        recentDeliveries: listTriggerDeliveries(ctx.deferredPromptStore, sessionId),
      });
    }
    return res.json({
      taskId,
      triggers: sortTriggerViews(triggerStore.list({ taskId, includeInactive }).map((trigger) => toTriggerView(trigger))),
    });
  });

  router.get("/triggers/:id", (req, res) => {
    const trigger = service()?.get(req.params.id);
    if (!trigger) return res.status(404).json({ error: "Trigger not found." });
    return res.json(toTriggerView(trigger));
  });

  // Worker runs and messages of one chat trigger.
  router.get("/triggers/:id/runs", (req, res) => {
    const trigger = service()?.get(req.params.id);
    if (!trigger) return res.status(404).json({ error: "Trigger not found." });
    if (!trigger.sessionId) return res.json({ triggerId: trigger.id, runs: [], deliveries: [] });
    return res.json({
      triggerId: trigger.id,
      runs: listTriggerWorkerRuns(ctx.telemetryStore, trigger.sessionId, { triggerId: trigger.id, limit: 200, deferredPromptStore: ctx.deferredPromptStore }),
      deliveries: listTriggerDeliveries(ctx.deferredPromptStore, trigger.sessionId, { triggerId: trigger.id, limit: 200 }),
    });
  });

  router.post("/triggers", (req, res) => {
    if (rejectCrossSite(req, res, "Trigger creation")) return;
    const triggerService = service();
    if (!triggerService) return res.status(503).json({ error: "Triggers are unavailable." });
    const unknown = findUnknownFields(req.body, CREATE_FIELDS);
    if (unknown.length > 0) return res.status(400).json({ error: formatUnknownFieldsError(unknown) });
    return send(res, triggerService.create(req.body ?? {}), 201);
  });

  router.patch("/triggers/:id", (req, res) => {
    if (rejectCrossSite(req, res, "Trigger changes")) return;
    const triggerService = service();
    if (!triggerService) return res.status(503).json({ error: "Triggers are unavailable." });
    const unknown = findUnknownFields(req.body, UPDATE_FIELDS);
    if (unknown.length > 0) return res.status(400).json({ error: formatUnknownFieldsError(unknown) });
    return send(res, triggerService.update(normalizeTriggerId(req.params.id), req.body ?? {}));
  });

  router.delete("/triggers/:id", (req, res) => {
    if (rejectCrossSite(req, res, "Trigger deletion")) return;
    const triggerService = service();
    if (!triggerService) return res.status(503).json({ error: "Triggers are unavailable." });
    const result = triggerService.remove(req.params.id);
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    return res.json({ ok: true, id: result.trigger.id });
  });

  router.post("/triggers/:id/run", (req, res) => {
    if (rejectCrossSite(req, res, "Running a trigger")) return;
    const triggerService = service();
    if (!triggerService) return res.status(503).json({ error: "Triggers are unavailable." });
    return send(res, triggerService.runNow(req.params.id));
  });

  router.post("/triggers/:id/cancel", (req, res) => {
    if (rejectCrossSite(req, res, "Trigger cancellation")) return;
    const triggerService = service();
    if (!triggerService) return res.status(503).json({ error: "Triggers are unavailable." });
    return send(res, triggerService.cancel(req.params.id));
  });

  router.post("/triggers/:id/reactivate", (req, res) => {
    if (rejectCrossSite(req, res, "Trigger reactivation")) return;
    const triggerService = service();
    if (!triggerService) return res.status(503).json({ error: "Triggers are unavailable." });
    const result = triggerService.reactivate(req.params.id);
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    return res.json({ ...toTriggerView(result.trigger), ...(result.deliveryRetried ? { deliveryRetried: true } : {}) });
  });
}
