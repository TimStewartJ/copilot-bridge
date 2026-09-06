import { createElement, Fragment, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, FocusLaunchError, type FocusLaunchIdentity, type FocusLaunchRequest, type FocusLifecycleMutation, type FocusObject, type FocusSessionLaunch } from "../api";
import { focusAction, focusDecision, focusDetails, focusEvent, focusLaunchReceipt, focusTask, FOCUS_TEST_NOW, FOCUS_TEST_NOW_MS } from "../test-focus-fixtures";
import { changeFocusField, clickFocusButton, createFocusTestHarness, focusButton, submitFocusForm, type FocusTestHarness } from "../test-focus-harness";
import { findAllByTag, getReactProps, waitUntilAct } from "../test-react-harness";
import { queryKeys } from "../queryClient";

const api = vi.hoisted(() => ({
  deleteFocusObject: vi.fn(), fetchFocusObject: vi.fn(), transitionFocusObject: vi.fn(),
  reactivateFocusObject: vi.fn(), promoteFocusObjectToAction: vi.fn(), linkFocusObjectSession: vi.fn(),
  fetchFocusLaunchReceipt: vi.fn(), fetchFocusLaunchReceipts: vi.fn(), launchFocusSession: vi.fn(), startFocusSessionLaunch: vi.fn(),
  fetchFocusLaunchReceiptById: vi.fn(),
}));
vi.mock("../api", async () => ({ ...await vi.importActual<typeof import("../api")>("../api"), ...api }));

import FocusItemCard from "./FocusItemCard";
import { FocusInteractionProvider } from "./FocusInteractions";

describe("Focus lifecycle, handoff and session interaction", () => {
  let harness: FocusTestHarness;
  let current: FocusObject;
  let receipts: FocusSessionLaunch[];
  const ordinarySessionStart = vi.fn(async (_prompt: string, _taskId?: string, _options?: { navigateOnError?: boolean }) => "ordinary-session");
  const unexpectedFetch = vi.fn(async () => { throw new Error("Unexpected unmocked request from FocusItemCard"); });
  const callbacks = () => ({
    tasks: [focusTask()], taskGroups: [], onSelectTask: vi.fn(), onSelectSession: vi.fn(),
    onStartPromptSession: ordinarySessionStart, onChanged: vi.fn(async () => undefined), onInspectHistory: vi.fn(),
  });
  const remember = (receipt: FocusSessionLaunch) => {
    receipts = [...receipts.filter((existing) => existing.id !== receipt.id), receipt];
    return receipt;
  };
  beforeEach(async () => {
    vi.resetAllMocks();
    vi.stubGlobal("fetch", unexpectedFetch);
    harness = await createFocusTestHarness();
    vi.useFakeTimers();
    vi.setSystemTime(FOCUS_TEST_NOW_MS);
    current = focusDecision();
    receipts = [];
    api.fetchFocusObject.mockImplementation(async () => current);
    api.transitionFocusObject.mockImplementation(async (_type: string, _id: string, input: FocusLifecycleMutation) => ({ ...current, lifecycle: input.lifecycle }));
    api.reactivateFocusObject.mockImplementation(async () => ({ ...current, status: "active", lifecycle: "active", activationId: "activation-2" }));
    api.promoteFocusObjectToAction.mockImplementation(async () => ({ created: true, object: { ...current, lifecycle: "handed_off" }, action: focusAction() }));
    api.fetchFocusLaunchReceipts.mockImplementation(async (objectId: string, activationId: string) =>
      receipts.filter((receipt) => receipt.objectId === objectId && receipt.activationId === activationId));
    api.fetchFocusLaunchReceipt.mockImplementation(async (identity: FocusLaunchIdentity) =>
      receipts.find((receipt) => receipt.objectId === identity.objectId && receipt.activationId === identity.activationId && receipt.source === identity.source) ?? null);
    api.fetchFocusLaunchReceiptById.mockImplementation(async (id: string) => {
      const receipt = receipts.find((candidate) => candidate.id === id);
      if (!receipt) throw new ApiError("No durable receipt", 404);
      return receipt;
    });
    api.launchFocusSession.mockImplementation(async (input: FocusLaunchRequest) => {
      const id = `receipt-${receipts.length + 1}`;
      const receipt = remember(focusLaunchReceipt({
        ...input, id, expectedSessionId: id, sessionId: id, objectType: current.objectType,
        taskId: input.taskId ?? null, taskTitle: input.taskId === "task-1" ? "Bridge task" : input.taskId ?? null,
      }));
      return { created: true, sessionId: receipt.sessionId, receipt };
    });
    api.startFocusSessionLaunch.mockImplementation(async (id: string) => {
      const previous = receipts.find((receipt) => receipt.id === id);
      if (!previous) throw new Error("Receipt not found");
      const receipt = remember(focusLaunchReceipt({
        ...previous, status: "ready", sessionId: previous.sessionId ?? previous.expectedSessionId,
        linkedAt: FOCUS_TEST_NOW, promptStatus: "sent", promptDispatchedAt: FOCUS_TEST_NOW,
        error: null, errorStage: null, version: previous.version + 1,
      }));
      return { created: false, sessionId: receipt.sessionId, receipt };
    });
  });
  afterEach(async () => {
    await harness.cleanup();
    vi.unstubAllGlobals();
    expect(ordinarySessionStart).not.toHaveBeenCalled();
    expect(api.linkFocusObjectSession).not.toHaveBeenCalled();
    expect(unexpectedFetch).not.toHaveBeenCalled();
  });
  const render = async (card: FocusObject, extra: Partial<ComponentProps<typeof FocusItemCard>> = {}) => {
    current = card;
    await harness.render(createElement(FocusItemCard, { object: card, ...callbacks(), ...extra }));
  };
  const hasText = (text: string) => waitUntilAct(harness.act, () => Boolean(harness.dom.container.textContent?.includes(text)));

  it.each([null, "task-2"])("recovers a prior-episode session's actual %s destination instead of borrowing the new source task", async (taskId) => {
    const navigation = callbacks();
    receipts = [focusLaunchReceipt({ id: "prior-launch", sessionId: "prior-launch", expectedSessionId: "prior-launch", activationId: "old-episode", taskId })];
    await render(focusDecision({ activationId: "new-episode", taskId: "task-1", sessionId: "prior-launch" }), navigation);
    await clickFocusButton(harness, "Open session");
    expect(api.fetchFocusLaunchReceiptById).toHaveBeenCalledWith("prior-launch");
    expect(navigation.onSelectSession).toHaveBeenCalledWith("prior-launch", taskId ?? undefined);
    expect(api.launchFocusSession).not.toHaveBeenCalled();
    expect(api.startFocusSessionLaunch).not.toHaveBeenCalled();
  });

  it("opens a legacy session globally when no receipt proves its task destination", async () => {
    const navigation = callbacks();
    await render(focusDecision({ sessionId: "legacy-session", taskId: "task-1" }), navigation);
    await clickFocusButton(harness, "Open session");
    expect(navigation.onSelectSession).toHaveBeenCalledWith("legacy-session", undefined);
  });

  it("does not borrow source context when prior-receipt recovery is unavailable", async () => {
    const navigation = callbacks();
    api.fetchFocusLaunchReceiptById.mockRejectedValue(new ApiError("Receipt lookup offline", 503));
    await render(focusDecision({ sessionId: "prior-launch" }), navigation);
    await clickFocusButton(harness, "Open session");
    await hasText("Could not verify session destination");
    expect(navigation.onSelectSession).not.toHaveBeenCalled();
  });

  it("acknowledges without resolving or creating work", async () => {
    await render(focusDecision());
    await clickFocusButton(harness, "Acknowledge");
    await hasText("The source remains open");
    expect(api.transitionFocusObject).toHaveBeenCalledWith("decision", "decision-1", { lifecycle: "acknowledged", expectedActivationId: "activation-1" });
    expect(api.promoteFocusObjectToAction).not.toHaveBeenCalled();
  });

  it.each([
    ["Resolve", "resolved", true], ["Accept risk", "accepted_risk", true], ["Dismiss", "dismissed", false],
  ] as const)("requires a reason in an accessible %s modal before changing lifecycle", async (label, lifecycle, needsOutcome) => {
    await render(focusDecision());
    await clickFocusButton(harness, label);
    const dialog = findAllByTag(harness.dom.container, "DIV").find((node) => getReactProps(node)?.role === "dialog");
    expect(getReactProps(dialog)).toMatchObject({ "aria-modal": true, "aria-labelledby": expect.any(String) });
    expect(api.transitionFocusObject).not.toHaveBeenCalled();
    await submitFocusForm(harness);
    expect(api.transitionFocusObject).not.toHaveBeenCalled();
    await changeFocusField(harness, "Reason (required)", "The fallback was verified");
    if (needsOutcome) {
      await submitFocusForm(harness);
      expect(api.transitionFocusObject).not.toHaveBeenCalled();
      await changeFocusField(harness, "Outcome / remaining risk", "Serving the known-good release");
    }
    await submitFocusForm(harness);
    await hasText("Linked work was not changed");
    expect(api.transitionFocusObject).toHaveBeenCalledWith("decision", "decision-1", {
      lifecycle, lifecycleReason: "The fallback was verified", expectedActivationId: "activation-1",
      ...(needsOutcome ? { outcome: "Serving the known-good release" } : {}),
    });
  });

  it("reactivates only as a reasoned new episode bound to the inspected activation", async () => {
    await render(focusDecision({ lifecycle: "dismissed", status: "dismissed", details: focusDetails({ lifecycle: "dismissed" }) }));
    await clickFocusButton(harness, "Reactivate as a new episode");
    await submitFocusForm(harness);
    expect(api.reactivateFocusObject).not.toHaveBeenCalled();
    await changeFocusField(harness, "Episode reason", "A different release now fails");
    await submitFocusForm(harness);
    await hasText("New episode opened");
    expect(api.reactivateFocusObject).toHaveBeenCalledWith("decision", "decision-1", { episodeReason: "A different release now fails", expectedActivationId: "activation-1" });
  });

  it("offers an editable executable Action and visible active task destination before promotion", async () => {
    await render(focusDecision());
    await clickFocusButton(harness, "Hand off / Create Action");
    expect(api.promoteFocusObjectToAction).not.toHaveBeenCalled();
    const select = findAllByTag(harness.dom.container, "SELECT")[0];
    expect(getReactProps(select)?.value).toBe("task-1");
    expect(select.textContent).toContain("Bridge task");
    await changeFocusField(harness, "Executable Action text", "Roll back, then verify the health endpoint");
    await submitFocusForm(harness);
    await hasText("Action created");
    expect(api.promoteFocusObjectToAction).toHaveBeenCalledWith("decision", "decision-1", { text: "Roll back, then verify the health endpoint", taskId: "task-1", expectedActivationId: "activation-1" });
    expect(harness.dom.container.textContent).toContain("not resolved by this handoff");
    expect(api.transitionFocusObject).not.toHaveBeenCalled();
  });

  it.each(["archived", "orphaned", "muted", "global"] as const)("does not silently choose a destination for a %s source", async (taskState) => {
    await render(focusEvent({ taskState, taskId: taskState === "orphaned" || taskState === "global" ? null : "task-1" }));
    await clickFocusButton(harness, "Create Action");
    expect(getReactProps(findAllByTag(harness.dom.container, "SELECT")[0])?.value).toBe("");
    const form = findAllByTag(harness.dom.container, "FORM").at(-1);
    expect(getReactProps(focusButton(form, "Create Action"))?.disabled).toBe(true);
    await submitFocusForm(harness);
    expect(api.promoteFocusObjectToAction).not.toHaveBeenCalled();
    await changeFocusField(harness, "Destination", "__global__");
    await submitFocusForm(harness);
    await hasText("Action created");
    expect(api.promoteFocusObjectToAction).toHaveBeenCalledWith("event", "event-1", expect.objectContaining({ taskId: null, expectedActivationId: "activation-1" }));
  });

  it("blocks stale activation and lets an explicit reload bind the new promotion", async () => {
    await render(focusDecision());
    await clickFocusButton(harness, "Hand off / Create Action");
    current = focusDecision({ activationId: "activation-2" });
    await submitFocusForm(harness);
    await hasText("This item or episode changed");
    expect(api.promoteFocusObjectToAction).not.toHaveBeenCalled();
    await clickFocusButton(harness, "Reload item");
    await hasText("Current item loaded");
    await submitFocusForm(harness);
    await hasText("Action created");
    expect(api.promoteFocusObjectToAction).toHaveBeenCalledWith("decision", "decision-1", expect.objectContaining({ expectedActivationId: "activation-2" }));
  });

  it("retains the linked-existing-Action result even if its source disappears from attention", async () => {
    const card = focusDecision();
    const navigation = callbacks();
    api.promoteFocusObjectToAction.mockResolvedValue({ created: false, object: { ...card, lifecycle: "handed_off" }, action: focusAction({ text: "An existing commitment" }) });
    current = card;
    await harness.render(createElement(FocusInteractionProvider, { ...navigation }, createElement(FocusItemCard, { object: card, ...navigation })));
    await clickFocusButton(harness, "Hand off / Create Action");
    await submitFocusForm(harness);
    await hasText("Linked existing Action");
    await harness.render(createElement(FocusInteractionProvider, { ...navigation }, createElement("p", null, "Source moved to History")));
    expect(harness.dom.container.textContent).toContain("Linked existing Action");
    expect(harness.dom.container.textContent).toContain("An existing commitment");
    await clickFocusButton(harness, "Open Action");
    expect(navigation.onSelectTask).toHaveBeenCalledWith("task-1", { checklistItemId: "action-1" });
  });

  it("explains that an existing open Action is reused and destination changes move it", async () => {
    const action = focusAction();
    await render(focusDecision({ linkedActions: [{ actionId: action.id, activationId: "activation-1", createdAt: action.createdAt, action }] }));
    await clickFocusButton(harness, "Hand off / Create Action");
    expect(harness.dom.container.textContent).toContain("Changing the destination moves that existing Action");
    expect(getReactProps(findAllByTag(harness.dom.container, "TEXTAREA")[0])?.readOnly).toBe(true);
    expect(harness.dom.container.textContent).toContain("Link existing Action");
  });

  it("preserves an existing Global Action destination instead of silently moving it to the source task", async () => {
    const action = focusAction({ taskId: null });
    await render(focusDecision({ linkedActions: [{ actionId: action.id, activationId: "activation-1", createdAt: action.createdAt, action }] }));
    await clickFocusButton(harness, "Hand off / Create Action");
    expect(getReactProps(findAllByTag(harness.dom.container, "SELECT")[0])?.value).toBe("__global__");
    expect(harness.dom.container.textContent).toContain("Current Action destination: Global Actions");
    await submitFocusForm(harness);
    await hasText("Action created");
    expect(api.promoteFocusObjectToAction).toHaveBeenCalledWith("decision", "decision-1", expect.objectContaining({ taskId: null }));
  });

  it("requires explicit confirmation for moving an existing Action", async () => {
    const action = focusAction({ taskId: null });
    await render(focusDecision({ linkedActions: [{ actionId: action.id, activationId: "activation-1", createdAt: action.createdAt, action }] }));
    await clickFocusButton(harness, "Hand off / Create Action");
    await changeFocusField(harness, "Destination", "task-1");
    expect(harness.dom.container.textContent).toContain("Move this existing Action from Global Actions to Bridge task");
    await submitFocusForm(harness);
    expect(api.promoteFocusObjectToAction).not.toHaveBeenCalled();
    const confirmation = findAllByTag(harness.dom.container, "INPUT").find((input) => getReactProps(input)?.type === "checkbox");
    await harness.act(async () => { getReactProps(confirmation)?.onChange?.({ target: { checked: true } }); });
    await submitFocusForm(harness);
    await hasText("Action created");
    expect(api.promoteFocusObjectToAction).toHaveBeenCalledWith("decision", "decision-1", expect.objectContaining({ taskId: "task-1" }));
  });


  it("revalidates Action destination changes even when the source activation and fingerprint are unchanged", async () => {
    const action = focusAction({ taskId: null });
    const object = focusDecision({ linkedActions: [{ actionId: action.id, activationId: "activation-1", createdAt: action.createdAt, action }] });
    await render(object);
    await clickFocusButton(harness, "Hand off / Create Action");
    current = { ...object, linkedActions: [{ ...object.linkedActions[0], action: { ...action, taskId: "task-1" } }] };
    await submitFocusForm(harness);
    await hasText("linked Action or its destination changed");
    expect(api.promoteFocusObjectToAction).not.toHaveBeenCalled();
  });

  it("launches through the durable server transaction without ordinary creation, legacy linking or source resolution", async () => {
    const navigation = callbacks();
    const card = focusDecision({ launchPrompt: { label: "Launch review", prompt: "Review this concern" } });
    await render(card, navigation);
    await clickFocusButton(harness, "Launch review");
    await hasText("Prompt to send");
    expect(api.fetchFocusLaunchReceipt).toHaveBeenCalledWith({ objectId: card.id, activationId: card.activationId, source: "launch_prompt" });
    await clickFocusButton(harness, "Start session");
    await waitUntilAct(harness.act, () => navigation.onSelectSession.mock.calls.length === 1);
    expect(api.launchFocusSession).toHaveBeenCalledExactlyOnceWith({
      objectId: "decision-1", activationId: "activation-1", source: "launch_prompt",
      taskId: "task-1", prompt: "Review this concern",
    });
    expect(navigation.onStartPromptSession).not.toHaveBeenCalled();
    expect(api.linkFocusObjectSession).not.toHaveBeenCalled();
    expect(api.startFocusSessionLaunch).not.toHaveBeenCalled();
    expect(api.transitionFocusObject).not.toHaveBeenCalled();
    expect(api.reactivateFocusObject).not.toHaveBeenCalled();
    expect(navigation.onSelectSession).toHaveBeenCalledExactlyOnceWith("receipt-1", "task-1");
    await hasText("Prompt launch: ready");
    expect(harness.dom.container.textContent).toContain("Source resolution is separate");
  });

  it("keeps a durable receipt inspectable when its source leaves attention", async () => {
    const navigation = callbacks();
    const card = focusDecision({ launchPrompt: { label: "Launch review", prompt: "Review this concern" } });
    current = card;
    await harness.render(createElement(FocusInteractionProvider, navigation, createElement(FocusItemCard, { object: card, ...navigation })));
    await clickFocusButton(harness, "Launch review");
    await hasText("Prompt to send");
    await clickFocusButton(harness, "Send in background");
    await hasText("Session ready");
    await harness.render(createElement(FocusInteractionProvider, navigation, createElement("p", null, "Source moved to History")));
    expect(harness.dom.container.textContent).toContain("Episode-bound session launch");
    expect(harness.dom.container.textContent).toContain("Session ready");
    expect(harness.dom.container.textContent).toContain("Review this concern");
    expect(navigation.onSelectSession).not.toHaveBeenCalled();
    await clickFocusButton(harness, "Open existing session");
    expect(navigation.onSelectSession).toHaveBeenCalledExactlyOnceWith("receipt-1", "task-1");
    expect(api.launchFocusSession).toHaveBeenCalledOnce();
  });

  it("loads saved launch and discussion receipts across card instances and remounts", async () => {
    const card = focusDecision();
    const navigation = callbacks();
    remember(focusLaunchReceipt());
    remember(focusLaunchReceipt({ id: "discussion-receipt", sessionId: "discussion-session", expectedSessionId: "discussion-session", source: "discussion" }));
    await harness.render(createElement(Fragment, null,
      createElement(FocusItemCard, { object: card, ...navigation }),
      createElement(FocusItemCard, { object: card, ...navigation }),
    ));
    await hasText("Discussion: ready");
    expect(api.fetchFocusLaunchReceipts).toHaveBeenCalledWith("decision-1", "activation-1");
    expect(findAllByTag(harness.dom.container, "BUTTON").filter((node) => node.textContent === "Open launch session")).toHaveLength(2);
    expect(findAllByTag(harness.dom.container, "BUTTON").filter((node) => node.textContent === "Open discussion session")).toHaveLength(2);
    await harness.render(null);
    await render(card, navigation);
    await hasText("Discussion: ready");
    await clickFocusButton(harness, "Open launch session");
    await clickFocusButton(harness, "Open discussion session");
    expect(navigation.onSelectSession).toHaveBeenNthCalledWith(1, "receipt-1", "task-1");
    expect(navigation.onSelectSession).toHaveBeenNthCalledWith(2, "discussion-session", "task-1");
    expect(api.launchFocusSession).not.toHaveBeenCalled();
    expect(api.startFocusSessionLaunch).not.toHaveBeenCalled();
  });

  it.each([null, "task-2"])("opens a confirmed session in its actual %s destination while preserving source-task navigation", async (taskId) => {
    const navigation = callbacks();
    navigation.tasks.push(focusTask({ id: "task-2", title: "Destination task" }));
    const receipt = remember(focusLaunchReceipt({ taskId, taskTitle: taskId === null ? null : "Destination task" }));
    const card = focusDecision({ sessionId: receipt.sessionId });
    await render(card, navigation);
    await hasText("Prompt launch: ready");
    await clickFocusButton(harness, "Open session");
    await clickFocusButton(harness, "Open launch session");
    expect(navigation.onSelectSession).toHaveBeenNthCalledWith(1, receipt.sessionId, taskId ?? undefined);
    expect(navigation.onSelectSession).toHaveBeenNthCalledWith(2, receipt.sessionId, taskId ?? undefined);
    await clickFocusButton(harness, "Open task");
    expect(navigation.onSelectTask).toHaveBeenCalledWith("task-1");
    expect(api.launchFocusSession).not.toHaveBeenCalled();
    expect(api.transitionFocusObject).not.toHaveBeenCalled();
  });

  it("starts a separate durable discussion rather than reusing a launch-prompt session", async () => {
    const navigation = callbacks();
    const launch = remember(focusLaunchReceipt());
    await render(focusDecision({
      sessionId: launch.sessionId, launchPrompt: { label: "Launch review", prompt: "Already approved" },
    }), navigation);
    await clickFocusButton(harness, "Launch review");
    await hasText("Session ready");
    expect(api.launchFocusSession).not.toHaveBeenCalled();
    await clickFocusButton(harness, "Close");
    await clickFocusButton(harness, "Discuss item");
    await hasText("Message to send");
    await changeFocusField(harness, "Message to send", "What is still unresolved?");
    await clickFocusButton(harness, "Send in background");
    await hasText("Session ready");
    expect(api.launchFocusSession).toHaveBeenCalledExactlyOnceWith({
      objectId: "decision-1", activationId: "activation-1", source: "discussion", taskId: "task-1",
      prompt: expect.stringContaining("# My message\nWhat is still unresolved?"),
    });
    expect(api.fetchFocusLaunchReceipt).toHaveBeenCalledWith({ objectId: "decision-1", activationId: "activation-1", source: "discussion" });
    expect(harness.queryClient.getQueryData(queryKeys.focusLaunchReceipt(launch))).toEqual(launch);
    expect(receipts).toHaveLength(2);
    expect(receipts[1].sessionId).not.toBe(launch.sessionId);
    expect(navigation.onSelectSession).not.toHaveBeenCalled();
    expect(api.transitionFocusObject).not.toHaveBeenCalled();
  });

  it("requires a visible destination before discussing an archived source, then reopens its Global receipt", async () => {
    const navigation = callbacks();
    navigation.tasks = [focusTask({ status: "archived" })];
    await render(focusDecision({ taskState: "archived" }), navigation);
    await clickFocusButton(harness, "Discuss item");
    await hasText("Message to send");
    expect(getReactProps(findAllByTag(harness.dom.container, "SELECT")[0])?.value).toBe("");
    expect(getReactProps(focusButton(harness.dom.container, "Send in background"))?.disabled).toBe(true);
    await changeFocusField(harness, "Session destination", "__global__");
    await clickFocusButton(harness, "Send in background");
    await hasText("Session ready");
    expect(api.launchFocusSession).toHaveBeenCalledWith(expect.objectContaining({ source: "discussion", taskId: null }));
    await clickFocusButton(harness, "Close");
    await clickFocusButton(harness, "Open discussion session");
    expect(navigation.onSelectSession).toHaveBeenCalledExactlyOnceWith("receipt-1", undefined);
    expect(api.reactivateFocusObject).not.toHaveBeenCalled();
  });

  it("reviews a ready saved receipt even when the source is closed and its current prompt was removed", async () => {
    const receipt = remember(focusLaunchReceipt({ taskId: null, taskTitle: null }));
    const navigation = callbacks();
    await render(focusDecision({
      lifecycle: "resolved", status: "done", taskState: "archived", launchPrompt: null,
      details: focusDetails({ lifecycle: "resolved" }),
    }), navigation);
    await hasText("Prompt launch: ready");
    await clickFocusButton(harness, "Review launch receipt");
    await hasText("Session ready");
    await clickFocusButton(harness, "Open existing session");
    expect(navigation.onSelectSession).toHaveBeenCalledExactlyOnceWith(receipt.sessionId, undefined);
    expect(api.fetchFocusObject).not.toHaveBeenCalled();
    expect(api.launchFocusSession).not.toHaveBeenCalled();
    expect(api.startFocusSessionLaunch).not.toHaveBeenCalled();
    expect(api.reactivateFocusObject).not.toHaveBeenCalled();
  });

  it("reconciles a saved link failure using its original receipt and never silently retargets a newer episode", async () => {
    const receipt = remember(focusLaunchReceipt({
      status: "failed", promptStatus: "pending", errorStage: "link", error: "Link unavailable", linkedAt: null,
    }));
    const navigation = callbacks();
    await render(focusDecision(), navigation);
    await hasText("Prompt launch: failed");
    await clickFocusButton(harness, "Review launch receipt");
    await hasText("Link unavailable");
    current = focusDecision({ activationId: "activation-2" });
    api.startFocusSessionLaunch.mockImplementationOnce(async () => {
      const superseded = remember({
        ...receipt, status: "superseded", errorStage: "creation",
        error: "This Focus episode is no longer open/current", version: receipt.version + 1,
      });
      throw new FocusLaunchError(superseded.error!, 409, superseded);
    });
    await clickFocusButton(harness, "Resume / reconcile existing launch");
    await hasText("Launch episode superseded or closed");
    expect(api.startFocusSessionLaunch).toHaveBeenCalledExactlyOnceWith(receipt.id);
    expect(api.fetchFocusLaunchReceipt.mock.calls.every(([identity]) => identity.activationId === "activation-1")).toBe(true);
    expect(api.launchFocusSession).not.toHaveBeenCalled();
    expect(api.fetchFocusObject).not.toHaveBeenCalled();
    expect(navigation.onSelectSession).not.toHaveBeenCalled();
    expect(findAllByTag(harness.dom.container, "BUTTON").map((node) => node.textContent)).not.toContain("Resume / reconcile existing launch");
    await clickFocusButton(harness, "Open existing session");
    expect(navigation.onSelectSession).toHaveBeenCalledExactlyOnceWith(receipt.sessionId, "task-1");
  });

  it("does not guess a session's destination when receipt lookup fails and retries reads before navigating", async () => {
    const navigation = callbacks();
    const receipt = remember(focusLaunchReceipt({ taskId: null, taskTitle: null }));
    api.fetchFocusLaunchReceipts.mockRejectedValue(new Error("Receipt list unavailable"));
    api.fetchFocusLaunchReceiptById.mockRejectedValueOnce(new ApiError("Receipt unavailable", 503));
    await render(focusDecision({ sessionId: receipt.sessionId }), navigation);
    await hasText("Saved launch receipts unavailable");
    await clickFocusButton(harness, "Open session");
    await hasText("Could not verify session destination");
    expect(navigation.onSelectSession).not.toHaveBeenCalled();
    api.fetchFocusLaunchReceipts.mockResolvedValue([receipt]);
    await clickFocusButton(harness, "Retry launch receipts");
    await hasText("Prompt launch: ready");
    await clickFocusButton(harness, "Open session");
    expect(navigation.onSelectSession).toHaveBeenCalledExactlyOnceWith(receipt.sessionId, undefined);
    expect(api.launchFocusSession).not.toHaveBeenCalled();
  });

  it("scopes receipt lists to the currently inspected activation rather than an earlier episode", async () => {
    remember(focusLaunchReceipt({ status: "failed", error: "Earlier episode failed", promptStatus: "pending" }));
    const next = remember(focusLaunchReceipt({
      id: "receipt-2", expectedSessionId: "receipt-2", sessionId: "receipt-2", activationId: "activation-2",
    }));
    await render(focusDecision());
    await hasText("Prompt launch: failed");
    await render(focusDecision({ activationId: "activation-2" }));
    await hasText("Prompt launch: ready");
    expect(harness.dom.container.textContent).not.toContain("Prompt launch: failed");
    expect(api.fetchFocusLaunchReceipts).toHaveBeenCalledWith("decision-1", "activation-2");
    await clickFocusButton(harness, "Review launch receipt");
    await hasText(`Receipt: ${next.id}`);
    expect(api.fetchFocusLaunchReceipt).toHaveBeenCalledWith({ objectId: "decision-1", activationId: "activation-2", source: "launch_prompt" });
    expect(api.launchFocusSession).not.toHaveBeenCalled();
  });

  it("keeps read-only records inspectable without exposing receipt resumption or lifecycle mutations", async () => {
    const navigation = callbacks();
    const receipt = remember(focusLaunchReceipt({ status: "superseded" }));
    await render(focusDecision(), { ...navigation, readOnly: true });
    await hasText("Prompt launch: superseded");
    const labels = findAllByTag(harness.dom.container, "BUTTON").map((node) => node.textContent);
    expect(labels).not.toContain("Review launch receipt");
    expect(labels).not.toContain("Discuss item");
    expect(labels).not.toContain("Acknowledge");
    await clickFocusButton(harness, "Open launch session");
    expect(navigation.onSelectSession).toHaveBeenCalledExactlyOnceWith(receipt.sessionId, "task-1");
    expect(api.startFocusSessionLaunch).not.toHaveBeenCalled();
  });

  it("shows Create Action for ordinary Events without lifecycle or launch-prompt controls", async () => {
    await render(focusEvent({ launchPrompt: { label: "Obsolete launch", prompt: "Do not offer this shortcut" } }));
    const labels = findAllByTag(harness.dom.container, "BUTTON").map((node) => node.textContent);
    expect(labels).toContain("Create Action");
    expect(labels).toContain("Discuss item");
    for (const obsolete of ["Hand off / Create Action", "Acknowledge", "Resolve", "Accept risk", "Dismiss", "Reactivate as a new episode", "Obsolete launch", "Delete item"]) {
      expect(labels).not.toContain(obsolete);
    }
    expect(api.launchFocusSession).not.toHaveBeenCalled();
    expect(api.transitionFocusObject).not.toHaveBeenCalled();
  });

  it("rejects a changed prompt before creating a launch and keeps cleared discussion context read-only", async () => {
    const navigation = callbacks();
    await render(focusDecision({ launchPrompt: { label: "Launch review", prompt: "Old prompt" } }), navigation);
    await clickFocusButton(harness, "Launch review");
    await hasText("Prompt to send");
    current = focusDecision({ launchPrompt: { label: "Launch review", prompt: "Changed prompt" }, details: focusDetails({ contentFingerprint: "fingerprint-2" }) });
    await clickFocusButton(harness, "Start session");
    await hasText("This item or episode changed");
    expect(api.launchFocusSession).not.toHaveBeenCalled();
    await clickFocusButton(harness, "Cancel");
    await render(focusDecision({ lifecycle: "resolved", status: "done", details: focusDetails({ lifecycle: "resolved" }) }), navigation);
    await clickFocusButton(harness, "Discuss item");
    await hasText("Message to send");
    expect(harness.dom.container.textContent).toContain("Lifecycle: resolved");
    expect(harness.dom.container.textContent).toContain("Consequence of waiting");
    expect(getReactProps(focusButton(harness.dom.container, "Send in background"))?.disabled).toBe(true);
    expect(api.launchFocusSession).not.toHaveBeenCalled();
    expect(api.reactivateFocusObject).not.toHaveBeenCalled();
  });

  it("does not require the optional ordinary-session callback for a Focus launch", async () => {
    const navigation = callbacks();
    await render(focusDecision({ launchPrompt: { label: "Launch review", prompt: "Review the concern" } }), {
      ...navigation, onStartPromptSession: undefined,
    });
    await clickFocusButton(harness, "Launch review");
    await hasText("Prompt to send");
    await clickFocusButton(harness, "Start session");
    await waitUntilAct(harness.act, () => navigation.onSelectSession.mock.calls.length === 1);
    expect(api.launchFocusSession).toHaveBeenCalledOnce();
    expect(navigation.onSelectSession).toHaveBeenCalledExactlyOnceWith("receipt-1", "task-1");
  });
});
