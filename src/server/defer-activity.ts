import type { DeferLoop } from "./defer-loop-store.js";
import type { DeferWorkerAction, DeferWorkerKind } from "./defer-worker.js";
import type { DeferCheckpoint } from "./defer-checkpoint.js";
import type { DeferredPrompt, DeferredPromptStore } from "./deferred-prompt-store.js";
import type { TelemetrySpan, TelemetryStore } from "./telemetry-store.js";

export type DeferDeliveryStatus = "pending" | "running" | "completed" | "failed";

export type DeferActivityStatus =
  | DeferLoop["status"]
  | DeferredPrompt["status"];

export interface DeferActivityItem {
  deferId: string;
  kind: DeferWorkerKind;
  name?: string;
  prompt: string;
  checkpoint?: DeferCheckpoint;
  status: DeferActivityStatus;
  nextRunAt: string;
  intervalSeconds?: number;
  runCount?: number;
  maxRuns?: number;
  expiresAt?: string;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
  canCancel: boolean;
  canReactivate: boolean;
  failedDelivery?: boolean;
}

export interface DeferActivityRun {
  id: number;
  deferId: string;
  kind: DeferWorkerKind;
  action: DeferWorkerAction | "error";
  durationMs: number;
  completedAt: string;
  model?: string;
  reasoningEffort?: string;
  contextTier?: string;
  runCount?: number;
  error?: string;
  deliveryId?: string;
  deliveryStatus?: DeferDeliveryStatus;
  deliveryError?: string;
}

export interface DeferActivityDelivery {
  id: string;
  deferId: string;
  status: DeferDeliveryStatus;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export function formatOneShotDeferActivity(item: DeferredPrompt): DeferActivityItem {
  return {
    deferId: item.deferId,
    kind: "once",
    prompt: item.prompt,
    status: item.status,
    nextRunAt: item.runAt,
    attempts: item.attempts,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    ...(item.lastError ? { lastError: item.lastError } : {}),
    canCancel: item.status === "pending",
    canReactivate: item.status === "failed" || item.status === "cancelled",
  };
}

export function formatLoopDeferActivity(loop: DeferLoop): DeferActivityItem {
  return {
    deferId: loop.deferId,
    kind: "interval",
    ...(loop.name ? { name: loop.name } : {}),
    prompt: loop.prompt,
    ...(loop.checkpoint ? { checkpoint: loop.checkpoint } : {}),
    status: loop.status,
    nextRunAt: loop.nextRunAt,
    intervalSeconds: loop.intervalSeconds,
    runCount: loop.runCount,
    ...(loop.maxRuns !== undefined ? { maxRuns: loop.maxRuns } : {}),
    ...(loop.expiresAt ? { expiresAt: loop.expiresAt } : {}),
    attempts: loop.attempts,
    createdAt: loop.createdAt,
    updatedAt: loop.updatedAt,
    ...(loop.lastError ? { lastError: loop.lastError } : {}),
    canCancel: loop.status === "active",
    canReactivate: loop.status === "failed"
      || loop.status === "cancelled"
      || loop.status === "expired",
  };
}

function optionalString(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalRunCount(metadata: Record<string, unknown>): number | undefined {
  const value = metadata.runCount;
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function parseWorkerRun(span: TelemetrySpan): DeferActivityRun | undefined {
  const metadata = span.metadata;
  if (!metadata) return undefined;
  const deferId = optionalString(metadata, "deferId");
  const kind = metadata.kind;
  const action = metadata.action;
  if (
    !deferId
    || (kind !== "once" && kind !== "interval")
    || (
      action !== "continue"
      && action !== "notify"
      && action !== "finish"
      && action !== "return"
      && action !== "expired"
      && action !== "error"
    )
  ) {
    return undefined;
  }
  return {
    id: span.id,
    deferId,
    kind,
    action,
    durationMs: span.duration,
    completedAt: span.createdAt,
    ...optionalString(metadata, "model") ? { model: optionalString(metadata, "model") } : {},
    ...optionalString(metadata, "reasoningEffort")
      ? { reasoningEffort: optionalString(metadata, "reasoningEffort") }
      : {},
    ...optionalString(metadata, "contextTier")
      ? { contextTier: optionalString(metadata, "contextTier") }
      : {},
    ...optionalRunCount(metadata) ? { runCount: optionalRunCount(metadata) } : {},
    ...optionalString(metadata, "error") ? { error: optionalString(metadata, "error") } : {},
    ...optionalString(metadata, "deliveryId")
      ? { deliveryId: optionalString(metadata, "deliveryId") }
      : {},
  };
}

export function listDeferActivityRuns(
  telemetryStore: TelemetryStore | undefined,
  sessionId: string,
  options: {
    deferId?: string;
    limit?: number;
    deferredPromptStore?: Pick<DeferredPromptStore, "get">;
  } = {},
): DeferActivityRun[] {
  if (!telemetryStore) return [];
  const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
  return telemetryStore
    .querySpans({
      name: "defer.worker",
      sessionId,
      source: "server",
      limit,
      ...(options.deferId ? { metadataEquals: { deferId: options.deferId } } : {}),
    })
    .map(parseWorkerRun)
    .filter((run): run is DeferActivityRun =>
      !!run && (!options.deferId || run.deferId === options.deferId)
    )
    .map((run) => {
      const delivery = run.deliveryId
        ? options.deferredPromptStore?.get(run.deliveryId)
        : undefined;
      return delivery?.purpose === "delivery" && delivery.status !== "cancelled"
        ? {
            ...run,
            deliveryStatus: delivery.status,
            ...(delivery.lastError ? { deliveryError: delivery.lastError } : {}),
          }
        : run;
    })
    .slice(0, limit);
}

export function listDeferActivityDeliveries(
  deferredPromptStore: Pick<DeferredPromptStore, "listDeliveriesForSession"> | undefined,
  sessionId: string,
  options: { deferId?: string; limit?: number } = {},
): DeferActivityDelivery[] {
  if (!deferredPromptStore) return [];
  const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
  return deferredPromptStore
    .listDeliveriesForSession(sessionId)
    .filter((item) =>
      item.status !== "cancelled"
      && !!item.sourceId
      && (!options.deferId || item.sourceId === options.deferId)
    )
    .slice(0, limit)
    .map((item) => ({
      id: item.id,
      deferId: item.sourceId!,
      status: item.status as DeferDeliveryStatus,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      ...(item.lastError ? { error: item.lastError } : {}),
    }));
}

export function sortDeferActivityItems(items: DeferActivityItem[]): DeferActivityItem[] {
  const active = new Set<DeferActivityStatus>(["active", "pending", "running"]);
  return [...items].sort((left, right) => {
    const activeDifference = Number(!active.has(left.status)) - Number(!active.has(right.status));
    if (activeDifference !== 0) return activeDifference;
    if (active.has(left.status) && active.has(right.status)) {
      return Date.parse(left.nextRunAt) - Date.parse(right.nextRunAt);
    }
    return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  });
}
