import { createElement, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FOCUS_TEST_NOW, FOCUS_TEST_NOW_MS, focusAudit,
} from "../test-focus-fixtures";
import { clickFocusButton as clickButton, createFocusTestHarness, type FocusTestHarness } from "../test-focus-harness";
import { advanceTimersByTimeAct, findAllByTag, waitTick, waitUntilAct } from "../test-react-harness";

const apiMocks = vi.hoisted(() => ({
  fetchFocusAuditPage: vi.fn<typeof import("../api")["fetchFocusAuditPage"]>(),
}));

vi.mock("../api", async () => ({
  ...await vi.importActual<typeof import("../api")>("../api"),
  ...apiMocks,
}));

import FocusAuditWarning from "./FocusAuditWarning";

async function clickFocusButton(harness: FocusTestHarness, label: string) {
  await clickButton(harness, label);
  await harness.act(waitTick);
}

describe("FocusAuditWarning", () => {
  let harness: FocusTestHarness;
  let props: ComponentProps<typeof FocusAuditWarning>;

  beforeEach(async () => {
    vi.resetAllMocks();
    apiMocks.fetchFocusAuditPage.mockResolvedValue([focusAudit()]);
    harness = await createFocusTestHarness();
    vi.useFakeTimers();
    vi.setSystemTime(FOCUS_TEST_NOW_MS);
    props = { exceptions: [], onInspectHistory: vi.fn() };
  });

  afterEach(async () => {
    await harness?.cleanup();
    vi.useRealTimers();
  });

  async function render(overrides: Partial<ComponentProps<typeof FocusAuditWarning>> = {}) {
    props = { ...props, ...overrides };
    await harness.render(createElement(FocusAuditWarning, props));
  }

  it("does not let a cached empty audit page hide exceptions in a newer snapshot", async () => {
    apiMocks.fetchFocusAuditPage.mockResolvedValue([]);
    await render({ exceptions: [focusAudit()], observedAt: FOCUS_TEST_NOW });
    await clickFocusButton(harness, "Attention quality: 1 open audit exception");
    await waitUntilAct(harness.act, () => findAllByTag(harness.dom.container, "ASIDE").length === 0);
    await advanceTimersByTimeAct(harness.act, 5_000);
    await render({ exceptions: [focusAudit({ title: "New coverage exception" })], observedAt: new Date(FOCUS_TEST_NOW_MS + 5_000).toISOString() });
    expect(harness.dom.container.textContent).toContain("Attention quality: 1 open audit exception");
    expect(harness.dom.container.textContent).toContain("New coverage exception");
  });

  it("does not keep a resolved warning alive from an older disclosure cache", async () => {
    await render({ exceptions: [focusAudit()], observedAt: FOCUS_TEST_NOW });
    await clickFocusButton(harness, "Attention quality: 1 open audit exception");
    await clickFocusButton(harness, "Attention quality: 1 open audit exception");
    await advanceTimersByTimeAct(harness.act, 5_000);
    await render({ exceptions: [], observedAt: new Date(FOCUS_TEST_NOW_MS + 5_000).toISOString() });
    expect(findAllByTag(harness.dom.container, "ASIDE")).toHaveLength(0);
  });

  it.each([
    { name: "no exceptions", exceptions: [] },
    { name: "resolved exceptions", exceptions: [focusAudit({ status: "resolved", outcome: "Timing fixed", resolvedAt: FOCUS_TEST_NOW })] },
    { name: "dismissed exceptions", exceptions: [focusAudit({ status: "dismissed", outcome: "Intentional behavior", resolvedAt: FOCUS_TEST_NOW })] },
  ])("renders no warning, inbox, or success indicator for $name", async ({ exceptions }) => {
    await render({ exceptions });
    expect(harness.dom.container.textContent).toBe("");
    expect(findAllByTag(harness.dom.container, "ASIDE")).toHaveLength(0);
    expect(findAllByTag(harness.dom.container, "BUTTON")).toHaveLength(0);
    expect(apiMocks.fetchFocusAuditPage).not.toHaveBeenCalled();
  });

  it("counts only open exceptions and progressively retrieves their details, without unread or throughput metrics", async () => {
    const open = focusAudit();
    await render({ exceptions: [
      open,
      focusAudit({ id: "resolved", status: "resolved", title: "Already corrected", outcome: "Verified fixed", resolvedAt: FOCUS_TEST_NOW }),
      focusAudit({ id: "dismissed", status: "dismissed", title: "Intentionally dismissed", outcome: "No defect", resolvedAt: FOCUS_TEST_NOW }),
    ] });
    expect(findAllByTag(harness.dom.container, "BUTTON").map((button) => button.textContent))
      .toEqual(["Attention quality: 1 open audit exception"]);
    expect(harness.dom.container.textContent).not.toContain(open.notes);
    expect(harness.dom.container.textContent).not.toContain("Already corrected");
    expect(apiMocks.fetchFocusAuditPage).not.toHaveBeenCalled();
    await clickFocusButton(harness, "Attention quality: 1 open audit exception");

    expect(apiMocks.fetchFocusAuditPage).toHaveBeenCalledExactlyOnceWith(0, 50, "open");
    expect(harness.dom.container.textContent).toContain(`Missed attention: ${open.title}`);
    expect(harness.dom.container.textContent).toContain(open.notes);
    expect(harness.dom.container.textContent).toContain("They are not throughput scores.");
    expect(harness.dom.container.textContent).not.toMatch(/\b\d+\s*(?:unread|new|completed|processed)\b|\d+\s*%/i);
    expect(findAllByTag(harness.dom.container, "PROGRESS")).toHaveLength(0);
    await clickFocusButton(harness, "Inspect subject history");
    expect(props.onInspectHistory).toHaveBeenCalledExactlyOnceWith(open.objectId);
  });

  it("labels attention-quality categories and only offers subject navigation for linked exceptions", async () => {
    const audits = [
      focusAudit({ id: "overpublished", category: "false_positive", title: "Repeated non-obligation", notes: "An Event was published as an Alert.", objectId: null }),
      focusAudit({ id: "leak", category: "leakage", title: "Muted task leaked", notes: "A muted source appeared in Global Focus.", objectId: "muted-source" }),
      focusAudit({ id: "gap", category: "coverage", title: "Unobserved source", notes: "Expected checks did not run.", objectId: null }),
    ];
    apiMocks.fetchFocusAuditPage.mockResolvedValue(audits);
    await render({ exceptions: audits });
    await clickFocusButton(harness, "Attention quality: 3 open audit exceptions");
    expect(harness.dom.container.textContent).toContain("Overpublished: Repeated non-obligation");
    expect(harness.dom.container.textContent).toContain("Leakage: Muted task leaked");
    expect(harness.dom.container.textContent).toContain("Coverage: Unobserved source");
    expect(findAllByTag(harness.dom.container, "ARTICLE")).toHaveLength(3);
    await clickFocusButton(harness, "Inspect subject history");
    expect(props.onInspectHistory).toHaveBeenCalledExactlyOnceWith("muted-source");
  });

  it("keeps known open exceptions visible after a failed read and recovers through explicit retry", async () => {
    const updated = focusAudit({ title: "Confirmed missed intervention", notes: "Latest audit evidence" });
    apiMocks.fetchFocusAuditPage.mockRejectedValueOnce(new Error("Audit store offline")).mockResolvedValue([updated]);
    await render({ exceptions: [focusAudit()] });
    await clickFocusButton(harness, "Attention quality: 1 open audit exception");
    await waitUntilAct(harness.act, () => harness.dom.container.textContent!.includes("Audit store offline"));
    expect(harness.dom.container.textContent).toContain("Audit refresh failed: Audit store offline");
    expect(harness.dom.container.textContent).toContain(focusAudit().notes);
    expect(findAllByTag(harness.dom.container, "ASIDE")).toHaveLength(1);
    await clickFocusButton(harness, "Retry audits");
    await waitUntilAct(harness.act, () => harness.dom.container.textContent!.includes(updated.notes));
    expect(harness.dom.container.textContent).not.toContain("Audit store offline");
    expect(harness.dom.container.textContent).not.toContain(focusAudit().notes);
    expect(apiMocks.fetchFocusAuditPage).toHaveBeenCalledTimes(2);
  });

  it("removes the warning when a successful refresh confirms there are no open exceptions", async () => {
    apiMocks.fetchFocusAuditPage.mockResolvedValue([]);
    await render({ exceptions: [focusAudit()] });
    await clickFocusButton(harness, "Attention quality: 1 open audit exception");
    await waitUntilAct(harness.act, () => findAllByTag(harness.dom.container, "ASIDE").length === 0);
    expect(harness.dom.container.textContent).toBe("");
    expect(findAllByTag(harness.dom.container, "BUTTON")).toHaveLength(0);
  });

  it("retrieves later audit pages without dropping known exceptions after a paging failure", async () => {
    const first = Array.from({ length: 50 }, (_, index) => focusAudit({
      id: `audit-${index}`, objectId: null, title: `Open exception ${index}`,
    }));
    const last = focusAudit({ id: "oldest-audit", title: "Oldest open exception", objectId: "old-subject" });
    let failLaterPage = true;
    apiMocks.fetchFocusAuditPage.mockImplementation(async (offset) => {
      if (offset === 0) return first;
      if (failLaterPage) { failLaterPage = false; throw new Error("Older audits unavailable"); }
      return [last];
    });
    await render({ exceptions: [first[0]] });
    await clickFocusButton(harness, "Attention quality: 1 open audit exception");
    expect(findAllByTag(harness.dom.container, "ARTICLE")).toHaveLength(50);
    await clickFocusButton(harness, "Load more exceptions");
    await waitUntilAct(harness.act, () => harness.dom.container.textContent!.includes("Older audits unavailable"));
    expect(apiMocks.fetchFocusAuditPage).toHaveBeenLastCalledWith(50, 50, "open");
    expect(harness.dom.container.textContent).toContain("Open exception 49");
    expect(findAllByTag(harness.dom.container, "ARTICLE")).toHaveLength(50);
    await clickFocusButton(harness, "Retry audits");
    await waitUntilAct(harness.act, () => !harness.dom.container.textContent!.includes("Older audits unavailable"));
    await clickFocusButton(harness, "Load more exceptions");
    await waitUntilAct(harness.act, () => harness.dom.container.textContent!.includes("Oldest open exception"));
    expect(findAllByTag(harness.dom.container, "ARTICLE")).toHaveLength(51);
    expect(harness.dom.container.textContent).toContain("Attention quality: 51 open audit exceptions");
    expect(apiMocks.fetchFocusAuditPage.mock.calls).toEqual([[0, 50, "open"], [50, 50, "open"], [0, 50, "open"], [50, 50, "open"]]);
    await clickFocusButton(harness, "Inspect subject history");
    expect(props.onInspectHistory).toHaveBeenCalledExactlyOnceWith("old-subject");
    expect(findAllByTag(harness.dom.container, "BUTTON").map((button) => button.textContent)).not.toContain("Load more exceptions");
  });
});
