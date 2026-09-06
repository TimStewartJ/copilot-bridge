import type { Router } from "express";
import type { AppContext } from "./app-context.js";
import { FeedCardNotFoundError, FeedCardValidationError } from "./feed-store.js";
import { focusRecord } from "./focus-details-store.js";
import { FocusProtectionConflictError } from "./focus-protection-store.js";
import { FocusProtectionUnavailableError } from "./focus-protection-service.js";

export function registerFocusProtectionRoutes(router: Router, ctx: AppContext): void {
  const service = () => {
    if (!ctx.focusProtectionService) throw new FocusProtectionUnavailableError("Protection service is unavailable");
    return ctx.focusProtectionService;
  };
  function pageNumber(value: unknown, name: string, fallback: number): number {
    if (value === undefined) return fallback;
    if (typeof value !== "string" || !/^\d+$/.test(value)) throw new FeedCardValidationError(`${name} must be an integer`);
    return Number(value);
  }
  router.get("/focus/protection/current", (_req, res, next) => {
    try { res.json(service().current()); } catch (error) { next(error); }
  });
  router.get("/focus/protection", (req, res, next) => {
    try {
      res.json(service().list({ limit: pageNumber(req.query.limit, "limit", 50), offset: pageNumber(req.query.offset, "offset", 0) }));
    } catch (error) { next(error); }
  });
  router.post("/focus/protection/preview", (req, res, next) => {
    try { res.json(service().preview(req.body)); } catch (error) { next(error); }
  });
  router.post("/focus/protection", (req, res, next) => {
    try { res.status(201).json({ window: service().create(req.body) }); } catch (error) { next(error); }
  });
  router.post("/focus/protection/:id/cancel", (req, res, next) => {
    try {
      focusRecord(req.body, []);
      res.json({ window: service().cancel(String(req.params.id)) });
    } catch (error) { next(error); }
  });
  router.use("/focus/protection", (error: unknown, _req: import("express").Request, res: import("express").Response,
    _next: import("express").NextFunction) => {
    if (error instanceof FeedCardValidationError) { res.status(400).json({ error: error.message }); return; }
    if (error instanceof FeedCardNotFoundError) { res.status(404).json({ error: error.message }); return; }
    if (error instanceof FocusProtectionConflictError) { res.status(409).json({ error: error.message }); return; }
    if (error instanceof FocusProtectionUnavailableError) { res.status(503).json({ error: error.message }); return; }
    console.error("[focus-protection] Request failed:", error);
    res.status(500).json({ error: "Protection state or impact preview could not be read. Retry before assuming protection." });
  });
}
