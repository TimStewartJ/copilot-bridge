import { describe, expect, it, vi } from "vitest";
import { buildCopilotQuotaStatus, createCopilotQuotaReader } from "../copilot-quota.js";

const FETCHED_AT = "2026-08-04T23:16:53.006Z";

// Shapes copied from a live `account.getQuota` / `account.getCurrentAuth` pair.
function premiumSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    isUnlimitedEntitlement: false,
    entitlementRequests: 10_000_000,
    usedRequests: 80_000,
    usageAllowedWithExhaustedQuota: true,
    overage: 0,
    overageAllowedWithExhaustedQuota: true,
    remainingPercentage: 99.2,
    // The SDK currently reports the snapshot timestamp here, not a reset date.
    resetDate: "2026-08-04T16:16:52.847-07:00",
    hasQuota: true,
    tokenBasedBilling: true,
    ...overrides,
  };
}

function quotaResult(overrides: Record<string, unknown> = {}) {
  return {
    quotaSnapshots: {
      chat: { isUnlimitedEntitlement: true, entitlementRequests: 0, usedRequests: 0, remainingPercentage: 100 },
      completions: { isUnlimitedEntitlement: true, entitlementRequests: 0, usedRequests: 0, remainingPercentage: 100 },
      premium_interactions: premiumSnapshot(overrides),
    },
  };
}

function authResult(overrides: Record<string, unknown> = {}) {
  return {
    authInfo: {
      type: "user",
      login: "timstewart_microsoft",
      copilotUser: {
        copilot_plan: "enterprise",
        access_type_sku: "copilot_enterprise_seat_quota",
        organization_login_list: ["ms-copilot"],
        quota_reset_date: "2026-09-01",
        quota_reset_date_utc: "2026-09-01T00:00:00.000Z",
        quota_snapshots: {
          premium_interactions: {
            entitlement: 10_000_000,
            quota_remaining: 9_920_606.1,
            remaining: 9_920_606,
            percent_remaining: 99.2,
            overage_permitted: true,
            token_based_billing: true,
            unlimited: false,
          },
        },
        ...overrides,
      },
    },
  };
}

describe("buildCopilotQuotaStatus", () => {
  it("merges the auth passthrough to expose the exact used balance and real reset date", () => {
    const status = buildCopilotQuotaStatus(quotaResult(), authResult(), FETCHED_AT);

    expect(status.available).toBe(true);
    expect(status.primary).toEqual({
      bucket: "premium_interactions",
      unit: "ai_credits",
      tokenBasedBilling: true,
      isUnlimitedEntitlement: false,
      entitlement: 10_000_000,
      used: 79_393.9,
      usedIsPrecise: true,
      remaining: 9_920_606.1,
      remainingPercentage: 99.2,
      overage: 0,
      overagePermitted: true,
      resetAt: "2026-09-01T00:00:00.000Z",
    });
    expect(status.identity).toEqual({
      login: "timstewart_microsoft",
      plan: "enterprise",
      sku: "copilot_enterprise_seat_quota",
      organizations: ["ms-copilot"],
    });
  });

  it("falls back to the rounded counter and drops the stale reset date without auth data", () => {
    const status = buildCopilotQuotaStatus(quotaResult(), undefined, FETCHED_AT);

    expect(status.primary?.used).toBe(80_000);
    expect(status.primary?.usedIsPrecise).toBe(false);
    expect(status.primary?.remaining).toBeNull();
    // resetDate repeats the snapshot timestamp, so it must not render as a reset.
    expect(status.primary?.resetAt).toBeNull();
    expect(status.identity).toBeNull();
  });

  it("keeps a genuinely future reset date from the typed snapshot", () => {
    const status = buildCopilotQuotaStatus(
      quotaResult({ resetDate: "2026-09-01T00:00:00.000Z" }),
      undefined,
      FETCHED_AT,
    );

    expect(status.primary?.resetAt).toBe("2026-09-01T00:00:00.000Z");
  });

  it("reads snake_case fields when the backend merges them into the snapshot", () => {
    const status = buildCopilotQuotaStatus(
      { quotaSnapshots: { premium_interactions: premiumSnapshot({ quota_remaining: 9_925_809.6 }) } },
      undefined,
      FETCHED_AT,
    );

    expect(status.primary?.used).toBe(74_190.4);
    expect(status.primary?.usedIsPrecise).toBe(true);
  });

  it("labels premium requests when the account is not token billed", () => {
    const status = buildCopilotQuotaStatus(
      {
        quotaSnapshots: {
          premium_interactions: premiumSnapshot({
            tokenBasedBilling: false,
            entitlementRequests: 300,
            quota_remaining: 120,
          }),
        },
      },
      undefined,
      FETCHED_AT,
    );

    expect(status.primary?.unit).toBe("premium_requests");
    expect(status.primary?.used).toBe(180);
  });

  it("skips unlimited zeroed buckets when picking the primary snapshot", () => {
    const status = buildCopilotQuotaStatus(quotaResult(), authResult(), FETCHED_AT);

    expect(status.snapshots).toHaveLength(3);
    expect(status.primary?.bucket).toBe("premium_interactions");
  });

  it("reports unavailable for payloads without quota snapshots", () => {
    const status = buildCopilotQuotaStatus({ unexpected: true }, undefined, FETCHED_AT);

    expect(status.available).toBe(false);
    expect(status.primary).toBeNull();
    expect(status.error).toBeTruthy();
  });

  it("tolerates unlimited entitlements reported as -1", () => {
    const status = buildCopilotQuotaStatus(
      {
        quotaSnapshots: {
          premium_interactions: {
            isUnlimitedEntitlement: true,
            entitlementRequests: -1,
            usedRequests: 12,
            remainingPercentage: 100,
          },
        },
      },
      undefined,
      FETCHED_AT,
    );

    expect(status.primary?.entitlement).toBeNull();
    expect(status.primary?.used).toBe(12);
    expect(status.primary?.usedIsPrecise).toBe(false);
  });
});

describe("createCopilotQuotaReader", () => {
  it("caches within the TTL, refreshes on demand, and expires", async () => {
    let currentTime = 1_000;
    const getQuota = vi.fn(async () => quotaResult());
    const getAuth = vi.fn(async () => authResult());
    const reader = createCopilotQuotaReader({
      getQuota,
      getAuth,
      now: () => currentTime,
      cacheTtlMs: 60_000,
    });

    await reader.read();
    await reader.read();
    expect(getQuota).toHaveBeenCalledTimes(1);
    expect(getAuth).toHaveBeenCalledTimes(1);

    await reader.read({ refresh: true });
    expect(getQuota).toHaveBeenCalledTimes(2);

    currentTime += 60_001;
    await reader.read();
    expect(getQuota).toHaveBeenCalledTimes(3);
  });

  it("still returns the counter when only the auth enrichment fails", async () => {
    const reader = createCopilotQuotaReader({
      getQuota: async () => quotaResult(),
      getAuth: async () => {
        throw new Error("auth lookup unsupported");
      },
    });

    const status = await reader.read();

    expect(status.available).toBe(true);
    expect(status.primary?.used).toBe(80_000);
    expect(status.primary?.usedIsPrecise).toBe(false);
    expect(status.error).toBeNull();
  });

  it("returns an unavailable status instead of throwing when the quota RPC fails", async () => {
    const reader = createCopilotQuotaReader({
      getQuota: async () => {
        throw new Error("Account quota lookup is not available in this Copilot SDK build");
      },
    });

    const status = await reader.read();

    expect(status.available).toBe(false);
    expect(status.error).toBe("Account quota lookup is not available in this Copilot SDK build");
    expect(status.snapshots).toEqual([]);
  });

  it("collapses concurrent reads into a single backend call", async () => {
    let resolveQuota: (value: unknown) => void = () => {};
    const getQuota = vi.fn(() => new Promise((resolve) => {
      resolveQuota = resolve;
    }));
    const reader = createCopilotQuotaReader({ getQuota });

    const first = reader.read();
    const second = reader.read();
    resolveQuota(quotaResult());

    const [firstStatus, secondStatus] = await Promise.all([first, second]);
    expect(getQuota).toHaveBeenCalledTimes(1);
    expect(firstStatus).toBe(secondStatus);
  });
});
