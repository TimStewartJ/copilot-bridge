import { createElement, type ComponentType } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CopilotQuotaStatus } from "../api";
import {
  createReactDomHarness,
  findAllByTag,
  getReactProps,
  type ReactDomHarness,
} from "../test-react-harness";
import CopilotQuotaMenu, { CopilotQuotaCard } from "./CopilotQuotaMenu";

/** The details dialog links to Settings, so the menu renders inside a router. */
function routed<P extends object>(component: ComponentType<P>, props?: P) {
  return createElement(MemoryRouter, null, createElement(component as ComponentType<object>, props ?? {}));
}

const useCopilotQuotaQueryMock = vi.hoisted(() => vi.fn());

vi.mock("../hooks/queries/useCopilotQuota", () => ({
  useCopilotQuotaQuery: useCopilotQuotaQueryMock,
}));

const NOW = "2026-09-01T12:00:00.000Z";

function createQuotaStatus(overrides: Partial<CopilotQuotaStatus> = {}): CopilotQuotaStatus {
  const primary = overrides.primary ?? {
    bucket: "premium_interactions",
    unit: "ai_credits" as const,
    tokenBasedBilling: true,
    isUnlimitedEntitlement: false,
    entitlement: 10_000_000,
    used: 79_393.9,
    usedIsPrecise: true,
    remaining: 9_920_606.1,
    remainingPercentage: 99.2,
    overage: 0,
    overagePermitted: true,
    resetAt: "2026-10-01T00:00:00.000Z",
  };
  return {
    available: true,
    fetchedAt: NOW,
    identity: {
      login: "timstewart_microsoft",
      plan: "enterprise",
      sku: "copilot_enterprise_seat_quota",
      organizations: ["ms-copilot"],
    },
    primary,
    snapshots: primary ? [primary] : [],
    error: null,
    ...overrides,
  };
}

function findButtonByLabel(root: any, label: string): any {
  const button = findAllByTag(root, "BUTTON").find(
    (candidate) => getReactProps(candidate)?.["aria-label"] === label,
  );
  if (!button) throw new Error(`Button not found: ${label}`);
  return button;
}

function paceFill(root: any, kind: "month" | "usage" | "month-marker"): any {
  return findAllByTag(root, "SPAN").find(
    (candidate) => getReactProps(candidate)?.["data-quota-fill"] === kind,
  );
}

function mockQuotaUsage(used: number, entitlement = 1_000): void {
  useCopilotQuotaQueryMock.mockReturnValue({
    data: createQuotaStatus({
      primary: {
        ...createQuotaStatus().primary!,
        entitlement,
        used,
        remaining: entitlement - used,
        remainingPercentage: ((entitlement - used) / entitlement) * 100,
      },
    }),
    error: null,
    isLoading: false,
    refresh: vi.fn(),
  });
}

// Midnight on June 16 is exactly half of a 30-day month.
function freezeAtHalfMonth(): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 5, 16, 0, 0));
}

function findMenuRoot(root: any): any {
  const menuRoot = findAllByTag(root, "DIV").find((candidate) => {
    const props = getReactProps(candidate);
    return typeof props?.onMouseEnter === "function" && typeof props?.onMouseLeave === "function";
  });
  if (!menuRoot) throw new Error("Quota menu root not found");
  return menuRoot;
}

describe("CopilotQuotaMenu", () => {
  let harness: ReactDomHarness | null = null;

  beforeEach(() => {
    useCopilotQuotaQueryMock.mockReset();
    useCopilotQuotaQueryMock.mockReturnValue({
      data: createQuotaStatus(),
      error: null,
      isLoading: false,
      refresh: vi.fn(),
    });
  });

  afterEach(async () => {
    await harness?.cleanup();
    harness = null;
  });

  it("offers the full quota dialog from a compact mobile settings control", async () => {
    harness = await createReactDomHarness();
    await harness.render(routed(CopilotQuotaCard, { compact: true }));
    const button = findAllByTag(harness.dom.container, "BUTTON")[0];
    expect(button.textContent).toContain("Quota");
    expect(button.textContent).toContain("0.8%");
    expect(getReactProps(button)?.["aria-haspopup"]).toBe("dialog");
    expect(paceFill(harness.dom.container, "usage")).toBeUndefined();
    await harness.act(async () => { getReactProps(button)?.onClick?.(); });
    expect(harness.dom.container.textContent).toContain("Live account quota");
    expect(harness.dom.container.textContent).toContain("79,393.9");
  });

  it("opens detailed quota information from the rail control", async () => {
    harness = await createReactDomHarness();
    await harness.render(routed(CopilotQuotaMenu));

    const trigger = findButtonByLabel(
      harness.dom.container,
      "Live Copilot quota, 79,393.9 AI credits used",
    );
    await harness.act(async () => {
      getReactProps(trigger)?.onClick?.();
    });

    expect(findAllByTag(harness.dom.container, "DIV").some((candidate) => (
      getReactProps(candidate)?.role === "dialog"
    ))).toBe(true);
    expect(harness.dom.container.textContent).toContain("of 10,000,000 this period");
    expect(harness.dom.container.textContent).toContain("timstewart_microsoft · enterprise");

    const closeButton = findButtonByLabel(harness.dom.container, "Close quota details");
    await harness.act(async () => {
      getReactProps(closeButton)?.onClick?.();
    });
    expect(harness.dom.container.textContent).not.toContain("of 10,000,000 this period");
  });

  async function openDetailsAt(now: string, primary: Partial<NonNullable<CopilotQuotaStatus["primary"]>>): Promise<string> {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(now));
    useCopilotQuotaQueryMock.mockReturnValue({
      data: createQuotaStatus({ primary: { ...createQuotaStatus().primary!, ...primary } }),
      error: null,
      isLoading: false,
      refresh: vi.fn(),
    });
    harness = await createReactDomHarness();
    await harness.render(routed(CopilotQuotaMenu));
    const trigger = findAllByTag(harness.dom.container, "BUTTON")[0];
    await harness.act(async () => {
      getReactProps(trigger)?.onClick?.();
    });
    return harness.dom.container.textContent ?? "";
  }

  it("measures run rates against the reported quota reset instead of local month end", async () => {
    try {
      const text = await openDetailsAt("2026-09-29T00:00:00.000Z", {
        entitlement: 1_000,
        used: 100,
        remaining: 900,
        remainingPercentage: 90,
        resetAt: "2026-10-01T00:00:00.000Z",
      });
      expect(text).toContain("3.57 AI credits/day");
      expect(text).toContain("450 AI credits/day");
      expect(text).toContain("93% of month");
    } finally {
      vi.useRealTimers();
    }
  });

  it("never reports an exhaustion rate above what is left in the final day", async () => {
    try {
      const text = await openDetailsAt("2026-09-30T18:45:00.000Z", {
        entitlement: 1_000_000,
        used: 416_142.1,
        remaining: 583_857.9,
        remainingPercentage: 58.3,
        resetAt: "2026-10-01T00:00:00.000Z",
      });
      expect(text).toContain("583,857.9 AI credits in the next 5 hr");
      expect(text).not.toMatch(/To exhaust before reset[^/]*\/day/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts minutes when the reset is under an hour away and says when the quota is used up", async () => {
    try {
      let text = await openDetailsAt("2026-09-30T23:40:00.000Z", {
        entitlement: 1_000,
        used: 400,
        remaining: 600,
        remainingPercentage: 60,
        resetAt: "2026-10-01T00:00:00.000Z",
      });
      expect(text).toContain("600 AI credits in the next 20 min");
      await harness?.cleanup();
      harness = null;
      text = await openDetailsAt("2026-09-20T00:00:00.000Z", {
        entitlement: 1_000,
        used: 1_000,
        remaining: 0,
        remainingPercentage: 0,
        resetAt: "2026-10-01T00:00:00.000Z",
      });
      expect(text).toContain("Exhausted");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps an unavailable account explicit in the hover and detail views", async () => {
    useCopilotQuotaQueryMock.mockReturnValue({
      data: {
        available: false,
        fetchedAt: NOW,
        identity: null,
        primary: null,
        snapshots: [],
        error: "Account quota lookup is not available in this Copilot SDK build",
      },
      error: null,
      isLoading: false,
      refresh: vi.fn(),
    });
    harness = await createReactDomHarness();
    await harness.render(routed(CopilotQuotaMenu, { collapsed: true }));

    await harness.act(async () => {
      getReactProps(findMenuRoot(harness!.dom.container))?.onMouseEnter?.();
    });
    expect(harness.dom.container.textContent).toContain("Account quota lookup is not available in this Copilot SDK build");

    const trigger = findButtonByLabel(harness.dom.container, "Live Copilot quota");
    await harness.act(async () => {
      getReactProps(trigger)?.onClick?.();
    });
    expect(harness.dom.container.textContent).toContain("Live account quota");
    expect(harness.dom.container.textContent).toContain("Account quota lookup is not available in this Copilot SDK build");
  });

  it("preserves precision qualifiers and shows refresh errors beside cached quota", async () => {
    const refresh = vi.fn().mockRejectedValue(new Error("Quota service offline"));
    useCopilotQuotaQueryMock.mockReturnValue({
      data: createQuotaStatus({ primary: { ...createQuotaStatus().primary!, usedIsPrecise: false } }),
      error: new Error("Cached quota read"), isLoading: false, refresh,
    });
    harness = await createReactDomHarness();
    await harness.render(routed(CopilotQuotaMenu));
    const trigger = findButtonByLabel(harness.dom.container, "Cached Copilot quota, ~79,393.9 AI credits used");
    expect(getReactProps(trigger)?.["aria-haspopup"]).toBe("dialog");
    await harness.act(async () => getReactProps(trigger)?.onClick?.());
    expect(harness.dom.container.textContent).toContain("Refresh failed: Cached quota read");
    const refreshButton = findAllByTag(harness.dom.container, "BUTTON").find((button) => button.textContent === "Refresh");
    await harness.act(async () => getReactProps(refreshButton)?.onClick?.());
    expect(refresh).toHaveBeenCalledOnce();
    expect(harness.dom.container.textContent).toContain("Quota service offline");
    expect(harness.dom.container.textContent).toContain("~79,393.9");
  });

  it("keeps unlimited and unknown quota separate from a finite entitlement", async () => {
    useCopilotQuotaQueryMock.mockReturnValue({
      data: createQuotaStatus({ primary: { ...createQuotaStatus().primary!, unit: "premium_requests", isUnlimitedEntitlement: true, entitlement: null, remainingPercentage: 100, remaining: null, used: null } }),
      error: null, isLoading: false, refresh: vi.fn(),
    });
    harness = await createReactDomHarness();
    await harness.render(routed(CopilotQuotaMenu));
    const trigger = findButtonByLabel(harness.dom.container, "Live Copilot quota, Unknown premium requests used");
    expect(paceFill(harness.dom.container, "usage")).toBeUndefined();
    await harness.act(async () => getReactProps(trigger)?.onClick?.());
    expect(harness.dom.container.textContent).toContain("Unlimited allowance");
    expect(harness.dom.container.textContent).not.toContain("Unknown of");
  });

  it("shows the same half-month usage in the rail, hover and daily run-rate details", async () => {
    freezeAtHalfMonth();
    mockQuotaUsage(100);
    harness = await createReactDomHarness();
    await harness.render(routed(CopilotQuotaMenu, { collapsed: true }));

    const month = paceFill(harness.dom.container, "month");
    const usage = paceFill(harness.dom.container, "usage");
    expect(getReactProps(month)?.style).toMatchObject({ width: "50%" });
    expect(getReactProps(month)?.className).toContain("bg-text-faint/25");
    expect(getReactProps(usage)?.style).toMatchObject({ width: "10%" });
    expect(getReactProps(usage)?.className).toContain("bg-text-secondary");
    expect(paceFill(harness.dom.container, "month-marker")).toBeUndefined();

    await harness.act(async () => {
      getReactProps(findMenuRoot(harness!.dom.container))?.onMouseEnter?.();
    });
    expect(harness.dom.container.textContent).toContain("10% used");
    expect(harness.dom.container.textContent).toContain("50% of month");

    await harness.act(async () => getReactProps(findButtonByLabel(harness!.dom.container, "Live Copilot quota, 100 AI credits used"))?.onClick());
    const details = harness.dom.container.textContent ?? "";
    expect(details).toContain("Current run rate");
    expect(details).toContain("6.67 AI credits/day");
    expect(details).toContain("To exhaust before reset");
    expect(details).toContain("60 AI credits/day");
  });

});

describe("CopilotQuotaCard", () => {
  let harness: ReactDomHarness | null = null;

  beforeEach(() => {
    useCopilotQuotaQueryMock.mockReset();
  });

  afterEach(async () => {
    await harness?.cleanup();
    harness = null;
  });

  it("summarizes quota and month progress without a hover, and opens the details", async () => {
    freezeAtHalfMonth();
    mockQuotaUsage(100);
    harness = await createReactDomHarness();
    await harness.render(routed(CopilotQuotaCard));

    const text = harness.dom.container.textContent;
    expect(text).toContain("Copilot quota");
    expect(text).toContain("10% used");
    expect(text).toContain("100 of 1,000 AI credits");
    expect(text).toContain("50% of month");
    expect(getReactProps(paceFill(harness.dom.container, "month"))?.style).toMatchObject({ width: "50%" });

    const card = findButtonByLabel(harness.dom.container, "Live Copilot quota, 100 AI credits used");
    await harness.act(async () => {
      getReactProps(card)?.onClick?.();
    });
    expect(findAllByTag(harness.dom.container, "DIV").some((candidate) => (
      getReactProps(candidate)?.role === "dialog"
    ))).toBe(true);
    expect(harness.dom.container.textContent).toContain("To exhaust before reset");
  });

  it("says why when the account quota cannot be read", async () => {
    useCopilotQuotaQueryMock.mockReturnValue({
      data: {
        available: false,
        fetchedAt: NOW,
        identity: null,
        primary: null,
        snapshots: [],
        error: "Account quota lookup is not available in this Copilot SDK build",
      },
      error: null,
      isLoading: false,
      refresh: vi.fn(),
    });
    harness = await createReactDomHarness();
    await harness.render(routed(CopilotQuotaCard));

    expect(harness.dom.container.textContent).toContain("Account quota lookup is not available in this Copilot SDK build");
    expect(paceFill(harness.dom.container, "usage")).toBeUndefined();
  });
});
