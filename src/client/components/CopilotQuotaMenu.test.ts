import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CopilotQuotaStatus } from "../api";
import {
  createReactDomHarness,
  findAllByTag,
  getReactProps,
  type ReactDomHarness,
} from "../test-react-harness";
import CopilotQuotaMenu, { CopilotQuotaCard } from "./CopilotQuotaMenu";

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

  it("shows a compact quota summary on hover", async () => {
    harness = await createReactDomHarness();
    await harness.render(createElement(CopilotQuotaMenu, { collapsed: true }));

    expect(harness.dom.container.textContent).not.toContain("Click for quota details");

    await harness.act(async () => {
      getReactProps(findMenuRoot(harness!.dom.container))?.onMouseEnter?.();
    });

    expect(harness.dom.container.textContent).toContain("Live account quota");
    expect(harness.dom.container.textContent).toContain("79,393.9");
    expect(harness.dom.container.textContent).toContain("0.8% used");
    expect(harness.dom.container.textContent).toContain("Click for quota details");
  });

  it("opens detailed quota information from the rail control", async () => {
    harness = await createReactDomHarness();
    await harness.render(createElement(CopilotQuotaMenu));

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

  it("shows current and remaining daily run rates in the detail view", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 5, 16, 0, 0));
      useCopilotQuotaQueryMock.mockReturnValue({
        data: createQuotaStatus({
          primary: {
            ...createQuotaStatus().primary!,
            entitlement: 1_000,
            used: 100,
            remaining: 900,
            remainingPercentage: 90,
          },
        }),
        error: null,
        isLoading: false,
        refresh: vi.fn(),
      });
      harness = await createReactDomHarness();
      await harness.render(createElement(CopilotQuotaMenu));

      const trigger = findButtonByLabel(
        harness.dom.container,
        "Live Copilot quota, 100 AI credits used",
      );
      await harness.act(async () => {
        getReactProps(trigger)?.onClick?.();
      });

      expect(harness.dom.container.textContent).toContain("Current run rate");
      expect(harness.dom.container.textContent).toContain("6.67 AI credits/day");
      expect(harness.dom.container.textContent).toContain("To exhaust by month end");
      expect(harness.dom.container.textContent).toContain("60 AI credits/day");
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
    await harness.render(createElement(CopilotQuotaMenu, { collapsed: true }));

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

  it("draws quota used over month progress in the rail's mini bar", async () => {
    freezeAtHalfMonth();
    mockQuotaUsage(100);
    harness = await createReactDomHarness();
    await harness.render(createElement(CopilotQuotaMenu, { collapsed: true }));

    const month = paceFill(harness.dom.container, "month");
    const usage = paceFill(harness.dom.container, "usage");
    expect(getReactProps(month)?.style).toMatchObject({ width: "50%" });
    expect(getReactProps(month)?.className).toContain("bg-info");
    expect(getReactProps(usage)?.style).toMatchObject({ width: "10%" });
    expect(getReactProps(usage)?.className).toContain("bg-accent");
    expect(paceFill(harness.dom.container, "month-marker")).toBeUndefined();

    await harness.act(async () => {
      getReactProps(findMenuRoot(harness!.dom.container))?.onMouseEnter?.();
    });
    expect(harness.dom.container.textContent).toContain("10% used");
    expect(harness.dom.container.textContent).toContain("50% of month");
  });

  it("marks where the month stands once usage has run past it", async () => {
    freezeAtHalfMonth();
    mockQuotaUsage(900);
    harness = await createReactDomHarness();
    await harness.render(createElement(CopilotQuotaMenu));

    expect(getReactProps(paceFill(harness.dom.container, "usage"))?.style).toMatchObject({ width: "90%" });
    expect(getReactProps(paceFill(harness.dom.container, "month-marker"))?.style).toEqual({ marginLeft: "50%" });
  });

  it("keeps a sliver of usage visible when only a fraction of a percent is used", async () => {
    harness = await createReactDomHarness();
    await harness.render(createElement(CopilotQuotaMenu));

    expect(getReactProps(paceFill(harness.dom.container, "usage"))?.style).toMatchObject({ minWidth: 2 });
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
    await harness.render(createElement(CopilotQuotaCard));

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
    expect(harness.dom.container.textContent).toContain("To exhaust by month end");
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
    await harness.render(createElement(CopilotQuotaCard));

    expect(harness.dom.container.textContent).toContain("Account quota lookup is not available in this Copilot SDK build");
    expect(paceFill(harness.dom.container, "usage")).toBeUndefined();
  });
});
