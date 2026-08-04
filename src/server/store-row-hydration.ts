/**
 * Per-row hydration guards for SQLite-backed stores.
 *
 * Stores hydrate rows by parsing JSON columns and asserting their shape. Doing
 * that in a bare `rows.map(hydrate)` means one malformed or newly-invalid row
 * throws for the *entire* read, which bricks every caller of the list — including
 * the settings UI the user would need to delete the offending row. It is also a
 * forward-compatibility trap: tightening a validator turns previously-valid
 * persisted rows into a boot-time failure.
 *
 * These helpers keep the read alive by skipping the bad row and logging it once.
 */

export interface RowHydrationContext<Row> {
  /** Store/table name used in the warning, e.g. "mcp_servers". */
  readonly store: string;
  /** Stable identity for the bad row so the operator can find and fix it. */
  readonly describeRow: (row: Row) => string;
}

function warnSkippedRow<Row>(context: RowHydrationContext<Row>, row: Row, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  let identity: string;
  try {
    identity = context.describeRow(row);
  } catch {
    identity = "<unknown row>";
  }
  console.warn(`[${context.store}] Skipping unreadable row ${identity}: ${reason}`);
}

/** Hydrate one row, returning undefined (and warning) when it cannot be read. */
export function hydrateRowSafely<Row, T>(
  row: Row,
  hydrate: (row: Row) => T,
  context: RowHydrationContext<Row>,
): T | undefined {
  try {
    return hydrate(row);
  } catch (error) {
    warnSkippedRow(context, row, error);
    return undefined;
  }
}

/** Hydrate rows, dropping (and warning about) any row that cannot be read. */
export function hydrateRowsSafely<Row, T>(
  rows: readonly Row[],
  hydrate: (row: Row) => T,
  context: RowHydrationContext<Row>,
): T[] {
  const hydrated: T[] = [];
  for (const row of rows) {
    const value = hydrateRowSafely(row, hydrate, context);
    if (value !== undefined) hydrated.push(value);
  }
  return hydrated;
}
