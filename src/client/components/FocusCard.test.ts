import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FocusObject } from "../api";
import { focusAction, focusAlert, focusDecision, focusDetails, focusEvent, focusSnapshot, FOCUS_TEST_NOW_MS } from "../test-focus-fixtures";
import { clickFocusButton, createFocusTestHarness, type FocusTestHarness } from "../test-focus-harness";
import { findAllByTag, getReactProps, waitUntilAct } from "../test-react-harness";
import FocusCard from "./FocusCard";

const deliveries = vi.hoisted(() => vi.fn());
vi.mock("../api", async () => ({ ...await vi.importActual<typeof import("../api")>("../api"), fetchFocusNotificationDeliveries: deliveries }));

describe("FocusCard semantics and rich content", () => {
  let harness: FocusTestHarness;
  const callbacks = () => ({ onSelectTask: vi.fn(), onSelectSession: vi.fn(), onAction: vi.fn(), onChat: vi.fn(), onLifecycle: vi.fn(), onPromote: vi.fn(), onDelete: vi.fn(), onInspectHistory: vi.fn() });
  beforeEach(async () => {
    harness = await createFocusTestHarness();
    vi.useFakeTimers();
    vi.setSystemTime(FOCUS_TEST_NOW_MS);
    deliveries.mockReset().mockResolvedValue([]);
  });
  afterEach(async () => { await harness.cleanup(); });
  const render = (card: FocusObject, extra = {}) => harness.render(createElement(FocusCard, { card, ...callbacks(), nowMs: FOCUS_TEST_NOW_MS, ...extra }));

  it("retains Markdown, safe links, lists and code rather than displaying raw markup", async () => {
    await render(focusEvent({ body: "**Bold update**\n- Review [preview](https://example.test/preview)\n\nInline `code`" }));
    expect(findAllByTag(harness.dom.container, "STRONG")[0].textContent).toBe("Bold update");
    const link = findAllByTag(harness.dom.container, "A").find((node) => node.textContent === "preview");
    expect(getReactProps(link)).toMatchObject({ href: "https://example.test/preview", target: "_blank", rel: "noopener noreferrer" });
    expect(findAllByTag(harness.dom.container, "LI").some((node) => node.textContent.includes("Review"))).toBe(true);
    expect(findAllByTag(harness.dom.container, "CODE")[0].textContent).toBe("code");
  });

  it("does not render raw HTML or unsafe Markdown links", async () => {
    await render(focusEvent({ body: "<img src=x onerror=alert(1)>\n\n[bad](javascript:alert)" }));
    expect(findAllByTag(harness.dom.container, "IMG")).toHaveLength(0);
    expect(harness.dom.container.textContent).toContain("<img");
    expect(findAllByTag(harness.dom.container, "A").every((node) => !String(getReactProps(node)?.href).startsWith("javascript:"))).toBe(true);
  });

  it("shows the exact Decision, alternatives, recommendation, timing and no-response behavior", async () => {
    const card = focusDecision();
    await render(card);
    const text = harness.dom.container.textContent;
    expect(findAllByTag(harness.dom.container, "H4")[0].textContent).toBe(card.title);
    for (const expected of [...card.details.alternatives, card.details.recommendation!, card.details.consequenceOfDelay!, card.details.fallback!]) expect(text).toContain(expected);
    expect(text).toContain("Intervene by:");
    expect(findAllByTag(harness.dom.container, "TIME").some((node) => getReactProps(node)?.dateTime === card.details.interventionBy)).toBe(true);
    expect(text).toContain("Evidence");
    expect(text).not.toContain("Mark done");
  });

  it("keeps consequences and timing visible even in a bounded priority preview", async () => {
    await render(focusDecision(), { expanded: false, onToggleExpanded: vi.fn() });
    expect(harness.dom.container.textContent).toContain("The rollback window will close.");
    expect(harness.dom.container.textContent).toContain("Keep the previous release running.");
    expect(harness.dom.container.textContent).toContain("Review details");
    expect(harness.dom.container.textContent).not.toContain("Alternatives");
  });

  it("exposes Alert impact, freshness, source authority and actual delivery eligibility without claiming delivery", async () => {
    await render(focusAlert({ details: focusDetails({ authorizationGrantId: "grant-1", notificationMode: "immediate" }) }), { snapshot: focusSnapshot() });
    const text = harness.dom.container.textContent;
    expect(text).toContain("The release cannot serve traffic.");
    expect(text).toContain("Within stated observation validity");
    expect(text).toContain("Matching active grant: Observe release health");
    expect(text).toContain("No production mutation");
    expect(text).toContain("Requested mode: immediate");
    expect(deliveries).not.toHaveBeenCalled();
    await clickFocusButton(harness, "Notification delivery evidence");
    await waitUntilAct(harness.act, () => Boolean(harness.dom.container.textContent?.includes("Eligibility and delivery are unknown")));
    expect(deliveries).toHaveBeenCalledOnce();
  });

  it("marks expired or absent evidence validity unknown instead of verified", async () => {
    await render(focusAlert({ details: focusDetails({ validUntil: "2026-09-05T17:00:00.000Z", evidence: [] }) }));
    expect(harness.dom.container.textContent).toContain("Observation validity expired");
    expect(harness.dom.container.textContent).toContain("No supporting evidence provided");
    expect(harness.dom.container.textContent).toContain("No currently verified matching grant");
    await render(focusAlert({ details: focusDetails({ observedAt: null, validUntil: null }) }));
    expect(harness.dom.container.textContent).toContain("Observation validity unknown");
  });

  it("never presents a differently scoped grant or a clock-skewed snapshot as matching active authority", async () => {
    const card = focusAlert({ details: focusDetails({ authorizationGrantId: "grant-1" }) });
    const snapshot = focusSnapshot();
    snapshot.authorityConstraints[0].sourceFamily = "other-source";
    await render(card, { snapshot });
    expect(harness.dom.container.textContent).toContain("No currently verified matching grant");
    await render(card, { snapshot: focusSnapshot({ generatedAt: "2026-09-06T18:00:00.000Z" }) });
    expect(harness.dom.container.textContent).not.toContain("Matching active grant:");
  });

  it("renders Event provenance, observed/valid times, evidence and no-obligation semantics", async () => {
    await render(focusEvent({ category: "approval-needed", metadata: { source: "A very long source name that should not dominate the card header" } }));
    const text = harness.dom.container.textContent;
    expect(text).toContain("Approval Needed");
    expect(text).toContain("A very long source name that...");
    expect(text).toContain("An observation, not an obligation");
    expect(text).toContain("release-watch");
    expect(text).toContain("release-monitor");
    expect(text).toContain("Observed");
    expect(text).toContain("Evidence");
    expect(text).toContain("Create Action");
    const controls = findAllByTag(harness.dom.container, "BUTTON").map((button) => button.textContent);
    for (const label of ["Acknowledge", "Resolve", "Accept risk", "Dismiss", "Reactivate as a new episode"]) expect(controls).not.toContain(label);
  });

  it("does not treat acknowledged, handed-off, or completed linked work as source resolution", async () => {
    const action = focusAction({ done: true });
    await render(focusDecision({ lifecycle: "handed_off", linkedActions: [{ actionId: action.id, activationId: "older-episode", createdAt: action.createdAt, action }] }));
    const text = harness.dom.container.textContent;
    expect(text).toContain("Handed off, not resolved");
    expect(text).toContain("0 open · 1 completed");
    expect(text).toContain("Action completed (earlier episode)");
    expect(text).toContain("Action completion does not resolve this decision");
    expect(findAllByTag(harness.dom.container, "SPAN").find((node) => getReactProps(node)?.["data-focus-lifecycle"])?.textContent).toBe("Handed off");
    await render(focusDecision({ lifecycle: "acknowledged" }));
    expect(harness.dom.container.textContent).toContain("Acknowledged, not resolved");
  });

  it("shows terminal reasons/outcomes and reactivation rather than a generic done toggle", async () => {
    await render(focusDecision({ status: "done", lifecycle: "accepted_risk", details: focusDetails({ lifecycle: "accepted_risk", resolutionReason: "Fallback is sufficient", outcome: "Temporary degraded availability accepted" }) }));
    expect(harness.dom.container.textContent).toContain("Risk accepted");
    expect(harness.dom.container.textContent).toContain("Fallback is sufficient");
    expect(harness.dom.container.textContent).toContain("Temporary degraded availability accepted");
    expect(harness.dom.container.textContent).toContain("Reactivate as a new episode");
    expect(harness.dom.container.textContent).not.toContain("Mark done");
  });

  it("retains shared visual rendering and task/session/prompt/discussion navigation", async () => {
    const actions = callbacks();
    const card = focusDecision({
      sessionId: "session-1", url: "https://example.test/source", links: [{ label: "Notes", url: "https://example.test/notes" }],
      launchPrompt: { label: "Launch review", prompt: "Review this event" },
      visual: { artifactId: "image-1", kind: "image", title: "Chart", displayName: "chart.png", mimeType: "image/png", size: 42, url: "/api/feed/event-1/visuals/image-1", downloadUrl: "/download", altText: "Chart preview" },
    });
    await render(card, actions);
    expect(findAllByTag(harness.dom.container, "IMG").some((node) => getReactProps(node)?.alt === "Chart preview")).toBe(true);
    expect(findAllByTag(harness.dom.container, "A").some((node) => getReactProps(node)?.["aria-label"] === "Download chart.png" && getReactProps(node)?.download === "chart.png")).toBe(true);
    await clickFocusButton(harness, "Launch review");
    await clickFocusButton(harness, "Discuss item");
    await clickFocusButton(harness, "Open task");
    await clickFocusButton(harness, "Open session");
    expect(actions.onAction).toHaveBeenCalledWith(card);
    expect(actions.onChat).toHaveBeenCalledWith(card);
    expect(actions.onSelectTask).toHaveBeenCalledWith("task-1");
    expect(actions.onSelectSession).toHaveBeenCalledWith("session-1", "task-1");
  });

  it("marks pending cards busy and disables mutation controls", async () => {
    await render(focusEvent(), { pending: true });
    expect(getReactProps(findAllByTag(harness.dom.container, "ARTICLE")[0])?.["aria-busy"]).toBe(true);
    expect(harness.dom.container.textContent).toContain("Saving...");
    expect(findAllByTag(harness.dom.container, "BUTTON").filter((button) => ["Acknowledge", "Resolve", "Accept risk", "Dismiss", "Hand off / Create Action"].includes(button.textContent)).every((button) => getReactProps(button)?.disabled)).toBe(true);
  });

  it.each(["active", "acknowledged", "handed_off", "resolved", "dismissed", "accepted_risk"] as const)("does not offer obligation lifecycle controls for an Event in %s state", async (lifecycle) => {
    await render(focusEvent({ lifecycle, details: focusDetails({ lifecycle }), launchPrompt: { label: "Hidden Event launch", prompt: "Should not launch from ordinary Event presentation" } }));
    const controls = findAllByTag(harness.dom.container, "BUTTON").map((button) => button.textContent);
    for (const label of ["Acknowledge", "Resolve", "Accept risk", "Dismiss", "Reactivate as a new episode", "Hidden Event launch", "Delete item"]) expect(controls).not.toContain(label);
    expect(controls).toContain("Discuss item");
    expect(controls).toContain("Object history");
    expect(harness.dom.container.textContent).not.toContain("The concern remains open");
  });

  it.each([
    { label: "expired", validUntil: "2026-09-05T17:00:00Z", observedAt: "2026-09-05T16:00:00Z" },
    { label: "unknown", validUntil: null, observedAt: null },
  ])("shows $label Decision evidence validity before compact lifecycle and promotion controls", async ({ label, ...details }) => {
    await render(focusDecision({ details: focusDetails(details) }), { expanded: false });
    const text = harness.dom.container.textContent ?? "";
    expect(text).toContain(`Evidence validity ${label}`);
    expect(text.indexOf(`Evidence validity ${label}`)).toBeLessThan(text.indexOf("Acknowledge"));
    expect(text.indexOf(`Evidence validity ${label}`)).toBeLessThan(text.indexOf("Hand off / Create Action"));
  });
});
