import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { focusDecision, focusDetails, focusTask, FOCUS_TEST_NOW_MS } from "../test-focus-fixtures";
import { createFocusTestHarness, type FocusTestHarness } from "../test-focus-harness";
import { findAllByTag, getReactProps } from "../test-react-harness";
import { focusEvidenceValidity } from "../focus-view-model";
import FocusLifecycleDialog from "./FocusLifecycleDialog";
import FocusPromotionDialog from "./FocusPromotionDialog";

function nodes(root: any): any[] { return [root, ...(root.childNodes ?? []).flatMap(nodes)]; }

describe("Decision material evidence warnings", () => {
  let harness: FocusTestHarness;
  beforeEach(async () => { harness = await createFocusTestHarness(); vi.useFakeTimers(); vi.setSystemTime(FOCUS_TEST_NOW_MS); });
  afterEach(async () => { await harness.cleanup(); });

  it.each([
    { state: "expired", details: { validUntil: "2026-09-05T18:00:00.000Z" } },
    { state: "unknown", details: { observedAt: null, validUntil: null } },
  ] as const)("repeats $state evidence before executable promotion confirmation", async ({ state, details }) => {
    await harness.render(createElement(FocusPromotionDialog, {
      object: focusDecision({ details: focusDetails(details) }), tasks: [focusTask()], pending: false, error: null, result: null,
      onClose: vi.fn(), onReload: vi.fn(), onSubmit: vi.fn(), onSelectTask: vi.fn(), onInspectAction: vi.fn(), nowMs: FOCUS_TEST_NOW_MS,
    }));
    const all = nodes(harness.dom.container);
    const warning = all.find((node) => getReactProps(node)?.["data-evidence-validity"] === state);
    const submit = findAllByTag(harness.dom.container, "BUTTON").find((button) => getReactProps(button)?.type === "submit");
    expect(warning.textContent).toContain(`Evidence validity ${state}`);
    expect(all.indexOf(warning)).toBeLessThan(all.indexOf(submit));
  });

  it.each(["resolved", "accepted_risk", "dismissed", "reactivate"] as const)("repeats expired Decision evidence before %s lifecycle confirmation", async (intent) => {
    await harness.render(createElement(FocusLifecycleDialog, {
      object: focusDecision({ details: focusDetails({ validUntil: "2026-09-05T17:00:00Z" }) }), intent, pending: false, error: null,
      onClose: vi.fn(), onReload: vi.fn(), onSubmit: vi.fn(), nowMs: FOCUS_TEST_NOW_MS,
    }));
    const all = nodes(harness.dom.container);
    const warning = all.find((node) => getReactProps(node)?.["data-evidence-validity"] === "expired");
    const submit = findAllByTag(harness.dom.container, "BUTTON").find((button) => getReactProps(button)?.type === "submit");
    expect(warning.textContent).toContain("Recheck the evidence");
    expect(all.indexOf(warning)).toBeLessThan(all.indexOf(submit));
  });

  it("uses the retained-outcome contract and removes the obsolete loss warning", async () => {
    await harness.render(createElement(FocusLifecycleDialog, {
      object: focusDecision({ lifecycle: "resolved", details: focusDetails({ outcome: "Verified outcome retained" }) }),
      intent: "reactivate", pending: false, error: null, onClose: vi.fn(), onReload: vi.fn(), onSubmit: vi.fn(),
    }));
    expect(harness.dom.container.textContent).toContain("Previous outcome retained in History: Verified outcome retained");
    expect(harness.dom.container.textContent).not.toContain("does not retain it in transitions");
    expect(harness.dom.container.textContent).not.toContain("This server clears the previous outcome");
  });

  it("keeps invalid or future observations unknown rather than treating a future horizon as proof", () => {
    expect(focusEvidenceValidity(focusDetails({ observedAt: "invalid", validUntil: "2026-10-01T00:00:00Z" }), FOCUS_TEST_NOW_MS)).toBe("unknown");
    expect(focusEvidenceValidity(focusDetails({ observedAt: "2026-10-01T00:00:00Z", validUntil: "2026-10-02T00:00:00Z" }), FOCUS_TEST_NOW_MS)).toBe("unknown");
    expect(focusEvidenceValidity(focusDetails(), FOCUS_TEST_NOW_MS)).toBe("valid");
  });
});
