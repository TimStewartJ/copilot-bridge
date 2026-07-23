import {
  isCopilotModelPriceable,
  type CopilotModelMetadataForPricing,
} from "../shared/copilot-pricing.js";
import { createDeadline, settleByDeadline } from "./deadline.js";
import type { CopilotModelPriceStore } from "./copilot-model-price-store.js";

export type CopilotModelPriceRefreshState = "idle" | "refreshing";

export interface CopilotModelPriceSnapshot {
  readonly models: readonly CopilotModelMetadataForPricing[];
  readonly revision: number;
  readonly refreshState: CopilotModelPriceRefreshState;
  readonly refreshAttempt: number;
}

export interface CopilotModelPriceLoader {
  getSnapshot(): CopilotModelPriceSnapshot;
  refresh(options?: { force?: boolean }): Promise<CopilotModelPriceSnapshot>;
}

export interface CreateCopilotModelPriceLoaderOptions {
  loadModels: () => Promise<unknown>;
  store?: CopilotModelPriceStore;
  now?: () => number;
  refreshIntervalMs?: number;
  timeoutMs?: number;
}

const DEFAULT_REFRESH_INTERVAL_MS = 5 * 60_000;
const DEFAULT_TIMEOUT_MS = 10_000;

export function createCopilotModelPriceLoader({
  loadModels,
  store,
  now = Date.now,
  refreshIntervalMs = DEFAULT_REFRESH_INTERVAL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: CreateCopilotModelPriceLoaderOptions): CopilotModelPriceLoader {
  let snapshot: CopilotModelPriceSnapshot = {
    models: loadCachedModelPrices(store),
    revision: 0,
    refreshState: "idle",
    refreshAttempt: 0,
  };
  let lastAttemptAt: number | null = null;
  let nextAttempt = 0;
  let forceRerunRequested = false;
  let inflight: Promise<CopilotModelPriceSnapshot> | null = null;

  function getSnapshot(): CopilotModelPriceSnapshot {
    return snapshot;
  }

  function refresh(options: { force?: boolean } = {}): Promise<CopilotModelPriceSnapshot> {
    if (inflight) {
      forceRerunRequested ||= options.force === true;
      return inflight;
    }

    const currentTime = now();
    if (
      options.force !== true
      && lastAttemptAt !== null
      && currentTime - lastAttemptAt < Math.max(0, refreshIntervalMs)
    ) {
      return Promise.resolve(snapshot);
    }

    lastAttemptAt = currentTime;
    const promise = runRefreshCycle()
      .finally(() => {
        if (inflight === promise) {
          inflight = null;
        }
      });
    inflight = promise;
    return promise;
  }

  async function runRefreshCycle(): Promise<CopilotModelPriceSnapshot> {
    let result = await runRefreshAttempt();
    while (!result.succeeded && forceRerunRequested) {
      forceRerunRequested = false;
      lastAttemptAt = now();
      result = await runRefreshAttempt();
    }
    forceRerunRequested = false;
    return result.snapshot;
  }

  async function runRefreshAttempt(): Promise<{
    snapshot: CopilotModelPriceSnapshot;
    succeeded: boolean;
  }> {
    const attempt = ++nextAttempt;
    snapshot = {
      ...snapshot,
      refreshState: "refreshing",
      refreshAttempt: attempt,
    };
    const outcome = await settleByDeadline(loadModels, createDeadline(timeoutMs));
    if (outcome.status === "timed-out") {
      console.warn(
        `[copilot-usage] listModels() timed out after ${Math.max(0, timeoutMs)}ms; falling back to cached model prices.`,
      );
      return { snapshot: finishAttempt(attempt), succeeded: false };
    }
    if (outcome.status === "rejected") {
      console.warn("[copilot-usage] listModels() failed; falling back to cached model prices.", outcome.error);
      return { snapshot: finishAttempt(attempt), succeeded: false };
    }

    let liveModels: readonly CopilotModelMetadataForPricing[];
    try {
      liveModels = sanitizeCopilotModelMetadataForPricing(outcome.value);
    } catch (error) {
      console.warn("[copilot-usage] listModels() failed; falling back to cached model prices.", error);
      return { snapshot: finishAttempt(attempt), succeeded: false };
    }

    let models = snapshot.models;
    if (liveModels.length > 0) {
      if (store) {
        try {
          store.upsertModelPrices(liveModels);
        } catch (error) {
          console.warn("[copilot-usage] Failed to persist live model prices to cache.", error);
        }
      }

      let cachedModels = snapshot.models;
      if (store) {
        try {
          cachedModels = store.listModelPrices();
        } catch (error) {
          console.warn("[copilot-usage] Failed to read cached model prices.", error);
        }
      }
      models = mergeLiveAndCachedModelPrices(liveModels, cachedModels);
    }

    snapshot = {
      models,
      revision: snapshot.revision + 1,
      refreshState: "idle",
      refreshAttempt: attempt,
    };
    return { snapshot, succeeded: true };
  }

  function finishAttempt(attempt: number): CopilotModelPriceSnapshot {
    snapshot = {
      ...snapshot,
      refreshState: "idle",
      refreshAttempt: attempt,
    };
    return snapshot;
  }

  return { getSnapshot, refresh };
}

function loadCachedModelPrices(
  store: CopilotModelPriceStore | undefined,
): readonly CopilotModelMetadataForPricing[] {
  if (!store) return [];
  try {
    return store.listModelPrices();
  } catch (error) {
    console.warn("[copilot-usage] Failed to hydrate cached model prices.", error);
    return [];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toCopilotModelMetadataForPricing(value: unknown): CopilotModelMetadataForPricing | null {
  if (!isRecord(value)) return null;
  let record = value;
  if (typeof record.id !== "string" && typeof record.toJSON === "function") {
    const serialized = record.toJSON();
    if (isRecord(serialized)) record = serialized;
  }
  if (typeof record.id !== "string") return null;
  const id = record.id.trim();
  if (!id) return null;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const billing = isRecord(record.billing) ? sanitizeCopilotBilling(record.billing) : undefined;
  const capabilities = isRecord(record.capabilities) ? sanitizeCopilotCapabilities(record.capabilities) : undefined;
  return {
    id,
    ...(name ? { name } : {}),
    ...(billing ? { billing } : {}),
    ...(capabilities ? { capabilities } : {}),
  };
}

function sanitizeCopilotBilling(
  record: Record<string, unknown>,
): CopilotModelMetadataForPricing["billing"] | undefined {
  const multiplier = typeof record.multiplier === "number" && Number.isFinite(record.multiplier)
    ? record.multiplier
    : undefined;
  const tokenPrices = isRecord(record.tokenPrices) ? sanitizeCopilotTokenPrices(record.tokenPrices) : undefined;
  if (multiplier === undefined && !tokenPrices) return undefined;
  return {
    ...(multiplier !== undefined ? { multiplier } : {}),
    ...(tokenPrices ? { tokenPrices } : {}),
  };
}

function sanitizeCopilotTokenPrices(
  record: Record<string, unknown>,
): NonNullable<NonNullable<CopilotModelMetadataForPricing["billing"]>["tokenPrices"]> | undefined {
  const tokenPrices = {
    ...copyFiniteNumber(record, "inputPrice"),
    ...copyFiniteNumber(record, "outputPrice"),
    ...copyFiniteNumber(record, "cachePrice"),
    ...copyFiniteNumber(record, "batchSize"),
    ...copyFiniteNumber(record, "contextMax"),
    ...(isRecord(record.longContext) ? { longContext: sanitizeCopilotTokenPrices(record.longContext) } : {}),
  };
  return Object.keys(tokenPrices).length > 0 ? tokenPrices : undefined;
}

function sanitizeCopilotCapabilities(
  record: Record<string, unknown>,
): CopilotModelMetadataForPricing["capabilities"] | undefined {
  const limits = isRecord(record.limits)
    ? {
        ...copyFiniteNumber(record.limits, "max_context_window_tokens"),
        ...copyFiniteNumber(record.limits, "max_prompt_tokens"),
        ...copyFiniteNumber(record.limits, "max_output_tokens"),
      }
    : undefined;
  if (!limits || Object.keys(limits).length === 0) return undefined;
  return { limits };
}

function copyFiniteNumber<const Key extends string>(
  record: Record<string, unknown>,
  key: Key,
): { [K in Key]?: number } {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value)
    ? { [key]: value } as { [K in Key]?: number }
    : {};
}

function sanitizeCopilotModelMetadataForPricing(
  value: unknown,
): readonly CopilotModelMetadataForPricing[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(toCopilotModelMetadataForPricing)
    .filter((model): model is CopilotModelMetadataForPricing => model !== null);
}

function mergeLiveAndCachedModelPrices(
  liveModels: readonly CopilotModelMetadataForPricing[],
  cachedModels: readonly CopilotModelMetadataForPricing[],
): readonly CopilotModelMetadataForPricing[] {
  const byId = new Map<string, CopilotModelMetadataForPricing>();
  const order: string[] = [];
  const remember = (model: CopilotModelMetadataForPricing): void => {
    if (!byId.has(model.id)) order.push(model.id);
    byId.set(model.id, model);
  };

  for (const model of liveModels) {
    if (isCopilotModelPriceable(model)) remember(model);
  }
  for (const model of cachedModels) {
    if (!byId.has(model.id) && isCopilotModelPriceable(model)) remember(model);
  }
  for (const model of liveModels) {
    if (!byId.has(model.id)) remember(model);
  }

  return order.map((id) => byId.get(id)!);
}
