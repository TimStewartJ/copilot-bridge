/**
 * Live account quota counter, read through the agent backend's account RPCs.
 *
 * Two calls are merged because neither is complete on its own:
 *  - `account.getQuota` returns the typed per-bucket snapshots (entitlement,
 *    used, percentage, overage), but `usedRequests` is rounded to two
 *    significant figures and its `resetDate` currently repeats the snapshot
 *    timestamp rather than the quota reset date.
 *  - `account.getCurrentAuth` carries the raw Copilot user response, which has
 *    the exact `quota_remaining` and the real `quota_reset_date`.
 *
 * Both are the backend's copy from when it started, so the reader can also take
 * a freshly fetched Copilot user response (`getLiveUser`) that replaces it.
 *
 * The typed shapes are marked @experimental in the SDK, so everything is parsed
 * defensively and a bad payload degrades to "unavailable" instead of throwing.
 * Note the bucket named `premium_interactions` is billed in AI credits, not
 * premium requests, whenever `tokenBasedBilling` is set.
 */
import { isRecord } from "../shared/is-record.js";

export type CopilotQuotaUnit = "ai_credits" | "premium_requests";

export interface CopilotQuotaSnapshot {
  bucket: string;
  unit: CopilotQuotaUnit;
  tokenBasedBilling: boolean;
  isUnlimitedEntitlement: boolean;
  entitlement: number | null;
  used: number | null;
  usedIsPrecise: boolean;
  remaining: number | null;
  remainingPercentage: number | null;
  overage: number | null;
  overagePermitted: boolean | null;
  resetAt: string | null;
}

export interface CopilotQuotaIdentity {
  login: string | null;
  plan: string | null;
  sku: string | null;
  organizations: string[];
}

export interface CopilotQuotaStatus {
  available: boolean;
  fetchedAt: string;
  identity: CopilotQuotaIdentity | null;
  primary: CopilotQuotaSnapshot | null;
  snapshots: CopilotQuotaSnapshot[];
  error: string | null;
}

export interface CopilotQuotaReader {
  read(options?: { refresh?: boolean }): Promise<CopilotQuotaStatus>;
}

export interface CreateCopilotQuotaReaderOptions {
  getQuota: () => Promise<unknown>;
  /** Optional: supplies the exact remaining balance and the real reset date. */
  getAuth?: () => Promise<unknown>;
  /**
   * Optional: the raw Copilot user response fetched from GitHub now. The
   * backend's `getAuth`/`getQuota` copies are only fetched when it starts, so
   * without this a refresh keeps returning the same numbers.
   */
  getLiveUser?: () => Promise<unknown>;
  now?: () => number;
  cacheTtlMs?: number;
}

/** Bucket carrying real numbers on token-billed accounts. */
export const PRIMARY_QUOTA_BUCKET = "premium_interactions";

const DEFAULT_QUOTA_CACHE_TTL_MS = 30_000;
const QUOTA_UNAVAILABLE_MESSAGE = "Live quota is unavailable from the Copilot backend.";

export function createCopilotQuotaReader({
  getQuota,
  getAuth,
  getLiveUser,
  now = Date.now,
  cacheTtlMs = DEFAULT_QUOTA_CACHE_TTL_MS,
}: CreateCopilotQuotaReaderOptions): CopilotQuotaReader {
  let cached: { status: CopilotQuotaStatus; fetchedAtMs: number } | null = null;
  let inflight: Promise<CopilotQuotaStatus> | null = null;

  async function fetchStatus(): Promise<CopilotQuotaStatus> {
    const fetchedAtMs = now();
    const fetchedAt = new Date(fetchedAtMs).toISOString();
    let status: CopilotQuotaStatus;
    try {
      // The auth and live-user calls only enrich the counter, so they must never fail the read.
      const [quota, auth, liveUser] = await Promise.all([
        getQuota(),
        getAuth ? getAuth().catch(() => undefined) : Promise.resolve(undefined),
        getLiveUser ? Promise.resolve().then(getLiveUser).catch(() => undefined) : Promise.resolve(undefined),
      ]);
      status = buildCopilotQuotaStatus(quota, withLiveUser(auth, liveUser), fetchedAt);
    } catch (error) {
      status = {
        available: false,
        fetchedAt,
        identity: null,
        primary: null,
        snapshots: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
    cached = { status, fetchedAtMs };
    return status;
  }

  return {
    async read(options) {
      const ttl = Math.max(0, cacheTtlMs);
      if (!options?.refresh && cached && now() - cached.fetchedAtMs < ttl) {
        return cached.status;
      }
      if (inflight) return inflight;
      inflight = fetchStatus().finally(() => {
        inflight = null;
      });
      return inflight;
    },
  };
}

export function buildCopilotQuotaStatus(
  quotaResult: unknown,
  authResult: unknown,
  fetchedAt: string,
): CopilotQuotaStatus {
  const copilotUser = asRecord(asRecord(asRecord(authResult)?.authInfo)?.copilotUser);
  const identity = parseIdentity(asRecord(authResult), copilotUser);
  const rawSnapshots = asRecord(copilotUser?.quota_snapshots) ?? {};
  const resetAt = readNonEmptyString(copilotUser?.quota_reset_date_utc)
    ?? readNonEmptyString(copilotUser?.quota_reset_date);

  const snapshotsRecord = asRecord(asRecord(quotaResult)?.quotaSnapshots);
  if (!snapshotsRecord) {
    return {
      available: false,
      fetchedAt,
      identity,
      primary: null,
      snapshots: [],
      error: QUOTA_UNAVAILABLE_MESSAGE,
    };
  }

  const snapshots: CopilotQuotaSnapshot[] = [];
  for (const [bucket, raw] of Object.entries(snapshotsRecord)) {
    const snapshot = parseCopilotQuotaSnapshot(bucket, raw, {
      rawUserSnapshot: asRecord(rawSnapshots[bucket]),
      resetAt,
      fetchedAt,
    });
    if (snapshot) snapshots.push(snapshot);
  }

  return {
    available: snapshots.length > 0,
    fetchedAt,
    identity,
    primary: pickPrimarySnapshot(snapshots),
    snapshots,
    error: snapshots.length > 0 ? null : QUOTA_UNAVAILABLE_MESSAGE,
  };
}

/** Swaps the backend's startup copy of the Copilot user for a freshly fetched one. */
function withLiveUser(auth: unknown, liveUser: unknown): unknown {
  if (!isRecord(liveUser) || !isRecord(liveUser.quota_snapshots)) return auth;
  const authRecord = asRecord(auth) ?? {};
  const authInfo = asRecord(authRecord.authInfo) ?? {};
  return { ...authRecord, authInfo: { ...authInfo, copilotUser: liveUser } };
}

function parseIdentity(
  authRecord: Record<string, unknown> | null,
  copilotUser: Record<string, unknown> | null,
): CopilotQuotaIdentity | null {
  const authInfo = asRecord(authRecord?.authInfo);
  const login = readNonEmptyString(authInfo?.login) ?? readNonEmptyString(copilotUser?.login);
  const plan = readNonEmptyString(copilotUser?.copilot_plan);
  const sku = readNonEmptyString(copilotUser?.access_type_sku);
  const organizationList = copilotUser?.organization_login_list;
  const organizations = Array.isArray(organizationList)
    ? organizationList.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()))
    : [];
  if (!login && !plan && !sku && organizations.length === 0) return null;
  return { login, plan, sku, organizations };
}

function parseCopilotQuotaSnapshot(
  bucket: string,
  value: unknown,
  context: {
    rawUserSnapshot: Record<string, unknown> | null;
    resetAt: string | null;
    fetchedAt: string;
  },
): CopilotQuotaSnapshot | null {
  const record = asRecord(value);
  if (!record) return null;
  const rawUser = context.rawUserSnapshot;

  // The raw user response wins: it may be freshly fetched, while the typed
  // snapshot is always the backend's copy from startup.
  const tokenBasedBilling = readBoolean(rawUser?.token_based_billing)
    ?? readBoolean(record.tokenBasedBilling)
    ?? false;
  const isUnlimitedEntitlement = readBoolean(rawUser?.unlimited)
    ?? readBoolean(record.isUnlimitedEntitlement)
    ?? false;
  const rawEntitlement = readFiniteNumber(rawUser?.entitlement)
    ?? readFiniteNumber(record.entitlementRequests);
  const entitlement = rawEntitlement !== null && rawEntitlement < 0 ? null : rawEntitlement;
  const remaining = readFiniteNumber(rawUser?.quota_remaining)
    ?? readFiniteNumber(rawUser?.remaining)
    ?? readFiniteNumber(record.quota_remaining);
  const roundedUsed = readFiniteNumber(record.usedRequests) ?? readFiniteNumber(record.used);
  const preciseUsed = entitlement !== null && remaining !== null
    ? roundQuotaAmount(entitlement - remaining)
    : null;

  return {
    bucket,
    unit: tokenBasedBilling ? "ai_credits" : "premium_requests",
    tokenBasedBilling,
    isUnlimitedEntitlement,
    entitlement,
    used: preciseUsed ?? roundedUsed,
    usedIsPrecise: preciseUsed !== null,
    remaining,
    remainingPercentage: readFiniteNumber(rawUser?.percent_remaining)
      ?? readFiniteNumber(record.remainingPercentage),
    overage: readFiniteNumber(rawUser?.overage_count) ?? readFiniteNumber(record.overage),
    overagePermitted: readBoolean(rawUser?.overage_permitted)
      ?? readBoolean(record.overageAllowedWithExhaustedQuota)
      ?? null,
    resetAt: context.resetAt ?? futureResetDate(record.resetDate, context.fetchedAt),
  };
}

/**
 * `resetDate` on the typed snapshot currently repeats the snapshot timestamp,
 * which would render as "resets today". Only trust it when it is actually in
 * the future.
 */
function futureResetDate(value: unknown, fetchedAt: string): string | null {
  const candidate = readNonEmptyString(value);
  if (!candidate) return null;
  const candidateMs = Date.parse(candidate);
  const fetchedAtMs = Date.parse(fetchedAt);
  if (!Number.isFinite(candidateMs) || !Number.isFinite(fetchedAtMs)) return null;
  return candidateMs > fetchedAtMs ? candidate : null;
}

/**
 * Prefer the bucket that carries real numbers. On seat-quota accounts `chat`
 * and `completions` are unlimited with zeroed counters, so they are noise.
 */
function pickPrimarySnapshot(snapshots: readonly CopilotQuotaSnapshot[]): CopilotQuotaSnapshot | null {
  if (snapshots.length === 0) return null;
  const named = snapshots.find((snapshot) => snapshot.bucket === PRIMARY_QUOTA_BUCKET);
  if (named && hasMeasuredUsage(named)) return named;
  const measured = snapshots.filter(hasMeasuredUsage);
  if (measured.length > 0) {
    return measured.reduce((best, candidate) => (
      (candidate.used ?? 0) > (best.used ?? 0) ? candidate : best
    ));
  }
  return named ?? snapshots[0];
}

function hasMeasuredUsage(snapshot: CopilotQuotaSnapshot): boolean {
  if (snapshot.isUnlimitedEntitlement && (snapshot.used ?? 0) === 0) return false;
  return (snapshot.used ?? 0) > 0 || (snapshot.entitlement ?? 0) > 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Subtracting large float quotas leaves binary dust, e.g. 79393.90000000037. */
function roundQuotaAmount(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
