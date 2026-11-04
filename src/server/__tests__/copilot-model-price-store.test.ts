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
  it("keeps usable prices and replaces only the repriced model on the next refresh", () => {
    const db = openMemoryDatabase();
    const store = createCopilotModelPriceStore(db);

    store.upsertModelPrices([
      { id: "auto", name: "Auto" },
      { id: "multiplier-only", billing: { multiplier: 1 } },
      priceable("model-a", 300),
      priceable("model-b", 100),
    ]);

    const listed = store.listModelPrices().sort((a, b) => a.id.localeCompare(b.id));
    expect(listed.map((model) => [model.id, model.billing?.tokenPrices?.inputPrice]))
      .toEqual([["model-a", 300], ["model-b", 100]]);

    store.upsertModelPrices([priceable("model-a", 999)]);
    const prices = store.listModelPrices().map((model) => [model.id, model.billing?.tokenPrices?.inputPrice]);
    expect(prices).toHaveLength(2);
    expect(prices).toEqual(expect.arrayContaining([["model-a", 999], ["model-b", 100]]));
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
