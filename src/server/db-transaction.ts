/** Transaction helpers: multi-statement writes are atomic, and nesting is handled explicitly. */

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

/** No nesting: callers emit events after commit, which an outer rollback would make false. */
export function runTransaction<T>(db: DatabaseSync, operation: () => T): T {
  if (db.isTransaction) throw new NestedTransactionError("runTransaction");
  db.exec("BEGIN");
  return commitOrRollback(db, operation);
}

/** Check-then-write; no nesting, as joining a deferred outer transaction loses the write lock. */
export function runImmediateTransaction<T>(db: DatabaseSync, operation: () => T): T {
  if (db.isTransaction) throw new NestedTransactionError("runImmediateTransaction");
  db.exec("BEGIN IMMEDIATE");
  return commitOrRollback(db, operation);
}

/** Joins an open transaction: only for ops with no post-commit side effects; outer owns commit. */
export function runInOwnOrOuterTransaction<T>(db: DatabaseSync, operation: () => T): T {
  if (db.isTransaction) return operation();
  db.exec("BEGIN");
  return commitOrRollback(db, operation);
}
