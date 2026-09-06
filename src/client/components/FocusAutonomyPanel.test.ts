import { createElement, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FocusAuthorityGrant, FocusCoverageRead, FocusCoverageSummary, Task } from "../api";
import {
  FOCUS_TEST_NOW, FOCUS_TEST_NOW_MS, focusCoverage, focusGrant, focusSnapshot, focusTask,
} from "../test-focus-fixtures";
import { clickFocusButton as clickButton, createFocusTestHarness, type FocusTestHarness } from "../test-focus-harness";
import { advanceTimersByTimeAct, findAllByTag, waitTick, waitUntilAct } from "../test-react-harness";

const apiMocks = vi.hoisted(() => ({
  fetchFocusCoveragePage: vi.fn<typeof import("../api")["fetchFocusCoveragePage"]>(),
  fetchFocusAuthorityPage: vi.fn<typeof import("../api")["fetchFocusAuthorityPage"]>(),
}));

vi.mock("../api", async () => ({
  ...await vi.importActual<typeof import("../api")>("../api"),
  ...apiMocks,
}));

import FocusAutonomyPanel from "./FocusAutonomyPanel";

function summary(overrides: Partial<FocusCoverageSummary> = {}): FocusCoverageSummary {
  return { ...focusSnapshot().coverage.summary!, ...overrides };
}

async function clickFocusButton(harness: FocusTestHarness, label: string) {
  await clickButton(harness, label);
  await harness.act(waitTick);
}

describe("FocusAutonomyPanel", () => {
  let harness: FocusTestHarness;
  let props: ComponentProps<typeof FocusAutonomyPanel>;

  beforeEach(async () => {
    vi.resetAllMocks();
    apiMocks.fetchFocusCoveragePage.mockResolvedValue({ assertions: [focusCoverage()], summary: summary() });
    apiMocks.fetchFocusAuthorityPage.mockResolvedValue([focusGrant()]);
    harness = await createFocusTestHarness();
    vi.useFakeTimers();
    vi.setSystemTime(FOCUS_TEST_NOW_MS);
    props = {
      snapshot: focusSnapshot(), nowMs: FOCUS_TEST_NOW_MS, tasks: [focusTask()],
      onRetry: vi.fn(), onSelectTask: vi.fn(),
    };
  });

  afterEach(async () => {
    await harness?.cleanup();
    vi.useRealTimers();
  });

  async function render(overrides: Partial<ComponentProps<typeof FocusAutonomyPanel>> = {}) {
    props = { ...props, ...overrides };
    await harness.render(createElement(FocusAutonomyPanel, props));
  }

  function reportedCounts() {
    return Object.fromEntries(findAllByTag(harness.dom.container, "DT").map((term) => [
      term.textContent, findAllByTag(term.parentNode, "DD")[0]?.textContent,
    ]));
  }

  it("prefers newer snapshot coverage over cached disclosure pages after collapsing and reopening", async () => {
    await render();
    await clickFocusButton(harness, "Inspect coverage assertions");
    expect(reportedCounts()["Valid assurances"]).toBe("1");
    await clickFocusButton(harness, "Inspect coverage assertions");
    await advanceTimersByTimeAct(harness.act, 5_000);
    const broken = focusCoverage({ explicitState: "broken", state: "broken", reason: "Monitor stopped", updatedAt: new Date(FOCUS_TEST_NOW_MS + 5_000).toISOString() });
    const brokenSummary = summary({ counts: { valid: 0, "at-risk": 0, expired: 0, broken: 1, unknown: 0 } });
    await render({ nowMs: FOCUS_TEST_NOW_MS + 5_000, snapshot: focusSnapshot({
      generatedAt: new Date(FOCUS_TEST_NOW_MS + 5_000).toISOString(), allClear: false,
      coverage: { assertions: [broken], summary: brokenSummary },
    }) });
    expect(reportedCounts()).toMatchObject({ "Valid assurances": "0", Broken: "1" });
    await clickFocusButton(harness, "Inspect coverage assertions");
    expect(harness.dom.container.textContent).toContain("Reported state: broken");
    expect(harness.dom.container.textContent).toContain("Monitor stopped");
    await render({ nowMs: FOCUS_TEST_NOW_MS + 6_000, snapshot: focusSnapshot({
      generatedAt: new Date(FOCUS_TEST_NOW_MS + 6_000).toISOString(),
      coverage: { assertions: [], summary: summary({ total: 0, counts: { valid: 0, "at-risk": 0, expired: 0, broken: 0, unknown: 0 } }) },
    }) });
    expect(findAllByTag(harness.dom.container, "ARTICLE")).toHaveLength(0);
    expect(reportedCounts()["Valid assurances"]).toBe("0");
  });

  it("uses a newly revoked snapshot grant rather than an earlier cached active grant", async () => {
    await render();
    await clickFocusButton(harness, "Authority grants and constraints");
    expect(harness.dom.container.textContent).toContain("Active recorded grant");
    await clickFocusButton(harness, "Authority grants and constraints");
    await advanceTimersByTimeAct(harness.act, 5_000);
    await render({ nowMs: FOCUS_TEST_NOW_MS + 5_000, snapshot: focusSnapshot({
      generatedAt: new Date(FOCUS_TEST_NOW_MS + 5_000).toISOString(),
      authorityConstraints: [{ ...focusGrant({ status: "revoked", revokeReason: "Scope withdrawn" }), currentlyActive: false }],
    }) });
    await clickFocusButton(harness, "Authority grants and constraints");
    expect(harness.dom.container.textContent).toContain("Revoked");
    expect(harness.dom.container.textContent).not.toContain("Active recorded grant");
  });

  it("reports all five actual coverage counts, gaps, intervention windows, and constraints without a safety claim", async () => {
    const assertions: FocusCoverageRead[] = [
      focusCoverage({ id: "scoped", title: "Scoped health checks" }),
      focusCoverage({
        id: "unapproved", title: "Observed but not authorized", authorityGrantId: null,
        constrainedAutonomy: ["No currently active matching authority grant"],
      }),
      focusCoverage({
        id: "overdue", title: "Overdue probe", state: "at-risk", lastCheckedAt: "2026-09-05T16:00:00.000Z",
        observationGap: "Observation overdue", interventionBy: "2026-09-05T17:59:00.000Z",
      }),
      focusCoverage({ id: "expired", title: "Expired assertion", state: "expired", validUntil: FOCUS_TEST_NOW }),
      focusCoverage({
        id: "broken", title: "Broken monitor", state: "broken", explicitState: "broken", reason: "Probe credentials rejected",
        constrainedAutonomy: ["No production mutation"],
      }),
      focusCoverage({
        id: "unknown", title: "Unobserved service", state: "unknown", explicitState: "unknown",
        lastCheckedAt: null, validUntil: null, evidence: [], observationGap: "Never checked",
      }),
    ];
    const coverageSummary = summary({
      total: 6, counts: { valid: 2, "at-risk": 1, expired: 1, broken: 1, unknown: 1 },
      observationGaps: [
        { id: "overdue", title: "Overdue probe", reason: "Observation overdue" },
        { id: "unknown", title: "Unobserved service", reason: "Never checked" },
      ],
      upcomingInterventions: [
        { id: "overdue", title: "Overdue probe", interventionBy: "2026-09-05T17:59:00.000Z" },
        { id: "scoped", title: "Scoped health checks", interventionBy: "2026-09-05T19:00:00.000Z" },
        { id: "broken", title: "Broken monitor", interventionBy: "2026-09-05T20:00:00.000Z" },
        { id: "unknown", title: "Unobserved service", interventionBy: "2026-09-05T21:00:00.000Z" },
      ],
      constrainedAutonomy: [
        { id: "unapproved", constraints: ["No currently active matching authority grant"] },
        { id: "broken", constraints: ["No production mutation"] },
      ],
    });
    await render({ snapshot: focusSnapshot({ allClear: false, coverage: { assertions, summary: coverageSummary } }) });

    expect(reportedCounts()).toEqual({
      "Valid assurances": "2", "At risk": "1", Expired: "1", Broken: "1", Unknown: "1",
    });
    const text = harness.dom.container.textContent;
    expect(text).toContain("No claim of overall safety.");
    expect(text).toContain("Reported at the last successful check, not continuously verified:");
    expect(text).toContain("Observation gaps (2)");
    expect(text).toContain("Overdue probe: Observation overdue");
    expect(text).toContain("Unobserved service: Never checked");
    expect(text).toContain("Overdue probe — time reached:");
    expect(text).toContain("1 additional windows in the assertions below.");
    expect(text).toContain("Recorded authority gaps / constraints (2)");
    expect(text).toContain("Observed but not authorized: No currently active matching authority grant");
    expect(text).toContain("Broken monitor: No production mutation");
    expect(text).toContain("It does not, by itself, prove that execution is stopped or blocked.");
    expect(text).not.toContain("Missing or expired matching authority constrains work");
    expect(text).not.toMatch(/all clear|everything is safe|fully covered/i);
    expect(findAllByTag(harness.dom.container, "ARTICLE")).toHaveLength(0);
    expect(apiMocks.fetchFocusCoveragePage).not.toHaveBeenCalled();
    expect(apiMocks.fetchFocusAuthorityPage).not.toHaveBeenCalled();
  });

  it.each([
    { name: "missing snapshot", snapshot: undefined, message: "Coverage freshness unknown or stale." },
    {
      name: "stale snapshot",
      snapshot: focusSnapshot({ generatedAt: new Date(FOCUS_TEST_NOW_MS - 46_000).toISOString() }),
      message: "Coverage freshness unknown or stale.",
    },
    {
      name: "failed coverage domain",
      snapshot: focusSnapshot({ domainHealth: {
        ...focusSnapshot().domainHealth, coverage: { status: "error", error: "Probe endpoint unavailable" },
      } }),
      message: "Probe endpoint unavailable",
    },
    {
      name: "no assertions",
      snapshot: focusSnapshot({ coverage: {
        assertions: [], summary: summary({ total: 0, counts: { valid: 0, "at-risk": 0, expired: 0, broken: 0, unknown: 0 } }),
      } }),
      message: "Coverage is incomplete or unknown. No assurance can be inferred from absent Alerts.",
    },
    {
      name: "unknown summary", snapshot: focusSnapshot({ coverage: { assertions: [], summary: null } }),
      message: "Coverage is incomplete or unknown. No assurance can be inferred from absent Alerts.",
    },
  ])("offers retry rather than assurance for $name", async ({ snapshot, message }) => {
    await render({ snapshot });
    expect(harness.dom.container.textContent).toContain(message);
    expect(harness.dom.container.textContent).not.toMatch(/all clear|everything is safe/i);
    await clickFocusButton(harness, "Retry coverage checks");
    expect(props.onRetry).toHaveBeenCalledOnce();
    expect(apiMocks.fetchFocusCoveragePage).not.toHaveBeenCalled();
    expect(apiMocks.fetchFocusAuthorityPage).not.toHaveBeenCalled();
  });

  it.each([
    { name: "validity expiry", overrides: { validUntil: "2026-09-05T18:00:20.000Z", atRiskMinutes: 0 } },
    { name: "overdue observation", overrides: { lastCheckedAt: "2026-09-05T17:59:15.000Z", expectedIntervalMinutes: 1 } },
    { name: "intervention time", overrides: { interventionBy: "2026-09-05T18:00:20.000Z", atRiskMinutes: 0 } },
  ])("removes unqualified validity when $name passes while the panel is mounted", async ({ overrides }) => {
    const assertion = focusCoverage(overrides);
    const coverage = { assertions: [assertion], summary: summary() };
    apiMocks.fetchFocusCoveragePage.mockResolvedValue(coverage);
    await render({ snapshot: focusSnapshot({ coverage }) });
    await clickFocusButton(harness, "Inspect coverage assertions");
    expect(findAllByTag(harness.dom.container, "P").some((node) => node.textContent === "Reported state: valid")).toBe(true);

    await advanceTimersByTimeAct(harness.act, 20_000);
    await render({ nowMs: FOCUS_TEST_NOW_MS + 20_000 });
    expect(harness.dom.container.textContent).toContain("Refresh before relying on these counts.");
    expect(harness.dom.container.textContent).toContain("needs refresh; do not rely on old validity");
    expect(findAllByTag(harness.dom.container, "P").some((node) => node.textContent === "Reported state: valid")).toBe(false);
    expect(harness.dom.container.textContent).toContain("Reported at the last successful check, not continuously verified:");
  });

  it("pages assertions with their provenance and evidence, preserving loaded data through a later-page error", async () => {
    const first = Array.from({ length: 50 }, (_, index) => focusCoverage({
      id: `coverage-${index}`, title: `Checked scope ${index}`,
      ...(index === 0 ? { evidence: [{
        summary: "Scoped endpoint returned HTTP 200", url: "https://example.test/probe", observedAt: FOCUS_TEST_NOW,
      }] } : {}),
    }));
    const last = focusCoverage({ id: "last-coverage", title: "Final checked scope" });
    const coverageSummary = summary({ total: 51, counts: { valid: 51, "at-risk": 0, expired: 0, broken: 0, unknown: 0 } });
    let failLaterPage = true;
    apiMocks.fetchFocusCoveragePage.mockImplementation(async (offset) => {
      if (offset === 0) return { assertions: first, summary: coverageSummary };
      if (failLaterPage) { failLaterPage = false; throw new Error("Older assertions unavailable"); }
      return { assertions: [last], summary: coverageSummary };
    });
    await render({ snapshot: focusSnapshot({ coverage: { assertions: [...first, last], summary: coverageSummary } }) });
    expect(apiMocks.fetchFocusCoveragePage).not.toHaveBeenCalled();
    await clickFocusButton(harness, "Inspect coverage assertions");
    expect(apiMocks.fetchFocusCoveragePage).toHaveBeenCalledWith(0, 50);
    expect(findAllByTag(harness.dom.container, "ARTICLE")).toHaveLength(50);
    expect(reportedCounts()["Valid assurances"]).toBe("51");
    expect(harness.dom.container.textContent).not.toContain("Final checked scope");
    expect(harness.dom.container.textContent).toContain("Declared coverage scope: Staging health endpoint only");
    expect(harness.dom.container.textContent).toContain("Source: release-watch · Producer: release-monitor");
    expect(harness.dom.container.textContent).toContain("Expected every 60 minutes");
    expect(harness.dom.container.textContent).toContain("Scoped endpoint returned HTTP 200");
    const evidence = findAllByTag(harness.dom.container, "A").find((link) => link.textContent === "Open evidence ");
    expect(evidence?.getAttribute("href")).toBe("https://example.test/probe");

    await clickFocusButton(harness, "Load more assertions");
    await waitUntilAct(harness.act, () => harness.dom.container.textContent!.includes("Older assertions unavailable"));
    expect(apiMocks.fetchFocusCoveragePage).toHaveBeenLastCalledWith(50, 50);
    expect(findAllByTag(harness.dom.container, "ARTICLE")).toHaveLength(50);
    expect(harness.dom.container.textContent).toContain("Coverage assertions unavailable: Older assertions unavailable");
    await clickFocusButton(harness, "Retry coverage checks");
    expect(props.onRetry).toHaveBeenCalledOnce();
    await waitUntilAct(harness.act, () => !harness.dom.container.textContent!.includes("Older assertions unavailable"));
    await clickFocusButton(harness, "Load more assertions");
    await waitUntilAct(harness.act, () => harness.dom.container.textContent!.includes("Final checked scope"));
    expect(findAllByTag(harness.dom.container, "ARTICLE")).toHaveLength(51);
    expect(apiMocks.fetchFocusCoveragePage.mock.calls).toEqual([[0, 50], [50, 50], [0, 50], [50, 50]]);
    expect(apiMocks.fetchFocusAuthorityPage).not.toHaveBeenCalled();
    expect(findAllByTag(harness.dom.container, "BUTTON").map((button) => button.textContent)).not.toContain("Load more assertions");
  });

  it("keeps a known expiry warning when the expiring assertion is outside the loaded API page", async () => {
    const first = Array.from({ length: 50 }, (_, index) => focusCoverage({
      id: `coverage-${index}`, title: `Long-lived assertion ${index}`,
    }));
    const expiring = focusCoverage({
      id: "expiring-unloaded", title: "Assertion on the next page",
      validUntil: "2026-09-05T18:00:10.000Z", atRiskMinutes: 0,
    });
    const coverageSummary = summary({ total: 51, counts: { valid: 51, "at-risk": 0, expired: 0, broken: 0, unknown: 0 } });
    apiMocks.fetchFocusCoveragePage.mockResolvedValue({ assertions: first, summary: coverageSummary });
    await render({ snapshot: focusSnapshot({ coverage: { assertions: [...first, expiring], summary: coverageSummary } }) });
    await clickFocusButton(harness, "Inspect coverage assertions");
    expect(findAllByTag(harness.dom.container, "ARTICLE")).toHaveLength(50);
    expect(harness.dom.container.textContent).not.toContain("Refresh before relying on these counts.");

    await advanceTimersByTimeAct(harness.act, 10_000);
    await render({ nowMs: FOCUS_TEST_NOW_MS + 10_000 });
    expect(apiMocks.fetchFocusCoveragePage).toHaveBeenCalledOnce();
    expect(harness.dom.container.textContent).toContain("Refresh before relying on these counts.");
  });

  it("discloses scoped authority, validity, task context, constraints, and qualified notification permissions on request", async () => {
    const grant = focusGrant({
      allowImmediate: true, allowQuietHoursOverride: true,
      constraints: ["Read staging only", "Never deploy without separate approval"],
    });
    apiMocks.fetchFocusAuthorityPage.mockResolvedValue([grant]);
    await render();
    expect(harness.dom.container.textContent).not.toContain(grant.title);
    expect(apiMocks.fetchFocusAuthorityPage).not.toHaveBeenCalled();
    await clickFocusButton(harness, "Authority grants and constraints");

    expect(apiMocks.fetchFocusAuthorityPage).toHaveBeenCalledExactlyOnceWith(0, 50);
    const text = harness.dom.container.textContent;
    expect(text).toContain("Active recorded grant");
    expect(text).toContain(`Declared scope: ${grant.scope}`);
    expect(text).toContain("Scope and constraints are recorded declarations.");
    expect(text).toContain("Runtime-enforced permissions depend on the actual action path.");
    expect(text).toContain("Source: release-watch · Producer: release-monitor");
    expect(text).toContain(`Valid from ${new Date(grant.validFrom).toLocaleString()} until ${new Date(grant.validUntil).toLocaleString()}`);
    expect(text).toContain("Granted by: Tim");
    expect(text).toContain("Read staging only");
    expect(text).toContain("Never deploy without separate approval");
    expect(text).toContain("Immediate notifications: allowed by grant, subject to delivery policy");
    expect(text).toContain("Quiet-hours override: permitted only when settings also allow it");
    expect(text).toContain("they are not general execution permissions.");
    await clickFocusButton(harness, "Open grant task");
    expect(props.onSelectTask).toHaveBeenCalledExactlyOnceWith("task-1");
    expect(apiMocks.fetchFocusCoveragePage).not.toHaveBeenCalled();
  });

  const grantStates: Array<{ name: string; grant: Partial<FocusAuthorityGrant>; tasks: Task[]; expected: string }> = [
    { name: "revoked", grant: { status: "revoked", revokeReason: "Permission withdrawn" }, tasks: [focusTask()], expected: "Revoked" },
    { name: "expired despite its stored active status", grant: { validUntil: FOCUS_TEST_NOW }, tasks: [focusTask()], expected: "Expired" },
    {
      name: "not yet active", grant: { validFrom: "2026-09-06T18:00:00.000Z", validUntil: "2026-09-07T18:00:00.000Z" },
      tasks: [focusTask()], expected: "Not yet active",
    },
    {
      name: "orphaned", grant: { status: "revoked", orphanedAt: FOCUS_TEST_NOW, revokeReason: "task-deleted" },
      tasks: [], expected: "Orphaned - not active",
    },
    { name: "missing task", grant: {}, tasks: [], expected: "Task availability unverified" },
    { name: "archived task", grant: {}, tasks: [focusTask({ status: "archived" })], expected: "Task availability unverified" },
    { name: "global only, not a wildcard task grant", grant: { taskId: null }, tasks: [], expected: "Active recorded grant" },
  ];

  it.each(grantStates)("identifies $name authority without treating the active flag as sufficient", async ({ grant: overrides, tasks, expected }) => {
    const grant = focusGrant(overrides);
    apiMocks.fetchFocusAuthorityPage.mockResolvedValue([grant]);
    await render({ tasks });
    await clickFocusButton(harness, "Authority grants and constraints");
    const article = findAllByTag(harness.dom.container, "ARTICLE")[0];
    expect(findAllByTag(article, "P").map((node) => node.textContent)).toContain(expected);
    if (expected !== "Active recorded grant") expect(article.textContent).not.toContain("Active recorded grant");
    expect(article.textContent).toContain("Immediate notifications: not allowed");
    expect(article.textContent).toContain("Quiet-hours override: not allowed");
    if (grant.revokeReason) expect(article.textContent).toContain(`Revocation reason: ${grant.revokeReason}`);
    if (!grant.taskId) {
      expect(article.textContent).toContain("Global scope");
      expect(findAllByTag(article, "BUTTON")).toHaveLength(0);
    }
  });

  it("expires a displayed grant when its validity window ends without waiting for a stored status change", async () => {
    const grant = focusGrant({ validUntil: "2026-09-05T18:00:20.000Z" });
    apiMocks.fetchFocusAuthorityPage.mockResolvedValue([grant]);
    await render();
    await clickFocusButton(harness, "Authority grants and constraints");
    expect(harness.dom.container.textContent).toContain("Active recorded grant");
    await advanceTimersByTimeAct(harness.act, 20_000);
    await render({ nowMs: FOCUS_TEST_NOW_MS + 20_000 });
    const article = findAllByTag(harness.dom.container, "ARTICLE")[0];
    expect(findAllByTag(article, "P").map((node) => node.textContent)).toContain("Expired");
    expect(article.textContent).not.toContain("Active recorded grant");
  });

  it("marks snapshot grants unknown after a failed authority read and retries without claiming current permission", async () => {
    apiMocks.fetchFocusAuthorityPage.mockRejectedValueOnce(new Error("Authority store offline"))
      .mockResolvedValue([focusGrant({ status: "revoked", revokeReason: "Approval withdrawn" })]);
    await render();
    await clickFocusButton(harness, "Authority grants and constraints");
    await waitUntilAct(harness.act, () => harness.dom.container.textContent!.includes("Authority store offline"));
    expect(harness.dom.container.textContent).toContain("Authority unavailable; last loaded grants are not current assurance.");
    expect(harness.dom.container.textContent).toContain(focusGrant().title);
    expect(harness.dom.container.textContent).toContain("Current authority unknown");
    expect(harness.dom.container.textContent).not.toContain("Active recorded grant");
    await clickFocusButton(harness, "Retry authority");
    await waitUntilAct(harness.act, () => harness.dom.container.textContent!.includes("Approval withdrawn"));
    expect(harness.dom.container.textContent).not.toContain("Authority store offline");
    expect(harness.dom.container.textContent).not.toContain("Current authority unknown");
    expect(harness.dom.container.textContent).toContain("Revoked");
  });

  it("does not describe stale snapshot grants as current authority while their refresh is pending", async () => {
    const grant = focusGrant();
    let resolveGrants!: (grants: FocusAuthorityGrant[]) => void;
    apiMocks.fetchFocusAuthorityPage.mockImplementationOnce(() => new Promise((resolve) => { resolveGrants = resolve; }));
    await render({ snapshot: focusSnapshot({ generatedAt: new Date(FOCUS_TEST_NOW_MS - 60_000).toISOString() }) });
    await clickFocusButton(harness, "Authority grants and constraints");
    const pendingText = harness.dom.container.textContent;
    await harness.act(async () => { resolveGrants([grant]); await waitTick(); });
    await waitUntilAct(harness.act, () => !harness.dom.container.textContent!.includes("Loading authority grants..."));

    expect(pendingText).toContain("Loading authority grants...");
    expect(pendingText).toContain(grant.title);
    expect(pendingText).not.toContain("Active recorded grant");
    expect(harness.dom.container.textContent).toContain("Active recorded grant");
  });

  it("uses an empty successful authority response rather than reviving snapshot permission", async () => {
    apiMocks.fetchFocusAuthorityPage.mockResolvedValue([]);
    await render();
    await clickFocusButton(harness, "Authority grants and constraints");
    expect(harness.dom.container.textContent).toContain("No authority grants recorded. Do not infer authorization from silence.");
    expect(harness.dom.container.textContent).not.toContain(focusGrant().title);
    expect(findAllByTag(harness.dom.container, "ARTICLE")).toHaveLength(0);
  });

  it("pages all grants and treats a later-page failure as incomplete authority rather than fresh assurance", async () => {
    const first = Array.from({ length: 50 }, (_, index) => focusGrant({ id: `grant-${index}`, title: `Scoped grant ${index}`, taskId: null }));
    const last = focusGrant({ id: "last-grant", title: "Old revoked grant", status: "revoked", revokeReason: "Superseded scope" });
    let failLaterPage = true;
    apiMocks.fetchFocusAuthorityPage.mockImplementation(async (offset) => {
      if (offset === 0) return first;
      if (failLaterPage) { failLaterPage = false; throw new Error("Older authority unavailable"); }
      return [last];
    });
    await render();
    await clickFocusButton(harness, "Authority grants and constraints");
    expect(findAllByTag(harness.dom.container, "ARTICLE")).toHaveLength(50);
    await clickFocusButton(harness, "Load more grants");
    await waitUntilAct(harness.act, () => harness.dom.container.textContent!.includes("Older authority unavailable"));
    expect(apiMocks.fetchFocusAuthorityPage).toHaveBeenLastCalledWith(50, 50);
    expect(findAllByTag(harness.dom.container, "ARTICLE")).toHaveLength(50);
    expect(harness.dom.container.textContent).toContain("Scoped grant 49");
    expect(harness.dom.container.textContent).toContain("Current authority unknown");
    expect(harness.dom.container.textContent).not.toContain("Active recorded grant");
    await clickFocusButton(harness, "Retry authority");
    await waitUntilAct(harness.act, () => !harness.dom.container.textContent!.includes("Older authority unavailable"));
    await clickFocusButton(harness, "Load more grants");
    await waitUntilAct(harness.act, () => harness.dom.container.textContent!.includes("Superseded scope"));
    expect(findAllByTag(harness.dom.container, "ARTICLE")).toHaveLength(51);
    expect(apiMocks.fetchFocusAuthorityPage.mock.calls).toEqual([[0, 50], [50, 50], [0, 50], [50, 50]]);
    expect(findAllByTag(harness.dom.container, "BUTTON").map((button) => button.textContent)).not.toContain("Load more grants");
  });
});
