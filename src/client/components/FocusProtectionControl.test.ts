import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type FocusProtectionPreview, type FocusProtectionSnapshot, type FocusProtectionWindow } from "../api";
import { FOCUS_TEST_NOW_MS } from "../test-focus-fixtures";
import { protectionImpact, protectionPreview, protectionSnapshot, protectionWindow } from "../test-focus-protection-fixtures";
import {
  changeFocusField, clickFocusButton, createFocusTestHarness, focusButton,
  submitFocusForm, type FocusTestHarness,
} from "../test-focus-harness";
import { advanceTimersByTimeAct, findAllByTag, getReactProps } from "../test-react-harness";
import { FocusDashboardOverview } from "./FocusDashboardWidgets";

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const { createReactDomHarness } = await import("../test-react-harness");
  const harness = await createReactDomHarness();
  try { return await importOriginal<typeof import("@tanstack/react-query")>(); }
  finally { await harness.cleanup(); }
});
const api = vi.hoisted(() => ({
  fetchFocusProtectionCurrent: vi.fn<typeof import("../api").fetchFocusProtectionCurrent>(),
  fetchFocusProtectionPage: vi.fn<typeof import("../api").fetchFocusProtectionPage>(),
  previewFocusProtection: vi.fn<typeof import("../api").previewFocusProtection>(),
  createFocusProtection: vi.fn<typeof import("../api").createFocusProtection>(),
  cancelFocusProtection: vi.fn<typeof import("../api").cancelFocusProtection>(),
}));
vi.mock("../api", async () => ({ ...await vi.importActual<typeof import("../api")>("../api"), ...api }));

let harness: FocusTestHarness;
let server: FocusProtectionSnapshot;
let interventionConflicts: FocusProtectionPreview["interventions"];

const overview = () => createElement(FocusDashboardOverview, {
  attentionCount: 0, urgentActionCount: 0, alertTotal: 0, decisionTotal: 0, overdueHandoffTotal: 0, handedOffTotal: 0,
  dueFollowUpCount: 0, state: "clear", problems: [], onRetry: vi.fn(), onInspectHandoffs: vi.fn(),
});
const text = () => harness.dom.container.textContent;
const button = (label: string) => getReactProps(focusButton(harness.dom.container, label))!;
const modal = () => findAllByTag(harness.dom.container, "DIV").find((node) => getReactProps(node)?.role === "dialog");
const control = () => findAllByTag(harness.dom.container, "DIV").find((node) => getReactProps(node)?.["data-focus-protection-state"]);

function check(label: string) {
  const container = findAllByTag(harness.dom.container, "LABEL").find((node) => node.textContent.startsWith(label));
  const input = findAllByTag(container, "INPUT").find((node) => getReactProps(node)?.type === "checkbox");
  if (!input) throw new Error(`Checkbox not found: ${label}`);
  return input;
}
async function setChecked(label: string, checked: boolean) {
  await harness.act(async () => { getReactProps(check(label))?.onChange?.({ target: { checked } }); });
  await advanceTimersByTimeAct(harness.act, 1);
}
async function openCreate() {
  await harness.render(overview());
  await clickFocusButton(harness, "Protect focus");
  await changeFocusField(harness, "Reason", "Prepare launch review");
}
async function toggleHistory() {
  const details = findAllByTag(modal(), "DETAILS").find((node) => node.textContent.includes("Previous protection windows"));
  await harness.act(async () => { getReactProps(details)?.onToggle?.({ currentTarget: { open: true } }); });
  await advanceTimersByTimeAct(harness.act, 5);
}
function localInput(ms: number) {
  const value = new Date(ms);
  const pad = (number: number) => String(number).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}`;
}

beforeEach(async () => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(FOCUS_TEST_NOW_MS);
  harness = await createFocusTestHarness();
  server = protectionSnapshot();
  interventionConflicts = [];
  api.fetchFocusProtectionCurrent.mockImplementation(async () => ({ ...server, generatedAt: new Date(Date.now()).toISOString() }));
  api.fetchFocusProtectionPage.mockResolvedValue({ generatedAt: server.generatedAt, windows: [], nextOffset: null });
  api.previewFocusProtection.mockImplementation(async (request) => protectionPreview({
    request, startsAt: request.startsAt ?? new Date(Date.now()).toISOString(), endsAt: request.endsAt,
    generatedAt: new Date(Date.now()).toISOString(), interventions: interventionConflicts,
    confirmationToken: `preview-${api.previewFocusProtection.mock.calls.length}`,
  }));
  api.createFocusProtection.mockImplementation(async (input) => {
    const window = protectionWindow({
      startsAt: input.startsAt ?? new Date(Date.now()).toISOString(), endsAt: input.endsAt,
      reason: input.reason, timezone: input.timezone, allowNeedsInput: input.allowNeedsInput,
      allowAuthorizedDeadlineOverride: input.allowAuthorizedDeadlineOverride,
      status: input.startsAt ? "scheduled" : "active",
    });
    server = protectionSnapshot({ current: window.status === "active" ? window : null, upcoming: window.status === "scheduled" ? window : null, latest: window });
    return window;
  });
  api.cancelFocusProtection.mockImplementation(async (id) => {
    const previous = server.current ?? server.upcoming ?? protectionWindow({ id });
    const window = { ...previous, status: "cancelled" as const, cancelledAt: new Date(Date.now()).toISOString() };
    server = protectionSnapshot({ latest: window });
    return window;
  });
});
afterEach(async () => { await harness.cleanup(); vi.restoreAllMocks(); });

describe("compact protection affordance and accessible review", () => {
  it("adds only Protect focus to the inactive overview, not a permanent dashboard panel", async () => {
    await harness.render(overview());
    expect(getReactProps(control())?.["data-focus-protection-state"]).toBe("inactive");
    expect(getReactProps(control())?.className).toContain("text-text-secondary");
    expect(control().textContent).toBe("Protect focus");
    expect(findAllByTag(harness.dom.container, "SECTION")).toHaveLength(1);
    expect(api.fetchFocusProtectionPage).not.toHaveBeenCalled();
    await clickFocusButton(harness, "Protect focus");
    expect(getReactProps(modal())?.["aria-modal"]).toBe(true);
    expect(getReactProps(modal())?.["aria-labelledby"]).toBeTruthy();
    expect(document.activeElement).toBe(findAllByTag(modal(), "TEXTAREA")[0]);
    expect(button("Preview protection").disabled).toBe(true);
  });

  it.each([30, 60, 90])("calculates the %s-minute preset when previewed, then confirms the exact server request", async (minutes) => {
    await openCreate();
    await clickFocusButton(harness, `${minutes} minutes`);
    await advanceTimersByTimeAct(harness.act, 45_000);
    const previewedAt = Date.now();
    await submitFocusForm(harness);
    expect(api.previewFocusProtection).toHaveBeenCalledOnce();
    const request = api.previewFocusProtection.mock.calls[0][0];
    expect(request).not.toHaveProperty("startsAt");
    expect(request.endsAt).toBe(new Date(previewedAt + minutes * 60_000).toISOString());
    expect(request.allowNeedsInput).toBe(true);
    expect(request.allowAuthorizedDeadlineOverride).toBe(false);
    expect(api.createFocusProtection).not.toHaveBeenCalled();
    expect(text()).toContain("Review the server preview");
    await advanceTimersByTimeAct(harness.act, 10_000);
    await clickFocusButton(harness, "Confirm protection");
    expect(api.createFocusProtection.mock.calls[0][0]).toEqual({
      ...request, confirmationToken: "preview-1", confirmInterventionConflicts: false,
    });
    expect(modal()).toBeUndefined();
    expect(text()).toContain("Focus protected");
    expect(text()).toContain("Prepare launch review");
    expect(button("Cancel protection").disabled).toBe(false);
  });

  it("supports custom duration and an absolute custom end with scheduled local-to-instant conversion", async () => {
    await openCreate();
    await clickFocusButton(harness, "Custom duration");
    await changeFocusField(harness, "Duration in minutes", "135");
    const before = Date.now();
    await submitFocusForm(harness);
    expect(api.previewFocusProtection.mock.calls[0][0].endsAt).toBe(new Date(before + 135 * 60_000).toISOString());
    await clickFocusButton(harness, "Edit protection");
    await changeFocusField(harness, "Start protection", "scheduled");
    const start = localInput(FOCUS_TEST_NOW_MS + 2 * 3_600_000);
    const end = localInput(FOCUS_TEST_NOW_MS + 4 * 3_600_000);
    await changeFocusField(harness, "Start time", start);
    await clickFocusButton(harness, "Custom end time");
    await changeFocusField(harness, "End time", end);
    await submitFocusForm(harness);
    const request = api.previewFocusProtection.mock.calls[1][0];
    expect(request.startsAt).toBe(new Date(start).toISOString());
    expect(request.endsAt).toBe(new Date(end).toISOString());
    await clickFocusButton(harness, "Confirm protection");
    expect(api.createFocusProtection.mock.calls[0][0]).toMatchObject({ startsAt: request.startsAt, endsAt: request.endsAt, confirmationToken: "preview-2" });
    expect(text()).toContain("Protection scheduled");
    expect(text()).toContain("starts in");
  });

  it("keeps far-future previews confirmable without overflowing browser timeout limits", async () => {
    await openCreate();
    await changeFocusField(harness, "Start protection", "scheduled");
    await changeFocusField(harness, "Start time", localInput(FOCUS_TEST_NOW_MS + 60 * 24 * 3_600_000));
    const timer = vi.spyOn(globalThis, "setTimeout");
    await submitFocusForm(harness);
    await advanceTimersByTimeAct(harness.act, 10);
    expect(text()).not.toContain("The preview end time has passed");
    expect(button("Confirm protection").disabled).toBe(false);
    expect(timer.mock.calls.every(([, delay]) => delay === undefined || delay <= 2_147_483_647)).toBe(true);
    await clickFocusButton(harness, "Confirm protection");
    expect(api.createFocusProtection).toHaveBeenCalledOnce();
    expect(text()).toContain("Protection scheduled");
  });

  it("rejects invalid time windows, missing reasons, and durations over 7 days before preview", async () => {
    await openCreate();
    await changeFocusField(harness, "Reason", " ");
    await submitFocusForm(harness);
    expect(text()).toContain("Enter a reason");
    await changeFocusField(harness, "Reason", "Read deeply");
    await clickFocusButton(harness, "Custom duration");
    await changeFocusField(harness, "Duration in minutes", "10081");
    await submitFocusForm(harness);
    expect(text()).toContain("at most 7 days");
    await changeFocusField(harness, "Duration in minutes", "0");
    await submitFocusForm(harness);
    expect(text()).toContain("positive duration");
    await clickFocusButton(harness, "Custom end time");
    await changeFocusField(harness, "End time", localInput(FOCUS_TEST_NOW_MS - 60_000));
    await submitFocusForm(harness);
    expect(text()).toContain("end after the start");
    expect(api.previewFocusProtection).not.toHaveBeenCalled();
    expect(api.createFocusProtection).not.toHaveBeenCalled();
  });

  it("shows all required limits, slot coalescing, needs-input mute state, conflicts and in-flight work", async () => {
    interventionConflicts = protectionPreview().interventions;
    await openCreate();
    await submitFocusForm(harness);
    for (const phrase of [
      "New automatic schedule and defer starts pause", "Manual starts remain allowed",
      "Already-running work and in-flight/admitted starts continue", "Auto-resume and return prompts continue",
      "External systems are unaffected", "Recurring checks can expire unrun",
      "one original catch-up per schedule, not a replay of every tick",
      "Only otherwise eligible, authorized immediate Alerts", "Quiet and mute policy still applies",
      "does not grant agents authority",
      "4 cron slots due", "1 one-shot schedules postponed", "1 one-shot defers postponed",
      "Bounded release checks", "Can expire unrun during protection",
      "Muted release conversation", "Muted (quiet policy still applies)",
      "Rollback window", "Rollback becomes unavailable", "Quiet approval deadline", "Task state: muted",
      "Existing session", "Admitted session creation", "Admitted schedule", "Admitted defer", "Admitted recurring check",
      "2 recovery/return prompts",
    ]) expect(text(), phrase).toContain(phrase);
  });

  it("requires an independent risk acknowledgment even when the deadline bypass was opted into", async () => {
    interventionConflicts = protectionPreview().interventions;
    await openCreate();
    await setChecked("Allow eligible authorized", true);
    await submitFocusForm(harness);
    expect(button("Confirm protection").disabled).toBe(true);
    await clickFocusButton(harness, "Confirm protection");
    expect(api.createFocusProtection).not.toHaveBeenCalled();
    await setChecked("I acknowledge the intervention conflicts", true);
    expect(button("Confirm protection").disabled).toBe(false);
    await clickFocusButton(harness, "Confirm protection");
    expect(api.createFocusProtection.mock.calls[0][0]).toMatchObject({
      allowAuthorizedDeadlineOverride: true, confirmInterventionConflicts: true,
    });
  });

  it("forces a new preview and a new conflict acknowledgment after a 409", async () => {
    interventionConflicts = protectionPreview().interventions;
    api.createFocusProtection.mockRejectedValueOnce(new ApiError("Impact fingerprint changed", 409));
    await openCreate();
    await submitFocusForm(harness);
    await setChecked("I acknowledge the intervention conflicts", true);
    await clickFocusButton(harness, "Confirm protection");
    expect(text()).toContain("Confirmation requires a new preview");
    expect(button("Confirm protection").disabled).toBe(true);
    expect(getReactProps(check("I acknowledge the intervention conflicts"))?.checked).toBe(false);
    await clickFocusButton(harness, "Confirm protection");
    expect(api.createFocusProtection).toHaveBeenCalledOnce();
    await clickFocusButton(harness, "Refresh preview");
    expect(button("Confirm protection").disabled).toBe(true);
    await setChecked("I acknowledge the intervention conflicts", true);
    await clickFocusButton(harness, "Confirm protection");
    expect(api.createFocusProtection).toHaveBeenCalledTimes(2);
    expect(api.createFocusProtection.mock.calls[1][0].confirmationToken).toBe("preview-2");
  });

  it("discloses bounded cron counts and never turns uncounted schedules into zero impact", async () => {
    api.previewFocusProtection.mockResolvedValueOnce(protectionPreview({
      interventions: [],
      schedules: [
        { id: "partial", name: "Dense monitor", taskId: "task-1", type: "cron", slotsDue: 12, slotCountComplete: false,
          firstScheduledFor: "2026-09-05T18:05:00.000Z", lastScheduledFor: "2026-09-05T18:55:00.000Z", expiresAt: null },
        { id: "uncounted", name: "Uncounted monitor", taskId: "task-1", type: "cron", slotsDue: 0, slotCountComplete: false,
          firstScheduledFor: null, lastScheduledFor: null, expiresAt: null },
      ],
    }));
    await openCreate();
    await submitFocusForm(harness);
    expect(text()).toContain("At least 12 cron slots due");
    expect(text()).toContain("preview work limit");
    expect(text()).toContain("unknown, not empty");
    expect(text()).toContain("Uncounted monitor");
    expect(text()).toContain("cron slot count unknown");
    expect(text()).toContain("last counted due");
    expect(text()).toContain("including uncounted slots");
    expect(text()).not.toContain("No currently known automatic starts");
    expect(text()).not.toContain("Unknown time");
  });

  it("disables confirmation after the reviewed end passes rather than quietly extending it", async () => {
    await openCreate();
    await clickFocusButton(harness, "Custom duration");
    await changeFocusField(harness, "Duration in minutes", "1");
    await submitFocusForm(harness);
    const end = api.previewFocusProtection.mock.calls[0][0].endsAt;
    await advanceTimersByTimeAct(harness.act, 60_010);
    expect(text()).toContain("The preview end time has passed");
    expect(button("Confirm protection").disabled).toBe(true);
    await clickFocusButton(harness, "Confirm protection");
    expect(api.createFocusProtection).not.toHaveBeenCalled();
    await clickFocusButton(harness, "Refresh preview");
    expect(Date.parse(api.previewFocusProtection.mock.calls[1][0].endsAt)).toBeGreaterThan(Date.parse(end));
    expect(button("Confirm protection").disabled).toBe(false);
  });

  it("uses wrapping mobile controls, bounded inputs and accessible 44px touch targets", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    await openCreate();
    await changeFocusField(harness, "Reason", "long-unbroken-reason".repeat(20));
    await changeFocusField(harness, "Start protection", "scheduled");
    await clickFocusButton(harness, "Custom end time");
    for (const input of [
      ...findAllByTag(modal(), "TEXTAREA"), ...findAllByTag(modal(), "SELECT"),
      ...findAllByTag(modal(), "INPUT").filter((node) => getReactProps(node)?.type !== "checkbox"),
    ]) {
      const props = getReactProps(input)!;
      expect(props.className).toContain("w-full");
      expect(props.className).toContain("max-w-full");
      expect(props.className).toContain("min-w-0");
      expect(props.className).toContain("min-h-11");
    }
    for (const node of findAllByTag(modal(), "BUTTON")) expect(getReactProps(node)?.className).toContain("min-h-11");
    const classes = findAllByTag(modal(), "DIV").map((node) => getReactProps(node)?.className ?? "").join(" ");
    expect(classes).toContain("flex-wrap");
    expect(classes).toContain("[overflow-wrap:anywhere]");
    expect(classes).not.toMatch(/overflow-x-(?:auto|scroll)|w-screen|min-w-\[/);
    Reflect.deleteProperty(window, "innerWidth");
  });
});

describe("pending, unknown and recovery states", () => {
  it("shows loading or unknown reads with retry, never an inactive all-clear fallback", async () => {
    let reject!: (reason: Error) => void;
    api.fetchFocusProtectionCurrent.mockReturnValueOnce(new Promise((_resolve, failure) => { reject = failure; }));
    await harness.render(overview());
    expect(control().textContent).toContain("Verifying protection status");
    expect(button("Protect focus").disabled).toBe(true);
    await harness.act(async () => { reject(new Error("server offline")); });
    await advanceTimersByTimeAct(harness.act, 5);
    expect(control().textContent).toContain("Protection status unknown");
    expect(button("Protect focus").disabled).toBe(true);
    await clickFocusButton(harness, "Retry protection status");
    expect(control().textContent).toBe("Protect focus");
  });

  it("does not turn a pending or failed preview into zero impacts", async () => {
    let reject!: (reason: Error) => void;
    api.previewFocusProtection.mockReturnValueOnce(new Promise((_resolve, failure) => { reject = failure; }));
    await openCreate();
    await submitFocusForm(harness);
    expect(text()).toContain("Checking server impacts and conflicts");
    expect(text()).not.toContain("0 cron slots due");
    expect(text()).not.toContain("No currently known intervention conflicts");
    expect(getReactProps(modal())?.["aria-busy"]).toBe(true);
    await harness.act(async () => { reject(new Error("preview unavailable")); });
    await advanceTimersByTimeAct(harness.act, 5);
    expect(text()).toContain("impacts are unknown, not zero");
    expect(button("Retry preview").disabled).toBe(false);
    expect(api.createFocusProtection).not.toHaveBeenCalled();
    await submitFocusForm(harness);
    expect(text()).toContain("Review the server preview");
  });

  it("prevents duplicate pending confirmation and does not retry uncertain writes automatically", async () => {
    let reject!: (reason: Error) => void;
    api.createFocusProtection.mockReturnValueOnce(new Promise((_resolve, failure) => { reject = failure; }));
    await openCreate();
    await submitFocusForm(harness);
    const confirm = button("Confirm protection").onClick;
    await harness.act(async () => { confirm(); confirm(); });
    await advanceTimersByTimeAct(harness.act, 1);
    expect(api.createFocusProtection).toHaveBeenCalledOnce();
    expect(button("Confirming protection…").disabled).toBe(true);
    expect(getReactProps(modal())?.["aria-busy"]).toBe(true);
    await harness.act(async () => { reject(new Error("connection lost")); });
    await advanceTimersByTimeAct(harness.act, 5_000);
    expect(text()).toContain("creation could not be confirmed");
    expect(button("Confirm protection").disabled).toBe(true);
    expect(api.createFocusProtection).toHaveBeenCalledOnce();
  });

  it("retains the server creation receipt when the following status read fails", async () => {
    await openCreate();
    await submitFocusForm(harness);
    api.fetchFocusProtectionCurrent.mockRejectedValue(new Error("status read lost"));
    await clickFocusButton(harness, "Confirm protection");
    expect(modal()).toBeUndefined();
    expect(control().textContent).toContain("Protection status unknown");
    expect(control().textContent).toContain("Last known protection: active");
    expect(control().textContent).toContain("Prepare launch review");
    expect(control().textContent).toContain("Postponement totals are not yet verified");
  });

  it("preserves last known reason and flags when an active status refresh fails", async () => {
    server = protectionSnapshot({ current: protectionWindow({ allowNeedsInput: false, allowAuthorizedDeadlineOverride: true }) });
    await harness.render(overview());
    api.fetchFocusProtectionCurrent.mockRejectedValue(new Error("offline"));
    await advanceTimersByTimeAct(harness.act, 15_010);
    expect(control().textContent).toContain("Protection status unknown");
    expect(control().textContent).toContain("Last known protection: active");
    expect(control().textContent).toContain("Prepare launch review");
    expect(control().textContent).toContain("Needs-input bypass: off");
    expect(control().textContent).toContain("Authorized deadline bypass: eligible Alerts only");
  });
});

describe("server-derived lifecycle and bounded details", () => {
  it("counts down, then verifies expiry and retains active context until the server replies", async () => {
    const window = protectionWindow({ endsAt: new Date(FOCUS_TEST_NOW_MS + 5_000).toISOString() });
    server = protectionSnapshot({ current: window });
    await harness.render(overview());
    expect(control().textContent).toContain("remaining");
    let release!: (snapshot: FocusProtectionSnapshot) => void;
    api.fetchFocusProtectionCurrent.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    await advanceTimersByTimeAct(harness.act, 5_010);
    expect(control().textContent).toContain("Time boundary reached");
    expect(control().textContent).toContain("Do not assume protection cleared");
    expect(control().textContent).toContain("Last known protection: active");
    expect(control().textContent).not.toContain("Protect focus");
    await harness.act(async () => { release(protectionSnapshot({ generatedAt: new Date(Date.now()).toISOString(), latest: { ...window, status: "completed" } })); });
    await advanceTimersByTimeAct(harness.act, 5);
    expect(control().textContent).toBe("Protect focus");
    expect(api.cancelFocusProtection).not.toHaveBeenCalled();
  });

  it("recovers scheduled state on mount and refetches its start boundary", async () => {
    const window = protectionWindow({ status: "scheduled", startsAt: new Date(FOCUS_TEST_NOW_MS + 1_500).toISOString() });
    server = protectionSnapshot({ upcoming: window });
    await harness.render(overview());
    expect(control().textContent).toContain("Protection scheduled");
    expect(control().textContent).toContain("starts in");
    server = protectionSnapshot({ current: { ...window, status: "active" } });
    await advanceTimersByTimeAct(harness.act, 1_510);
    await advanceTimersByTimeAct(harness.act, 5);
    expect(control().textContent).toContain("Focus protected");
    await harness.render(null);
    await harness.render(overview());
    expect(control().textContent).toContain("Focus protected");
    expect(api.createFocusProtection).not.toHaveBeenCalled();
  });

  it("cancels only through the API and waits for refreshed server state", async () => {
    server = protectionSnapshot({ current: protectionWindow() });
    await harness.render(overview());
    let release!: (window: FocusProtectionWindow) => void;
    api.cancelFocusProtection.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    await clickFocusButton(harness, "Cancel protection");
    expect(button("Cancelling protection…").disabled).toBe(true);
    expect(control().textContent).toContain("Prepare launch review");
    expect(api.cancelFocusProtection.mock.calls[0][0]).toBe("protection-1");
    const cancelled = protectionWindow({ status: "cancelled", cancelledAt: new Date(Date.now()).toISOString() });
    server = protectionSnapshot({ latest: cancelled });
    await harness.act(async () => { release(cancelled); });
    await advanceTimersByTimeAct(harness.act, 10);
    expect(control().textContent).toBe("Protect focus");
  });

  it("preserves a confirmed cancellation when its follow-up read is unknown, without claiming all-clear", async () => {
    server = protectionSnapshot({ current: protectionWindow() });
    await harness.render(overview());
    api.fetchFocusProtectionCurrent.mockRejectedValue(new Error("refresh unavailable"));
    await clickFocusButton(harness, "Cancel protection");
    expect(control().textContent).toContain("Protection status unknown");
    expect(control().textContent).toContain("Last known protection: cancelled");
    expect(control().textContent).not.toContain("Protect focus");
    api.fetchFocusProtectionCurrent.mockImplementation(async () => ({ ...server, generatedAt: new Date(Date.now()).toISOString() }));
    await clickFocusButton(harness, "Retry protection status");
    expect(control().textContent).toBe("Protect focus");
  });

  it("retains active context when cancelling a separate upcoming window and the refresh fails", async () => {
    const upcoming = protectionWindow({
      id: "upcoming", status: "scheduled", reason: "Later protected work",
      startsAt: "2026-09-06T18:00:00.000Z", endsAt: "2026-09-06T19:00:00.000Z",
    });
    server = protectionSnapshot({ current: protectionWindow(), upcoming });
    api.cancelFocusProtection.mockResolvedValue({ ...upcoming, status: "cancelled", cancelledAt: new Date(Date.now()).toISOString() });
    await harness.render(overview());
    await clickFocusButton(harness, "Protection details");
    api.fetchFocusProtectionCurrent.mockRejectedValue(new Error("status unavailable"));
    await clickFocusButton(harness, "Cancel scheduled protection");
    expect(api.cancelFocusProtection.mock.calls[0][0]).toBe(upcoming.id);
    expect(control().textContent).toContain("Last known protection: active");
    expect(modal().textContent).toContain("Last known protection: cancelled");
    expect(modal().textContent).toContain("Later protected work");
    expect(findAllByTag(modal(), "BUTTON").some((node) => node.textContent === "Cancel scheduled protection")).toBe(false);
  });

  it("shows cancellation failures and preserves active protection until recovery", async () => {
    server = protectionSnapshot({ current: protectionWindow() });
    api.cancelFocusProtection.mockRejectedValue(new Error("cancel unavailable"));
    await harness.render(overview());
    await clickFocusButton(harness, "Cancel protection");
    expect(control().textContent).toContain("Cancellation could not be confirmed");
    expect(control().textContent).toContain("Focus protected");
    expect(api.cancelFocusProtection).toHaveBeenCalledOnce();
    await clickFocusButton(harness, "Retry protection status");
    expect(control().textContent).not.toContain("Cancellation could not be confirmed");
  });

  it("keeps aggregate totals separate from at most 20 recent records and lazily paginates history", async () => {
    server = protectionSnapshot({
      current: protectionWindow(),
      impacts: {
        postponed: 103, pending: 8, dispositions: { started: 90, expired: 5 },
        recent: Array.from({ length: 22 }, (_, index) => protectionImpact({ id: `impact-${index}`, title: `Recent work ${index}` })),
      },
    });
    const earlier = protectionWindow({ id: "earlier", reason: "Earlier protection", status: "completed" });
    api.fetchFocusProtectionPage.mockResolvedValueOnce({ generatedAt: server.generatedAt, windows: [earlier], nextOffset: 50 })
      .mockResolvedValueOnce({ generatedAt: server.generatedAt, windows: [protectionWindow({ id: "oldest", reason: "Oldest protection", status: "cancelled" })], nextOffset: null });
    await harness.render(overview());
    expect(control().textContent).toContain("103 recorded postponements · 8 pending");
    expect(control().textContent).not.toContain("Recent work");
    await clickFocusButton(harness, "Protection details");
    const impacts = findAllByTag(modal(), "SECTION").find((node) => getReactProps(node)?.["aria-label"] === "Recorded protection impacts");
    expect(findAllByTag(impacts, "LI")).toHaveLength(20);
    expect(modal().textContent).toContain("started: 90");
    expect(modal().textContent).toContain("expired: 5");
    expect(modal().textContent).not.toContain("Recent work 20");
    expect(api.fetchFocusProtectionPage).not.toHaveBeenCalled();
    await toggleHistory();
    expect(modal().textContent).toContain("Earlier protection");
    await clickFocusButton(harness, "Load more protection windows");
    expect(api.fetchFocusProtectionPage.mock.calls).toEqual([[0, 50], [50, 50]]);
    expect(modal().textContent).toContain("Oldest protection");
  });

  it("shows history read failures as unknown, not empty, with an explicit retry", async () => {
    api.fetchFocusProtectionPage.mockRejectedValueOnce(new Error("history unavailable"));
    await openCreate();
    await toggleHistory();
    expect(modal().textContent).toContain("Protection history is incomplete / unknown");
    expect(modal().textContent).not.toContain("No protection windows recorded");
    await clickFocusButton(harness, "Retry protection history");
    expect(modal().textContent).toContain("No protection windows recorded");
  });
});
