import type { Response, Router } from "express";
import type { AppContext } from "./app-context.js";
import { FeedCardNotFoundError, FeedCardValidationError } from "./feed-store.js";
import { focusEnum, focusRecord, focusText } from "./focus-details-store.js";
import { parseFocusLaunchRequest } from "./focus-session-launch-service.js";
import {
  FocusLaunchConflictError, publicFocusSessionLaunch, type FocusSessionCreationOptions, type FocusSessionLaunch,
} from "./focus-session-launch-store.js";
import { isRestartCutoverInProgress, refreshRestartState, RESTART_PENDING_MESSAGE } from "./restart-controller.js";

type ResolveCreationOptions = (body: unknown, scope?: { taskId?: string }) => Promise<{
  options?: FocusSessionCreationOptions; error?: string; status?: number;
}>;
class FocusLaunchRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
const OPTION_FIELDS = ["model", "reasoningEffort", "contextTier", "agent"] as const;

export function registerFocusSessionLaunchRoutes(router: Router, ctx: AppContext, resolveOptions: ResolveCreationOptions) {
  function service() {
    if (!ctx.focusSessionLaunchService) throw new Error("Focus session launch service is unavailable");
    return ctx.focusSessionLaunchService;
  }
  function sendError(res: Response, error: unknown) {
    const status = error instanceof FocusLaunchRequestError ? error.status
      : error instanceof FocusLaunchConflictError ? 409
        : error instanceof FeedCardValidationError ? 400 : error instanceof FeedCardNotFoundError ? 404 : 500;
    if (status === 503) res.set("Retry-After", "5");
    if (status === 500) console.error("[focus-launch] Request failed:", error);
    res.status(status).json({ error: error instanceof Error ? error.message : String(error) });
  }
  function sendReceipt(res: Response, receipt: FocusSessionLaunch, created = false, prepared = false) {
    const status = prepared || receipt.status === "ready" ? (created ? 201 : 200)
      : receipt.status === "unknown" || receipt.status === "superseded" ? 409
        : receipt.status === "failed" ? 502 : 202;
    res.status(status).json({
      created, sessionId: receipt.sessionId ?? receipt.expectedSessionId, receipt: publicFocusSessionLaunch(receipt),
      ...(receipt.error ? { error: receipt.error } : {}),
    });
  }
  async function assertCanStart() {
    if (isRestartCutoverInProgress(await refreshRestartState())) throw new FocusLaunchRequestError(RESTART_PENDING_MESSAGE, 503);
  }
  async function prepareRequest(body: unknown, routeTaskId?: string | null) {
    const raw = focusRecord(body, ["objectId", "activationId", "source", "taskId", "prompt", ...OPTION_FIELDS]);
    const optionInput: Record<string, unknown> = {};
    const identityInput = { ...raw };
    for (const field of OPTION_FIELDS) {
      if (raw[field] !== undefined) optionInput[field] = raw[field];
      delete identityInput[field];
    }
    const input = parseFocusLaunchRequest(identityInput);
    const taskId = service().resolveTaskId(input, routeTaskId);
    const resolved = await resolveOptions(optionInput, taskId ? { taskId } : {});
    if (resolved.error) throw new FocusLaunchRequestError(resolved.error, resolved.status ?? 400);
    return service().prepare(input, Object.keys(optionInput).length ? resolved.options ?? {} : undefined, routeTaskId);
  }
  async function startSessionRequest(body: unknown, routeTaskId: string | null, res: Response): Promise<void> {
    try {
      const raw = focusRecord(body, ["focusLaunch", "prompt", ...OPTION_FIELDS]);
      const identity = focusRecord(raw.focusLaunch, ["objectId", "activationId", "source"]);
      const { focusLaunch: _identity, ...rest } = raw;
      await assertCanStart();
      const prepared = await prepareRequest({ ...identity, ...rest }, routeTaskId);
      sendReceipt(res, await service().start(prepared.receipt.id), prepared.created);
    } catch (error) { sendError(res, error); }
  }

  router.get("/focus/session-launches", (req, res) => {
    try {
      const objectId = focusText(req.query.objectId, "objectId")!;
      const activationId = focusText(req.query.activationId, "activationId")!;
      if (req.query.source !== undefined) {
        const source = focusEnum(req.query.source, "source", ["launch_prompt", "discussion"] as const);
        const receipt = service().find({ objectId, activationId, source });
        res.json({ receipt: receipt ? publicFocusSessionLaunch(receipt) : null });
      } else {
        res.json({ receipts: service().list(objectId, activationId).map(publicFocusSessionLaunch) });
      }
    } catch (error) { sendError(res, error); }
  });
  router.get("/focus/session-launches/:id", (req, res) => {
    try {
      const receipt = service().get(String(req.params.id));
      if (!receipt) throw new FeedCardNotFoundError("Focus launch receipt not found");
      res.json({ receipt: publicFocusSessionLaunch(receipt) });
    } catch (error) { sendError(res, error); }
  });
  router.post("/focus/session-launches/prepare", async (req, res) => {
    try {
      const prepared = await prepareRequest(req.body);
      sendReceipt(res, prepared.receipt, prepared.created, true);
    } catch (error) { sendError(res, error); }
  });
  router.post("/focus/session-launches", async (req, res) => {
    try {
      await assertCanStart();
      const prepared = await prepareRequest(req.body);
      sendReceipt(res, await service().start(prepared.receipt.id), prepared.created);
    } catch (error) { sendError(res, error); }
  });
  router.post("/focus/session-launches/:id/start", async (req, res) => {
    try {
      focusRecord(req.body ?? {}, []);
      await assertCanStart();
      sendReceipt(res, await service().start(String(req.params.id)));
    } catch (error) { sendError(res, error); }
  });
  return { startSessionRequest };
}
