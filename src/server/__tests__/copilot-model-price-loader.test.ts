import { afterEach, describe, expect, it, vi } from "vitest";
import { createCopilotModelPriceLoader } from "../copilot-model-price-loader.js";
import { createCopilotModelPriceStore } from "../copilot-model-price-store.js";
import { openMemoryDatabase } from "../db.js";

function priceableModel(id: string, outputPriceUsd: number) {
  return {
    id,
    name: id,
    billing: {
      tokenPrices: {
        inputPrice: 250,
        outputPrice: outputPriceUsd * 100,
        cachePrice: 25,
        batchSize: 1_000_000,
      },
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("createCopilotModelPriceLoader", () => {
  it("deduplicates a hung provider, times out, ignores late completion, and retries", async () => {
    vi.useFakeTimers();
    const db = openMemoryDatabase();
    const store = createCopilotModelPriceStore(db);
    const cachedModel = priceableModel("gpt-5.4", 15);
    const freshModel = priceableModel("gpt-5.4", 30);
    store.upsertModelPrices([cachedModel]);
    const pending: Array<(models: unknown[]) => void> = [];
    const loadModels = vi.fn(() => new Promise<unknown[]>((resolve) => {
      pending.push(resolve);
    }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const loader = createCopilotModelPriceLoader({
      loadModels,
      store,
      timeoutMs: 100,
      refreshIntervalMs: 60_000,
    });

    try {
      expect(loader.getSnapshot()).toMatchObject({
        models: [cachedModel],
        revision: 0,
        refreshState: "idle",
        refreshAttempt: 0,
      });

      const first = loader.refresh();
      const duplicate = loader.refresh();
      expect(duplicate).toBe(first);
      expect(loadModels).toHaveBeenCalledTimes(1);
      expect(loader.getSnapshot().refreshState).toBe("refreshing");

      await vi.advanceTimersByTimeAsync(100);
      await expect(first).resolves.toMatchObject({
        models: [cachedModel],
        revision: 0,
        refreshState: "idle",
        refreshAttempt: 1,
      });

      pending[0]?.([freshModel]);
      await Promise.resolve();
      expect(loader.getSnapshot()).toMatchObject({
        models: [cachedModel],
        revision: 0,
        refreshState: "idle",
        refreshAttempt: 1,
      });

      const retry = loader.refresh({ force: true });
      expect(loadModels).toHaveBeenCalledTimes(2);
      pending[1]?.([freshModel]);
      await expect(retry).resolves.toMatchObject({
        models: [freshModel],
        revision: 1,
        refreshState: "idle",
        refreshAttempt: 2,
      });
    } finally {
      db.close();
    }
  });

  it("keeps cached prices when a successful live response is empty", async () => {
    const db = openMemoryDatabase();
    const store = createCopilotModelPriceStore(db);
    const cachedModel = priceableModel("retired-model", 20);
    store.upsertModelPrices([cachedModel]);
    const loader = createCopilotModelPriceLoader({
      loadModels: async () => [],
      store,
    });

    try {
      await expect(loader.refresh({ force: true })).resolves.toMatchObject({
        models: [cachedModel],
        revision: 1,
        refreshState: "idle",
      });
    } finally {
      db.close();
    }
  });

  it("queues a forced retry behind an inflight attempt that times out", async () => {
    vi.useFakeTimers();
    const pending: Array<(models: unknown[]) => void> = [];
    const loadModels = vi.fn(() => new Promise<unknown[]>((resolve) => {
      pending.push(resolve);
    }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const loader = createCopilotModelPriceLoader({
      loadModels,
      timeoutMs: 100,
      refreshIntervalMs: 60_000,
    });

    const initial = loader.refresh();
    const forced = loader.refresh({ force: true });
    expect(forced).toBe(initial);
    expect(loadModels).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(100);
    expect(loadModels).toHaveBeenCalledTimes(2);
    expect(loader.getSnapshot()).toMatchObject({
      refreshState: "refreshing",
      refreshAttempt: 2,
    });

    const freshModel = priceableModel("gpt-5.4", 30);
    pending[1]?.([freshModel]);
    await expect(forced).resolves.toMatchObject({
      models: [freshModel],
      revision: 1,
      refreshState: "idle",
      refreshAttempt: 2,
    });
  });
});
