import type { DatabaseSync } from "./db.js";
import { runImmediateTransaction } from "./db-transaction.js";
import { FeedCardNotFoundError, FeedCardValidationError } from "./feed-store.js";
import {
  focusBoolean, focusEnum, focusEvidence, focusInteger, focusRecord, focusStrings, focusText, focusTimestamp,
  type FocusActor, type FocusEvidence,
} from "./focus-details-store.js";
import { createFocusAttentionStore } from "./focus-attention-store.js";

export interface FocusAuthorityGrant {
  id: string;
  stableKey: string | null;
  title: string;
  taskId: string | null;
  sourceFamily: string;
  producer: string;
  scope: string;
  status: "active" | "revoked";
  validFrom: string;
  validUntil: string;
  allowImmediate: boolean;
  allowQuietHoursOverride: boolean;
  constraints: string[];
  grantedBy: string;
  revokedAt: string | null;
  revokeReason: string | null;
  orphanedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface FocusAuthorityMatch {
  taskId: string | null;
  sourceFamily: string | null;
  producer: string | null;
  authorizationGrantId?: string | null;
  immediate?: boolean;
  quietHoursOverride?: boolean;
}

function assertTask(db: DatabaseSync, taskId: string | null): void {
  if (taskId === null) return;
  const row = db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId);
  if (!row || row.status !== "active") throw new FeedCardValidationError("taskId must name an active task");
}

function hydrateGrant(row: Record<string, unknown>): FocusAuthorityGrant {
  const { constraintsJson, allowImmediate, allowQuietHoursOverride, ...rest } = row;
  return {
    ...rest,
    constraints: focusStrings(JSON.parse(String(constraintsJson)), "stored constraints"),
    allowImmediate: allowImmediate === 1,
    allowQuietHoursOverride: allowQuietHoursOverride === 1,
  } as FocusAuthorityGrant;
}

export function createFocusAuthorityStore(db: DatabaseSync) {
  function get(id: string): FocusAuthorityGrant | undefined {
    const row = db.prepare("SELECT * FROM focus_authority_grants WHERE id = ?").get(id);
    return row ? hydrateGrant(row) : undefined;
  }
  function list(options: { status?: FocusAuthorityGrant["status"]; limit?: number; offset?: number } = {}): FocusAuthorityGrant[] {
    const status = options.status === undefined ? undefined : focusEnum(options.status, "status", ["active", "revoked"]);
    const limit = focusInteger(options.limit ?? 100, "limit", 1, 500);
    const offset = focusInteger(options.offset ?? 0, "offset", 0, 1_000_000);
    return db.prepare(`SELECT * FROM focus_authority_grants ${status ? "WHERE status = ?" : ""}
      ORDER BY updatedAt DESC, id DESC LIMIT ? OFFSET ?`).all(...(status ? [status, limit, offset] : [limit, offset])).map(hydrateGrant);
  }
  function save(value: unknown, actor: FocusActor = "user"): FocusAuthorityGrant {
    const input = focusRecord(value, [
      "id", "key", "title", "taskId", "sourceFamily", "producer", "scope", "status", "validFrom",
      "validUntil", "allowImmediate", "allowQuietHoursOverride", "constraints", "grantedBy", "revokeReason",
    ]);
    if (input.id !== undefined && input.key !== undefined) throw new FeedCardValidationError("Provide id or key, not both");
    return runImmediateTransaction(db, () => {
      const stableKey = input.key === undefined ? null : focusText(input.key, "key")!;
      const keyRow = stableKey ? db.prepare("SELECT id FROM focus_authority_grants WHERE stableKey = ?").get(stableKey) : undefined;
      const id = input.id === undefined ? String(keyRow?.id ?? crypto.randomUUID()) : focusText(input.id, "id")!;
      const existing = get(id);
      if (input.id !== undefined && !existing) throw new FeedCardNotFoundError(`Authority grant ${id} not found`);
      const now = new Date().toISOString();
      const text = (key: "title" | "sourceFamily" | "producer" | "scope" | "grantedBy") =>
        input[key] === undefined && existing ? existing[key] : focusText(input[key], key)!;
      const status = input.status === undefined ? existing?.status ?? "active" : focusEnum(input.status, "status", ["active", "revoked"]);
      const grant: FocusAuthorityGrant = {
        id, stableKey: existing?.stableKey ?? stableKey, title: text("title"),
        taskId: input.taskId === undefined ? existing?.taskId ?? null : focusText(input.taskId, "taskId", true),
        sourceFamily: text("sourceFamily"), producer: text("producer"), scope: text("scope"), status,
        validFrom: input.validFrom === undefined ? existing?.validFrom ?? now : focusTimestamp(input.validFrom, "validFrom")!,
        validUntil: input.validUntil === undefined && existing ? existing.validUntil : focusTimestamp(input.validUntil, "validUntil")!,
        allowImmediate: input.allowImmediate === undefined ? existing?.allowImmediate ?? false : focusBoolean(input.allowImmediate, "allowImmediate"),
        allowQuietHoursOverride: input.allowQuietHoursOverride === undefined ? existing?.allowQuietHoursOverride ?? false : focusBoolean(input.allowQuietHoursOverride, "allowQuietHoursOverride"),
        constraints: input.constraints === undefined ? existing?.constraints ?? [] : focusStrings(input.constraints, "constraints"),
        grantedBy: text("grantedBy"),
        revokedAt: status === "revoked" ? existing?.revokedAt ?? now : null,
        revokeReason: input.revokeReason === undefined ? existing?.revokeReason ?? null : focusText(input.revokeReason, "revokeReason", true),
        orphanedAt: existing?.orphanedAt ?? null, createdAt: existing?.createdAt ?? now, updatedAt: now,
      };
      if (grant.validUntil <= grant.validFrom) throw new FeedCardValidationError("validUntil must be after validFrom");
      if (grant.allowQuietHoursOverride && !grant.allowImmediate) throw new FeedCardValidationError("Quiet-hour override requires allowImmediate");
      if (status === "revoked" && !grant.revokeReason) throw new FeedCardValidationError("revokeReason is required");
      if (status === "active") {
        assertTask(db, grant.taskId);
        if (grant.orphanedAt) throw new FeedCardValidationError("An orphaned grant cannot be reactivated; create a newly scoped grant");
      }
      db.prepare(`INSERT INTO focus_authority_grants (
        id, stableKey, title, taskId, sourceFamily, producer, scope, status, validFrom, validUntil,
        allowImmediate, allowQuietHoursOverride, constraintsJson, grantedBy, revokedAt, revokeReason,
        orphanedAt, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET title=excluded.title, taskId=excluded.taskId, sourceFamily=excluded.sourceFamily,
        producer=excluded.producer, scope=excluded.scope, status=excluded.status, validFrom=excluded.validFrom,
        validUntil=excluded.validUntil, allowImmediate=excluded.allowImmediate,
        allowQuietHoursOverride=excluded.allowQuietHoursOverride, constraintsJson=excluded.constraintsJson,
        grantedBy=excluded.grantedBy, revokedAt=excluded.revokedAt, revokeReason=excluded.revokeReason,
        updatedAt=excluded.updatedAt`).run(
        grant.id, grant.stableKey, grant.title, grant.taskId, grant.sourceFamily, grant.producer, grant.scope,
        grant.status, grant.validFrom, grant.validUntil, grant.allowImmediate ? 1 : 0, grant.allowQuietHoursOverride ? 1 : 0,
        JSON.stringify(grant.constraints), grant.grantedBy, grant.revokedAt, grant.revokeReason, grant.orphanedAt, grant.createdAt, grant.updatedAt,
      );
      createFocusAttentionStore(db).record({ eventType: "authority_changed", actor, details: { grantId: id, status } });
      return grant;
    });
  }
  function resolve(match: FocusAuthorityMatch, now = Date.now()): FocusAuthorityGrant | undefined {
    if (!match.sourceFamily || !match.producer) return undefined;
    const at = new Date(now).toISOString();
    const row = db.prepare(`SELECT * FROM focus_authority_grants
      WHERE status = 'active' AND orphanedAt IS NULL AND validFrom <= ? AND validUntil > ?
        AND sourceFamily = ? AND producer = ? AND taskId IS ?
        AND (? IS NULL OR id = ?)
        AND (? = 0 OR allowImmediate = 1) AND (? = 0 OR allowQuietHoursOverride = 1)
        AND (taskId IS NULL OR EXISTS (SELECT 1 FROM tasks WHERE tasks.id = taskId AND tasks.status = 'active'))
      ORDER BY allowQuietHoursOverride ASC, validUntil ASC, id LIMIT 1`).get(
      at, at, match.sourceFamily, match.producer, match.taskId,
      match.authorizationGrantId ?? null, match.authorizationGrantId ?? null, match.immediate ? 1 : 0, match.quietHoursOverride ? 1 : 0,
    );
    return row ? hydrateGrant(row) : undefined;
  }
  function revoke(id: string, reason: string, actor: FocusActor = "user") {
    return save({ id, status: "revoked", revokeReason: reason }, actor);
  }
  return { get, list, save, resolve, revoke };
}

export type FocusCoverageState = "valid" | "at-risk" | "expired" | "broken" | "unknown";
export interface FocusCoverageAssertion {
  id: string; stableKey: string | null; title: string; taskId: string | null; sourceFamily: string; producer: string;
  scope: string; explicitState: "valid" | "broken" | "unknown"; lastCheckedAt: string | null; validUntil: string | null;
  interventionBy: string | null; expectedIntervalMinutes: number; atRiskMinutes: number; evidence: FocusEvidence[];
  reason: string | null; authorityGrantId: string | null; originalTaskTitle: string | null; orphanedAt: string | null;
  createdAt: string; updatedAt: string;
}
export interface FocusCoverageRead extends FocusCoverageAssertion {
  state: FocusCoverageState;
  observationGap: string | null;
  constrainedAutonomy: string[];
}
export interface FocusCoverageSummary {
  total: number;
  counts: Record<FocusCoverageState, number>;
  observationGaps: Array<{ id: string; title: string; reason: string }>;
  upcomingInterventions: Array<{ id: string; title: string; interventionBy: string }>;
  constrainedAutonomy: Array<{ id: string; constraints: string[] }>;
}

function hydrateCoverage(row: Record<string, unknown>): FocusCoverageAssertion {
  const { evidenceJson, ...rest } = row;
  return { ...rest, evidence: focusEvidence(JSON.parse(String(evidenceJson))) } as FocusCoverageAssertion;
}

export function createFocusCoverageStore(db: DatabaseSync, authority = createFocusAuthorityStore(db)) {
  function get(id: string): FocusCoverageAssertion | undefined {
    const row = db.prepare("SELECT * FROM focus_coverage_assertions WHERE id = ?").get(id);
    return row ? hydrateCoverage(row) : undefined;
  }
  function read(assertion: FocusCoverageAssertion, now = Date.now()): FocusCoverageRead {
    const stale = assertion.lastCheckedAt === null || Date.parse(assertion.lastCheckedAt) + assertion.expectedIntervalMinutes * 60_000 < now;
    const observationGap = assertion.lastCheckedAt === null ? "Never checked" : stale ? "Observation overdue" : null;
    const grant = authority.resolve({
      taskId: assertion.taskId, sourceFamily: assertion.sourceFamily, producer: assertion.producer,
      authorizationGrantId: assertion.authorityGrantId,
    }, now);
    const constrainedAutonomy = grant ? grant.constraints : ["No currently active matching authority grant"];
    let state: FocusCoverageState;
    if (assertion.orphanedAt || assertion.explicitState === "broken") state = "broken";
    else if (assertion.validUntil && Date.parse(assertion.validUntil) <= now) state = "expired";
    else if (assertion.explicitState === "unknown" || !assertion.lastCheckedAt || !assertion.validUntil) state = "unknown";
    else if (stale || Date.parse(assertion.validUntil) <= now + assertion.atRiskMinutes * 60_000
      || (assertion.interventionBy && Date.parse(assertion.interventionBy) <= now + assertion.atRiskMinutes * 60_000)) state = "at-risk";
    else state = "valid";
    return { ...assertion, state, observationGap, constrainedAutonomy };
  }
  function list(options: { limit?: number; offset?: number; now?: number } = {}): FocusCoverageRead[] {
    const limit = focusInteger(options.limit ?? 100, "limit", 1, 500);
    const offset = focusInteger(options.offset ?? 0, "offset", 0, 1_000_000);
    return db.prepare("SELECT * FROM focus_coverage_assertions ORDER BY updatedAt DESC, id DESC LIMIT ? OFFSET ?")
      .all(limit, offset).map((row) => read(hydrateCoverage(row), options.now));
  }
  function all(now = Date.now()): FocusCoverageRead[] {
    return db.prepare("SELECT * FROM focus_coverage_assertions ORDER BY title, id").all().map((row) => read(hydrateCoverage(row), now));
  }
  function summarize(assertions = all()): FocusCoverageSummary {
    const counts: Record<FocusCoverageState, number> = { valid: 0, "at-risk": 0, expired: 0, broken: 0, unknown: 0 };
    for (const assertion of assertions) counts[assertion.state]++;
    return {
      total: assertions.length, counts,
      observationGaps: assertions.flatMap((a) => a.observationGap ? [{ id: a.id, title: a.title, reason: a.observationGap }] : []),
      upcomingInterventions: assertions.flatMap((a) => a.interventionBy ? [{ id: a.id, title: a.title, interventionBy: a.interventionBy }] : [])
        .sort((a, b) => a.interventionBy.localeCompare(b.interventionBy)),
      constrainedAutonomy: assertions.filter((a) => a.constrainedAutonomy.length > 0).map((a) => ({ id: a.id, constraints: a.constrainedAutonomy })),
    };
  }
  function save(value: unknown, actor: FocusActor = "user"): FocusCoverageRead {
    const input = focusRecord(value, [
      "id", "key", "title", "taskId", "sourceFamily", "producer", "scope", "explicitState", "lastCheckedAt",
      "validUntil", "interventionBy", "expectedIntervalMinutes", "atRiskMinutes", "evidence", "reason", "authorityGrantId",
    ]);
    if (input.id !== undefined && input.key !== undefined) throw new FeedCardValidationError("Provide id or key, not both");
    return runImmediateTransaction(db, () => {
      const stableKey = input.key === undefined ? null : focusText(input.key, "key")!;
      const keyRow = stableKey ? db.prepare("SELECT id FROM focus_coverage_assertions WHERE stableKey = ?").get(stableKey) : undefined;
      const id = input.id === undefined ? String(keyRow?.id ?? crypto.randomUUID()) : focusText(input.id, "id")!;
      const existing = get(id);
      if (input.id !== undefined && !existing) throw new FeedCardNotFoundError(`Coverage assertion ${id} not found`);
      const now = new Date().toISOString();
      const text = (key: "title" | "sourceFamily" | "producer" | "scope") =>
        input[key] === undefined && existing ? existing[key] : focusText(input[key], key)!;
      const timestamp = (key: "lastCheckedAt" | "validUntil" | "interventionBy") =>
        input[key] === undefined ? existing?.[key] ?? null : focusTimestamp(input[key], key, true);
      const assertion: FocusCoverageAssertion = {
        id, stableKey: existing?.stableKey ?? stableKey, title: text("title"),
        taskId: input.taskId === undefined ? existing?.taskId ?? null : focusText(input.taskId, "taskId", true),
        sourceFamily: text("sourceFamily"), producer: text("producer"), scope: text("scope"),
        explicitState: input.explicitState === undefined ? existing?.explicitState ?? "unknown" : focusEnum(input.explicitState, "explicitState", ["valid", "broken", "unknown"]),
        lastCheckedAt: timestamp("lastCheckedAt"), validUntil: timestamp("validUntil"), interventionBy: timestamp("interventionBy"),
        expectedIntervalMinutes: input.expectedIntervalMinutes === undefined ? existing?.expectedIntervalMinutes ?? 1440 : focusInteger(input.expectedIntervalMinutes, "expectedIntervalMinutes", 1, 525_600),
        atRiskMinutes: input.atRiskMinutes === undefined ? existing?.atRiskMinutes ?? 60 : focusInteger(input.atRiskMinutes, "atRiskMinutes", 0, 525_600),
        evidence: input.evidence === undefined ? existing?.evidence ?? [] : focusEvidence(input.evidence),
        reason: input.reason === undefined ? existing?.reason ?? null : focusText(input.reason, "reason", true),
        authorityGrantId: input.authorityGrantId === undefined ? existing?.authorityGrantId ?? null : focusText(input.authorityGrantId, "authorityGrantId", true),
        originalTaskTitle: existing?.originalTaskTitle ?? null, orphanedAt: existing?.orphanedAt ?? null,
        createdAt: existing?.createdAt ?? now, updatedAt: now,
      };
      assertTask(db, assertion.taskId);
      if (assertion.lastCheckedAt && assertion.lastCheckedAt > now) throw new FeedCardValidationError("lastCheckedAt cannot be in the future");
      if (assertion.lastCheckedAt && assertion.validUntil && assertion.validUntil <= assertion.lastCheckedAt) throw new FeedCardValidationError("validUntil must be after lastCheckedAt");
      if (assertion.explicitState === "valid" && (!assertion.lastCheckedAt || !assertion.validUntil || !assertion.evidence.length)) {
        throw new FeedCardValidationError("Valid coverage requires lastCheckedAt, validUntil and evidence");
      }
      if (assertion.authorityGrantId && !authority.get(assertion.authorityGrantId)) throw new FeedCardValidationError("authorityGrantId not found");
      const { evidence, ...scalar } = assertion;
      const row = { ...scalar, evidenceJson: JSON.stringify(evidence) };
      const keys = Object.keys(row);
      db.prepare(`INSERT INTO focus_coverage_assertions (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})
        ON CONFLICT(id) DO UPDATE SET ${keys.filter((key) => key !== "id").map((key) => `${key}=excluded.${key}`).join(",")}`).run(...Object.values(row));
      createFocusAttentionStore(db).record({ eventType: "coverage_changed", actor, details: { assertionId: id } });
      return read(assertion);
    });
  }
  function remove(id: string): boolean {
    return runImmediateTransaction(db, () => {
      const result = db.prepare("DELETE FROM focus_coverage_assertions WHERE id = ?").run(id);
      if (!result.changes) throw new FeedCardNotFoundError(`Coverage assertion ${id} not found`);
      createFocusAttentionStore(db).record({ eventType: "coverage_changed", reason: "deleted", details: { assertionId: id } });
      return true;
    });
  }
  return { get, read, list, all, summarize, save, remove };
}

export type FocusAuthorityStore = ReturnType<typeof createFocusAuthorityStore>;
export type FocusCoverageStore = ReturnType<typeof createFocusCoverageStore>;
