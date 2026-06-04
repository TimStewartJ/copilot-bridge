import { describe, expect, it, vi } from "vitest";
import { openMemoryDatabase } from "../db.js";
import { createCopilotModelPriceStore } from "../copilot-model-price-store.js";
import type { CopilotModelMetadataForPricing } from "../../shared/copilot-pricing.js";

function priceable(id: string, inputPrice: number): CopilotModelMetadataForPricing {
  return {
    id,
    name: id,
    billing: {
      tokenPrices: { inputPrice, outputPrice: inputPrice * 5, cachePrice: inputPrice / 10, batchSize: 1_000_000 },
    },
  };
}

describe("createCopilotModelPriceStore", () => {
  it("persists and lists priceable models", () => {
    const db = openMemoryDatabase();
    const store = createCopilotModelPriceStore(db);

    store.upsertModelPrices([priceable("model-a", 300), priceable("model-b", 100)]);

    const listed = store.listModelPrices().sort((l, r) => l.id.localeCompare(r.id));
    expect(listed.map((m) => m.id)).toEqual(["model-a", "model-b"]);
    expect(listed[0]?.billing?.tokenPrices?.inputPrice).toBe(300);
  });

  it("skips models without usable token prices", () => {
    const db = openMemoryDatabase();
    const store = createCopilotModelPriceStore(db);

    store.upsertModelPrices([
      { id: "auto", name: "Auto" },
      { id: "multiplier-only", billing: { multiplier: 1 } },
      priceable("model-a", 300),
    ]);

    expect(store.listModelPrices().map((m) => m.id)).toEqual(["model-a"]);
  });

  it("overwrites an existing entry on conflict with the newer prices", () => {
    const db = openMemoryDatabase();
    const store = createCopilotModelPriceStore(db);

    store.upsertModelPrices([priceable("model-a", 300)]);
    store.upsertModelPrices([priceable("model-a", 999)]);

    const listed = store.listModelPrices();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.billing?.tokenPrices?.inputPrice).toBe(999);
  });

  it("treats an empty upsert as a no-op", () => {
    const db = openMemoryDatabase();
    const store = createCopilotModelPriceStore(db);

    store.upsertModelPrices([]);
    expect(store.listModelPrices()).toEqual([]);
  });

  it("skips corrupted rows without failing the whole read", () => {
    const db = openMemoryDatabase();
    const store = createCopilotModelPriceStore(db);
    store.upsertModelPrices([priceable("model-a", 300)]);
    db.prepare(
      "INSERT INTO copilot_model_prices (id, name, metadataJson, updatedAt) VALUES (?, ?, ?, ?)",
    ).run("broken", "Broken", "{not valid json", new Date().toISOString());

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(store.listModelPrices().map((m) => m.id)).toEqual(["model-a"]);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("Skipping corrupted price row"),
        expect.anything(),
      );
    } finally {
      warn.mockRestore();
    }
  });
});
