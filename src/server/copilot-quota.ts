// Quota: merges getQuota (rounded used, bad resetDate) with getCurrentAuth (exact counts, reset).
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
  /** Forgets the cached reading; a read in flight neither answers later reads nor caches. */
  invalidate?(): void;
}

export interface CreateCopilotQuotaReaderOptions {
  getQuota: () => Promise<unknown>;
  /** Optional: supplies the exact remaining balance and the real reset date. */
  getAuth?: () => Promise<unknown>;
  /** Live Copilot user response; without it a refresh repeats the backend's startup numbers. */
  getLiveUser?: () => Promise<unknown>;
  /** Told about each new live-fetch failure; a repeat of the last one is not reported again. */
  onLiveUserError?: (message: string) => void;
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
  onLiveUserError = (message) => console.warn(`[quota] Live Copilot quota fetch failed; showing the backend's startup copy: ${message}`),
  now = Date.now,
  cacheTtlMs = DEFAULT_QUOTA_CACHE_TTL_MS,
}: CreateCopilotQuotaReaderOptions): CopilotQuotaReader {
  let cached: { status: CopilotQuotaStatus; fetchedAtMs: number } | null = null;
  let inflight: Promise<CopilotQuotaStatus> | null = null;
  let lastLiveUserError: string | null = null;
  let generation = 0;

  // A failed live fetch silently falls back to numbers that never change, so say so once.
  async function fetchLiveUser(fetchUser: () => Promise<unknown>): Promise<unknown> {
    try {
      const user = await fetchUser();
      lastLiveUserError = null;
      return user;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== lastLiveUserError) {
        lastLiveUserError = message;
        onLiveUserError(message);
      }
      return undefined;
    }
  }

  async function fetchStatus(): Promise<CopilotQuotaStatus> {
    const startedGeneration = generation;
    const fetchedAtMs = now();
    const fetchedAt = new Date(fetchedAtMs).toISOString();
    let status: CopilotQuotaStatus;
    try {
      // The auth and live-user calls only enrich the counter, so they must never fail the read.
      const [quota, auth, liveUser] = await Promise.all([
        getQuota(),
        getAuth ? getAuth().catch(() => undefined) : Promise.resolve(undefined),
        getLiveUser ? fetchLiveUser(getLiveUser) : Promise.resolve(undefined),
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
    if (startedGeneration === generation) cached = { status, fetchedAtMs };
    return status;
  }

  return {
    async read(options) {
      const ttl = Math.max(0, cacheTtlMs);
      if (!options?.refresh && cached && now() - cached.fetchedAtMs < ttl) {
        return cached.status;
      }
      if (inflight) return inflight;
      const read = fetchStatus().finally(() => {
        if (inflight === read) inflight = null;
      });
      inflight = read;
      return read;
    },
    invalidate() {
      generation += 1;
      cached = null;
      inflight = null;
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

  // The raw user response wins: it may be fresh, while the typed snapshot is from startup.
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

/** The snapshot's resetDate repeats its timestamp ("resets today"), so trust only a future one. */
function futureResetDate(value: unknown, fetchedAt: string): string | null {
  const candidate = readNonEmptyString(value);
  if (!candidate) return null;
  const candidateMs = Date.parse(candidate);
  const fetchedAtMs = Date.parse(fetchedAt);
  if (!Number.isFinite(candidateMs) || !Number.isFinite(fetchedAtMs)) return null;
  return candidateMs > fetchedAtMs ? candidate : null;
}

/** Prefers a bucket with real numbers; on seat accounts chat and completions are zeroed noise. */
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
