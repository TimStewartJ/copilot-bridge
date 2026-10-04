import type { AppContext } from "./app-context.js";
import { parseDeferId, type DeferKind } from "./defer-ids.js";
import { emitSessionDeferSummary } from "./defer-summary.js";

export type DeferReactivation =
  | {
      ok: true;
      kind: DeferKind;
      status: string;
      nextRunAt?: string;
      /** The defer itself was not restarted; its undelivered result was queued for the chat again. */
      deliveryRetried?: true;
    }
  | { ok: false; reason: "unavailable" | "not_found" | "not_stopped"; message: string };

/**
 * Restart a stopped defer (failed, cancelled or expired). A defer that is not stopped but
 * whose result never reached its chat gets that result sent again instead.
 */
export function reactivateDefer(
  ctx: Pick<
    AppContext,
    "deferredPromptStore" | "deferLoopStore" | "deferredPromptRunner" | "deferLoopRunner" | "globalBus"
  >,
  sessionId: string,
  deferId: string,
): DeferReactivation {
  const parsed = parseDeferId(deferId);
  if (!parsed) return { ok: false, reason: "not_found", message: "deferId must start with once_ or interval_." };
  const store = parsed.kind === "once" ? ctx.deferredPromptStore : ctx.deferLoopStore;
  if (!store) return { ok: false, reason: "unavailable", message: "Deferred work store is unavailable." };

  const existing = store.get(parsed.id);
  if (!existing) return { ok: false, reason: "not_found", message: `Defer ${deferId} not found.` };
  if (existing.sessionId !== sessionId) {
    return { ok: false, reason: "not_found", message: `Defer ${deferId} does not belong to this session.` };
  }

  if (store.reactivate(parsed.id)) {
    // A message that it stopped, not yet delivered, is now untrue.
    ctx.deferredPromptStore?.retireUndeliveredFinalMessagesForSource(sessionId, deferId);
    emitSessionDeferSummary(ctx.globalBus, sessionId, ctx);
    (parsed.kind === "once" ? ctx.deferredPromptRunner : ctx.deferLoopRunner)?.poke();
    const updated = store.get(parsed.id);
    return {
      ok: true,
      kind: parsed.kind,
      status: updated?.status ?? (parsed.kind === "once" ? "pending" : "active"),
      nextRunAt: updated && ("runAt" in updated ? updated.runAt : updated.nextRunAt),
    };
  }

  if ((ctx.deferredPromptStore?.reactivateFailedDeliveryForSource(sessionId, deferId) ?? 0) > 0) {
    ctx.deferredPromptRunner?.poke();
    return { ok: true, kind: parsed.kind, status: existing.status, deliveryRetried: true };
  }
  return {
    ok: false,
    reason: "not_stopped",
    message: `Defer ${deferId} is ${existing.status} and cannot be reactivated.`,
  };
}
