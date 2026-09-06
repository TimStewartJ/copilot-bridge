import type { Request, Response, Router } from "express";
import type { AppContext } from "./app-context.js";
import { FeedCardNotFoundError, FeedCardValidationError } from "./feed-store.js";
import { focusEnum, focusInteger, focusRecord, focusText } from "./focus-details-store.js";
import { normalizeFocusReadFilters } from "./focus-dashboard-projection.js";
import { serializeFocusHistoryPage, serializeFocusObject } from "./focus-serialization.js";

function queryInt(value: unknown, field: string, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw new FeedCardValidationError(`${field} must be an integer`);
  return focusInteger(Number(value), field, min, max);
}
function page(req: Request) {
  return { limit: queryInt(req.query.limit, "limit", 50, 1, 100), offset: queryInt(req.query.offset, "offset", 0, 0, 1_000_000) };
}
function sendError(res: Response, error: unknown): void {
  if (error instanceof FeedCardValidationError) { res.status(400).json({ error: error.message }); return; }
  if (error instanceof FeedCardNotFoundError) { res.status(404).json({ error: error.message }); return; }
  console.error("[focus:governance] Request failed:", error);
  res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
}

export function registerFocusGovernanceRoutes(router: Router, ctx: AppContext): void {
  function read(path: string, handler: (req: Request) => unknown): void {
    router.get(path, (req, res) => {
      try { res.json(handler(req)); } catch (error) { sendError(res, error); }
    });
  }
  function mutation(method: "post" | "patch" | "delete", path: string, handler: (req: Request) => unknown): void {
    router[method](path, (req, res) => {
      try {
        const result = handler(req);
        ctx.globalBus.emit({ type: "focus:changed", reason: "governance-changed", meaningful: true });
        res.json(result);
      } catch (error) { sendError(res, error); }
    });
  }
  read("/focus/authority", (req) => ({ grants: ctx.focusAuthorityStore.list({
    ...page(req), ...(req.query.status === undefined ? {} : { status: focusEnum(req.query.status, "status", ["active", "revoked"] as const) }),
  }) }));
  mutation("post", "/focus/authority", (req) => ({ grant: ctx.focusAuthorityStore.save(req.body, "user") }));
  mutation("patch", "/focus/authority/:id", (req) => {
    if (typeof req.body !== "object" || req.body === null || Array.isArray(req.body)) throw new FeedCardValidationError("Body must be an object");
    if ("id" in req.body || "key" in req.body) throw new FeedCardValidationError("Do not supply id/key in a PATCH body");
    return { grant: ctx.focusAuthorityStore.save({ ...req.body, id: req.params.id }, "user") };
  });
  mutation("post", "/focus/authority/:id/revoke", (req) => {
    const input = focusRecord(req.body, ["reason"]);
    return { grant: ctx.focusAuthorityStore.revoke(String(req.params.id), focusText(input.reason, "reason")!, "user") };
  });

  read("/focus/coverage", (req) => {
    const assertions = ctx.focusCoverageStore.list(page(req));
    return { assertions, summary: ctx.focusCoverageStore.summarize(ctx.focusCoverageStore.all()) };
  });
  mutation("post", "/focus/coverage", (req) => ({ assertion: ctx.focusCoverageStore.save(req.body, "user") }));
  mutation("patch", "/focus/coverage/:id", (req) => {
    if (typeof req.body !== "object" || req.body === null || Array.isArray(req.body)) throw new FeedCardValidationError("Body must be an object");
    if ("id" in req.body || "key" in req.body) throw new FeedCardValidationError("Do not supply id/key in a PATCH body");
    return { assertion: ctx.focusCoverageStore.save({ ...req.body, id: req.params.id }, "user") };
  });
  mutation("delete", "/focus/coverage/:id", (req) => ({ deleted: ctx.focusCoverageStore.remove(String(req.params.id)) }));

  read("/focus/audits", (req) => ({ audits: ctx.focusAuditStore.list({
    ...page(req), ...(req.query.status === undefined ? {} : { status: focusEnum(req.query.status, "status", ["open", "resolved", "dismissed"] as const) }),
  }) }));
  mutation("post", "/focus/audits", (req) => ({ audit: ctx.focusAuditStore.save(req.body, "user") }));
  mutation("patch", "/focus/audits/:id", (req) => {
    if (typeof req.body !== "object" || req.body === null || Array.isArray(req.body)) throw new FeedCardValidationError("Body must be an object");
    if ("id" in req.body) throw new FeedCardValidationError("Do not supply id in a PATCH body");
    return { audit: ctx.focusAuditStore.save({ ...req.body, id: req.params.id }, "user") };
  });
  read("/focus/history", (req) => serializeFocusHistoryPage(ctx.focusProjection.listHistory({
    ...normalizeFocusReadFilters(req.query),
    ...page(req), ...(req.query.objectId === undefined ? {} : { objectId: focusText(req.query.objectId, "objectId")! }),
    ...(req.query.objectType === undefined ? {} : { objectType: focusEnum(req.query.objectType, "objectType", ["decision", "alert", "event", "action"] as const) }),
  })));
  read("/focus/history/:id/transitions", (req) => ({ transitions: ctx.focusTransitionStore.list(String(req.params.id), page(req)) }));
  read("/focus/objects/:id/episodes/:activationId", (req) => {
    const episode = ctx.focusProjection.getEpisode(String(req.params.id), String(req.params.activationId), page(req));
    return { ...episode, currentObject: episode.currentObject ? serializeFocusObject(episode.currentObject) : null };
  });
  read("/focus/quiet-concerns", (req) => {
    const concerns = ctx.focusProjection.listQuietConcerns({
      ...page(req), ...normalizeFocusReadFilters(req.query),
      ...(req.query.objectType === undefined ? {} : { objectType: focusEnum(req.query.objectType, "objectType", ["decision", "alert"] as const) }),
    });
    return { ...concerns, objects: concerns.objects.map((object) => ({
      ...serializeFocusObject(object), attentionVisible: object.attentionVisible, suppressionReason: object.suppressionReason,
    })) };
  });
  mutation("post", "/focus/digests/viewed", (req) => {
    const input = focusRecord(req.body, ["digestId", "viewedAt"]);
    return { view: ctx.focusProjection.markDigestViewed(focusText(input.digestId, "digestId")!, input.viewedAt === undefined ? undefined : focusText(input.viewedAt, "viewedAt")!) };
  });
  read("/focus/metrics", (req) => {
    const days = queryInt(req.query.days, "days", 7, 1, 90);
    ctx.focusNotificationDeliveryStore.reconcileStaleClaims();
    return ctx.focusAttentionStore.metrics({ days });
  });
  read("/focus/attention-events", (req) => ({ events: ctx.focusAttentionStore.list({
    limit: page(req).limit, ...(req.query.objectId === undefined ? {} : { objectId: focusText(req.query.objectId, "objectId")! }),
  }) }));
  read("/focus/notification-deliveries", (req) => ({ deliveries: ctx.focusNotificationDeliveryStore.list(page(req).limit) }));
}
