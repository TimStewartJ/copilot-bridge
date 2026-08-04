/**
 * Shared SQLite transaction helpers.
 *
 * Multi-statement store writes (reorder loops, bump-then-insert pairs,
 * delete-then-recompact sequences) must be all-or-nothing: a failure partway
 * through otherwise leaves rows in a state no code path can produce, such as an
 * order column inflated by a create whose INSERT never landed.
 *
 * SQLite has no nested transactions, so these helpers are explicit about what
 * happens when one is already open rather than letting a raw `BEGIN` fail with
 * an opaque driver error.
 */

import type { DatabaseSync } from "./db.js";

export class NestedTransactionError extends Error {
  constructor(operation: string) {
    super(
      `${operation} cannot run inside an open transaction: SQLite has no nested transactions, `
      + "and the caller would observe post-commit side effects before the outer transaction commits",
    );
    this.name = "NestedTransactionError";
  }
}

function commitOrRollback<T>(db: DatabaseSync, operation: () => T): T {
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original error.
    }
    throw error;
  }
}

/**
 * Run `operation` in a deferred transaction.
 *
 * Rejects nesting: callers of these store methods perform post-commit side
 * effects (change events, SSE fan-out), which would announce data that an outer
 * transaction could still roll back.
 */
export function runTransaction<T>(db: DatabaseSync, operation: () => T): T {
  if (db.isTransaction) throw new NestedTransactionError("runTransaction");
  db.exec("BEGIN");
  return commitOrRollback(db, operation);
}

/**
 * Run `operation` in an immediate transaction, taking the write lock up front.
 *
 * Used by check-then-write arbitration (exclusive enqueue, job claiming) where a
 * concurrent writer between the read and the write would corrupt the decision.
 * Nesting is rejected because joining a deferred outer transaction would
 * silently drop exactly that guarantee.
 */
export function runImmediateTransaction<T>(db: DatabaseSync, operation: () => T): T {
  if (db.isTransaction) throw new NestedTransactionError("runImmediateTransaction");
  db.exec("BEGIN IMMEDIATE");
  return commitOrRollback(db, operation);
}

/**
 * Run `operation` atomically, joining an already-open transaction instead of
 * failing.
 *
 * Only for operations that are deliberately composed inside a larger
 * transaction (batch backfills) and that perform no post-commit side effects of
 * their own. When joining, the outer owner is responsible for commit/rollback;
 * a throw here propagates and rolls the outer transaction back.
 */
export function runInOwnOrOuterTransaction<T>(db: DatabaseSync, operation: () => T): T {
  if (db.isTransaction) return operation();
  db.exec("BEGIN");
  return commitOrRollback(db, operation);
}
