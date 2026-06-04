// Copilot model price cache — persists last-known-good SDK token prices so that
// retired/historical model IDs in old session logs stay priced and transient
// listModels() outages do not zero out usage cost estimates. All prices originate
// from the Copilot SDK; nothing here is hand-maintained.

import {
  isCopilotModelPriceable,
  type CopilotModelMetadataForPricing,
} from "../shared/copilot-pricing.js";
import type { DatabaseSync } from "./db.js";

export interface CopilotModelPriceStore {
  upsertModelPrices(models: readonly CopilotModelMetadataForPricing[]): void;
  listModelPrices(): CopilotModelMetadataForPricing[];
}

interface CopilotModelPriceRow {
  id: string;
  name: string | null;
  metadataJson: string;
}

export function createCopilotModelPriceStore(db: DatabaseSync): CopilotModelPriceStore {
  const upsert = db.prepare(`
    INSERT INTO copilot_model_prices (id, name, metadataJson, updatedAt)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      metadataJson = excluded.metadataJson,
      updatedAt = excluded.updatedAt
  `);
  const selectAll = db.prepare("SELECT id, name, metadataJson FROM copilot_model_prices");

  function upsertModelPrices(models: readonly CopilotModelMetadataForPricing[]): void {
    const priceable = models.filter(isCopilotModelPriceable);
    if (priceable.length === 0) return;

    const now = new Date().toISOString();
    db.exec("BEGIN");
    try {
      for (const model of priceable) {
        upsert.run(
          model.id,
          typeof model.name === "string" ? model.name : null,
          JSON.stringify(model),
          now,
        );
      }
      db.exec("COMMIT");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // The transaction may not be active (e.g. BEGIN itself failed); ignore.
      }
      throw err;
    }
  }

  function listModelPrices(): CopilotModelMetadataForPricing[] {
    const rows = selectAll.all() as unknown as CopilotModelPriceRow[];
    const models: CopilotModelMetadataForPricing[] = [];
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.metadataJson) as unknown;
        if (parsed && typeof parsed === "object" && typeof (parsed as { id?: unknown }).id === "string") {
          models.push(parsed as CopilotModelMetadataForPricing);
        }
      } catch (err) {
        console.warn(`[copilot-model-price-store] Skipping corrupted price row "${row.id}".`, err);
      }
    }
    return models;
  }

  return { upsertModelPrices, listModelPrices };
}

export type CreateCopilotModelPriceStore = typeof createCopilotModelPriceStore;
