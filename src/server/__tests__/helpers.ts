// Shared test helpers — SQLite in-memory database setup

import { openMemoryDatabase } from "../db.js";
import type { DatabaseSync } from "../db.js";
import { createGlobalBus } from "../global-bus.js";

/**
 * Create an in-memory SQLite database with schema initialized.
 * Returns the database instance. No cleanup needed — GC handles it.
 */
export function setupTestDb(): DatabaseSync {
  return openMemoryDatabase();
}

/** Create a test global bus (no-op emitter) */
export function createTestBus() {
  return createGlobalBus();
}
