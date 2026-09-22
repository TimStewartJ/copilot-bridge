import type { DatabaseSync } from "node:sqlite";

/** Only for a freshly copied preview database, inside the required seed transaction. Never a boot hook. */
export function isolateStagingRuntimeState(db: DatabaseSync): Record<string, number> {
  if (!db.isTransaction) throw new Error("Staging runtime isolation requires the seed transaction");
  const hasTable = (name: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  const now = new Date().toISOString();
  const reason = "Isolated staging copy: production automatic work is not resumed.";
  const changed: Record<string, number> = {};
  changed.schedules = Number(db.prepare("UPDATE schedules SET enabled=0 WHERE enabled<>0").run().changes);
  if (hasTable("push_subscriptions")) changed.pushSubscriptions = Number(db.prepare("DELETE FROM push_subscriptions").run().changes);
  for (const table of ["deferred_prompts", "defer_loops"]) {
    if (!hasTable(table)) continue;
    const pending = table === "defer_loops" ? "active" : "pending";
    changed[table] = Number(db.prepare(`UPDATE ${table} SET status='cancelled',claimToken=NULL,leaseExpiresAt=NULL,lastError=?,updatedAt=?
      WHERE status IN (?,'running')`).run(reason, now, pending).changes);
  }
  if (hasTable("interrupted_run_markers")) changed.interruptedRuns = Number(db.prepare("DELETE FROM interrupted_run_markers").run().changes);
  if (hasTable("voice_jobs")) changed.voiceJobs = Number(db.prepare(`UPDATE voice_jobs SET status='error',error=?,updatedAt=?
    WHERE status IN ('accepted','transcribing','sending')`).run(reason, now).changes);
  return changed;
}
