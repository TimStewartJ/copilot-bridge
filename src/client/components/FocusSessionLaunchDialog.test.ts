import { createElement, Fragment, type ComponentProps } from "react";
import { environmentManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FocusLaunchError, type FocusLaunchIdentity, type FocusLaunchRequest, type FocusLaunchSource,
  type FocusObject, type FocusSessionLaunch,
} from "../api";
import { queryKeys } from "../queryClient";
import { focusDecision, focusDetails, focusLaunchReceipt, focusTask, FOCUS_TEST_NOW, FOCUS_TEST_NOW_MS } from "../test-focus-fixtures";
import { changeFocusField, clickFocusButton, createFocusTestHarness, focusButton, type FocusTestHarness } from "../test-focus-harness";
import { advanceTimersByTimeAct, findAllByTag, getReactProps, waitTick, waitUntilAct } from "../test-react-harness";
import FocusSessionLaunchDialog, { focusLaunchReady } from "./FocusSessionLaunchDialog";

vi.mock("../telemetry-batcher", () => ({ createTelemetryBatcher: () => ({ enqueue: vi.fn() }) }));

const LAUNCH_PATH = "/api/focus/session-launches";
const identity: FocusLaunchIdentity = { objectId: "decision-1", activationId: "activation-1", source: "launch_prompt" };
const identityKey = (value: FocusLaunchIdentity) => JSON.stringify([value.objectId, value.activationId, value.source]);
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json" },
});
const launchResponse = (receipt: FocusSessionLaunch, status = 200, created = false) => response({
  created, sessionId: receipt.sessionId ?? receipt.expectedSessionId, receipt,
  ...(receipt.error ? { error: receipt.error } : {}),
}, status);

interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: Record<string, unknown> | undefined;
}

function createLaunchServer(getObject: () => FocusObject) {
  const receipts = new Map<string, FocusSessionLaunch>();
  const sessions = new Set<string>();
  const sends: { sessionId: string; prompt: string }[] = [];
  const requests: RecordedRequest[] = [];
  const unexpected: RecordedRequest[] = [];
  let sequence = 0;
  const put = (receipt: FocusSessionLaunch) => {
    receipts.set(identityKey(receipt), receipt);
    if (receipt.sessionId) sessions.add(receipt.sessionId);
    return receipt;
  };
  const prepare = (input: FocusLaunchRequest) => {
    const existing = receipts.get(identityKey(input));
    if (existing) return existing;
    const id = `launch-${++sequence}`;
    const taskId = input.taskId ?? null;
    return put(focusLaunchReceipt({
      ...input, id, expectedSessionId: id, sessionId: null, status: "prepared", promptStatus: "pending",
      taskId, taskTitle: taskId === "task-1" ? "Bridge task" : taskId === "task-2" ? "Destination task" : taskId,
      prompt: input.prompt ?? "", creationOptions: {
        ...(input.model ? { model: input.model } : {}),
        ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
        ...(input.contextTier ? { contextTier: input.contextTier } : {}),
        ...(input.agent ? { agent: input.agent } : {}),
      },
      creationDispatchedAt: null, linkedAt: null, promptDispatchedAt: null, version: 0,
    }));
  };
  const complete = (receipt: FocusSessionLaunch) => {
    if (receipt.status === "ready" || receipt.status === "superseded"
      || receipt.promptStatus === "unknown" || receipt.promptStatus === "sending") return receipt;
    const sessionId = receipt.sessionId ?? receipt.expectedSessionId;
    sessions.add(sessionId);
    if (receipt.promptStatus === "pending") sends.push({ sessionId, prompt: receipt.prompt });
    return put({
      ...receipt, sessionId, status: "ready", promptStatus: "sent", creationDispatchedAt: FOCUS_TEST_NOW,
      linkedAt: FOCUS_TEST_NOW, promptDispatchedAt: FOCUS_TEST_NOW, error: null, errorStage: null, version: receipt.version + 1,
    });
  };
  const read = vi.fn(async (value: FocusLaunchIdentity) => response({ receipt: receipts.get(identityKey(value)) ?? null }));
  const launch = vi.fn(async (input: FocusLaunchRequest) => {
    const existing = receipts.get(identityKey(input));
    if (existing && (existing.prompt !== input.prompt || existing.taskId !== input.taskId)) {
      return response({ error: "This episode/source already has a launch with different prompt, destination or session options" }, 409);
    }
    return launchResponse(complete(prepare(input)), existing ? 200 : 201, !existing);
  });
  const start = vi.fn(async (id: string) => {
    const receipt = [...receipts.values()].find((candidate) => candidate.id === id);
    if (!receipt) return response({ error: "Focus launch receipt not found" }, 404);
    return launchResponse(complete(receipt));
  });
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "https://bridge.test");
    const request: RecordedRequest = {
      method: init?.method ?? "GET", path: url.pathname, query: url.searchParams,
      body: typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined,
    };
    requests.push(request);
    if (request.path === LAUNCH_PATH && request.method === "GET") {
      return read({
        objectId: url.searchParams.get("objectId")!,
        activationId: url.searchParams.get("activationId")!,
        source: url.searchParams.get("source") as FocusLaunchSource,
      });
    }
    if (request.path === LAUNCH_PATH && request.method === "POST") return launch(request.body as unknown as FocusLaunchRequest);
    if (request.path.startsWith(`${LAUNCH_PATH}/`) && request.path.endsWith("/start") && request.method === "POST") {
      if (JSON.stringify(request.body) !== "{}") return response({ error: "Start accepts only an empty body" }, 400);
      return start(decodeURIComponent(request.path.slice(LAUNCH_PATH.length + 1, -"/start".length)));
    }
    const object = getObject();
    if (request.method === "GET" && request.path === `/api/focus/${object.objectType}s/${encodeURIComponent(object.id)}`) {
      return response({ [object.objectType]: object });
    }
    unexpected.push(request);
    throw new Error(`Unexpected request: ${request.method} ${request.path}`);
  });
  return { receipts, sessions, sends, requests, unexpected, put, prepare, complete, read, launch, start, fetch };
}

type DialogProps = ComponentProps<typeof FocusSessionLaunchDialog>;
const callbacks = () => ({
  tasks: [focusTask(), focusTask({ id: "task-2", title: "Destination task" })], taskGroups: [],
  onSelectSession: vi.fn(), onChanged: vi.fn(async () => undefined), onClose: vi.fn(),
});
const buttons = (harness: FocusTestHarness) => findAllByTag(harness.dom.container, "BUTTON").map((button) => button.textContent);

describe("durable Focus session launch dialog", () => {
  let harness: FocusTestHarness;
  let harnesses: FocusTestHarness[];
  let extraClients: QueryClient[];
  let current: FocusObject;
  let server: ReturnType<typeof createLaunchServer>;
  const newHarness = async () => {
    const next = await createFocusTestHarness();
    harnesses.push(next);
    return next;
  };
  const render = async (
    object = current, source: FocusLaunchSource = "launch_prompt",
    props: Omit<DialogProps, "object" | "source"> = callbacks(), target = harness,
  ) => target.render(createElement(FocusSessionLaunchDialog, { object, source, ...props }));
  const hasText = (text: string, target = harness) => waitUntilAct(target.act,
    () => Boolean(target.dom.container.textContent?.includes(text)), { label: text });
  const mutations = () => server.requests.filter((request) => request.method !== "GET");

  beforeEach(async () => {
    current = focusDecision({ launchPrompt: { label: "Launch review", prompt: "Review this concern" } });
    server = createLaunchServer(() => current);
    harnesses = [];
    extraClients = [];
    vi.stubGlobal("fetch", server.fetch);
    // Query's Node detection otherwise suppresses browser refetch intervals in this DOM harness.
    vi.spyOn(environmentManager, "isServer").mockReturnValue(false);
    harness = await newHarness();
    vi.useFakeTimers();
    vi.setSystemTime(FOCUS_TEST_NOW_MS);
  });
  afterEach(async () => {
    for (const target of [...harnesses].reverse()) await target.cleanup();
    for (const client of extraClients) client.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    expect(server.unexpected).toEqual([]);
    expect(server.requests.filter(({ path }) => path.includes("/link-session")
      || /^\/api\/(?:tasks\/[^/]+\/)?sessions(?:\/|$)/.test(path))).toEqual([]);
    expect(mutations().every(({ method, path }) => method === "POST"
      && (path === LAUNCH_PATH || (path.startsWith(`${LAUNCH_PATH}/`) && path.endsWith("/start"))))).toBe(true);
  });

  it.each(["Start session", "Send in background"])("lets the server create, link and send once via %s", async (label) => {
    const navigation = callbacks();
    await render(current, "launch_prompt", navigation);
    expect(server.read).toHaveBeenCalledWith(identity);
    expect(mutations()).toEqual([]);
    const dialog = findAllByTag(harness.dom.container, "DIV").find((node) => getReactProps(node)?.role === "dialog");
    expect(getReactProps(dialog)).toMatchObject({ "aria-modal": true, "aria-labelledby": expect.any(String) });
    await changeFocusField(harness, "Prompt to send", "  Inspect the health check and report back  ");
    await clickFocusButton(harness, label);
    await hasText("Session ready");
    expect(server.launch).toHaveBeenCalledExactlyOnceWith({
      ...identity, taskId: "task-1", prompt: "Inspect the health check and report back",
    });
    expect(server.sessions.size).toBe(1);
    expect(server.sends).toEqual([{ sessionId: "launch-1", prompt: "Inspect the health check and report back" }]);
    expect(server.start).not.toHaveBeenCalled();
    expect(navigation.onChanged).toHaveBeenCalledOnce();
    expect(harness.dom.container.textContent).toContain("Session launch records acknowledgement, not an Action handoff or resolution");
    if (label === "Start session") {
      expect(navigation.onSelectSession).toHaveBeenCalledExactlyOnceWith("launch-1", "task-1");
      expect(navigation.onClose).toHaveBeenCalledOnce();
    } else {
      expect(navigation.onSelectSession).not.toHaveBeenCalled();
      expect(navigation.onClose).not.toHaveBeenCalled();
      await clickFocusButton(harness, "Open existing session");
      expect(navigation.onSelectSession).toHaveBeenCalledExactlyOnceWith("launch-1", "task-1");
    }
  });

  it("recovers after a full reload with a new harness and QueryClient, even after the source closes", async () => {
    await render();
    await clickFocusButton(harness, "Send in background");
    await hasText("Session ready");
    const previousClient = harness.queryClient;
    const receipt = server.receipts.get(identityKey(identity))!;
    await harness.cleanup();
    current = focusDecision({
      lifecycle: "resolved", status: "done", taskState: "archived", launchPrompt: null,
      details: focusDetails({ lifecycle: "resolved", contentFingerprint: "later-content" }),
    });
    const readsBeforeReload = server.read.mock.calls.length;
    const objectReads = server.requests.filter(({ path }) => path === "/api/focus/decisions/decision-1").length;
    harness = await newHarness();
    const navigation = callbacks();
    await render(current, "launch_prompt", navigation);
    await hasText("Session ready");
    expect(harness.queryClient).not.toBe(previousClient);
    expect(server.read.mock.calls.length).toBeGreaterThan(readsBeforeReload);
    expect(server.read.mock.calls.at(-1)).toEqual([identity]);
    expect(server.requests.filter(({ path }) => path === "/api/focus/decisions/decision-1")).toHaveLength(objectReads);
    expect(harness.dom.container.textContent).toContain(receipt.prompt);
    expect(findAllByTag(harness.dom.container, "TEXTAREA")).toHaveLength(0);
    await clickFocusButton(harness, "Open existing session");
    expect(navigation.onSelectSession).toHaveBeenCalledExactlyOnceWith(receipt.sessionId, "task-1");
    expect(server.launch).toHaveBeenCalledOnce();
    expect(server.start).not.toHaveBeenCalled();
    expect(server.sessions.size).toBe(1);
    expect(server.sends).toHaveLength(1);
  });

  it("allows concurrent clients to POST the same identity while the server creates and sends only once", async () => {
    const first = callbacks();
    const second = callbacks();
    const otherClient = new QueryClient({ defaultOptions: harness.queryClient.getDefaultOptions() });
    extraClients.push(otherClient);
    await harness.render(createElement(Fragment, null,
      createElement("div", { "data-client": "first" },
        createElement(FocusSessionLaunchDialog, { object: current, source: "launch_prompt", ...first })),
      createElement(QueryClientProvider, { client: otherClient },
        createElement("div", { "data-client": "second" },
          createElement(FocusSessionLaunchDialog, { object: current, source: "launch_prompt", ...second }))),
    ));
    expect(harness.queryClient).not.toBe(otherClient);
    const clients = findAllByTag(harness.dom.container, "DIV").filter((node) => getReactProps(node)?.["data-client"]);
    let release!: () => void;
    const bothSubmitted = new Promise<void>((resolve) => { release = resolve; });
    const dispatch = server.launch.getMockImplementation()!;
    server.launch.mockImplementation(async (input) => { await bothSubmitted; return dispatch(input); });
    await harness.act(async () => {
      getReactProps(focusButton(clients[0], "Start session"))?.onClick?.();
      getReactProps(focusButton(clients[1], "Start session"))?.onClick?.();
      await waitTick();
    });
    await waitUntilAct(harness.act, () => server.launch.mock.calls.length === 2);
    await harness.act(async () => { release(); await waitTick(); });
    await advanceTimersByTimeAct(harness.act, 1);
    await waitUntilAct(harness.act, () => first.onSelectSession.mock.calls.length === 1 && second.onSelectSession.mock.calls.length === 1);
    expect(server.launch.mock.calls).toEqual([
      [{ ...identity, taskId: "task-1", prompt: "Review this concern" }],
      [{ ...identity, taskId: "task-1", prompt: "Review this concern" }],
    ]);
    expect(server.receipts.size).toBe(1);
    expect(server.sessions.size).toBe(1);
    expect(server.sends).toEqual([{ sessionId: "launch-1", prompt: "Review this concern" }]);
    expect(first.onSelectSession).toHaveBeenCalledWith("launch-1", "task-1");
    expect(second.onSelectSession).toHaveBeenCalledWith("launch-1", "task-1");
  });

  it.each(["creating", "created"] as const)("treats HTTP 202 %s as pending and polls GET until the receipt is ready", async (status) => {
    server.launch.mockImplementation(async (input) => {
      const prepared = server.prepare(input);
      const pending = server.put({
        ...prepared, status, sessionId: status === "created" ? prepared.expectedSessionId : null,
        creationDispatchedAt: FOCUS_TEST_NOW, version: 1,
      });
      return launchResponse(pending, 202, true);
    });
    const navigation = callbacks();
    await render(current, "launch_prompt", navigation);
    await clickFocusButton(harness, "Start session");
    await hasText(status === "created" ? "Session created; launch not yet ready" : "Session creation pending");
    expect(navigation.onSelectSession).not.toHaveBeenCalled();
    const pending = server.receipts.get(identityKey(identity))!;
    if (status === "creating") {
      expect(harness.dom.container.textContent).toContain(`Expected session ID (not yet confirmed): ${pending.expectedSessionId}`);
      expect(buttons(harness)).not.toContain("Open existing session");
    }
    const readsBeforePoll = server.read.mock.calls.length;
    server.complete(pending);
    await advanceTimersByTimeAct(harness.act, 2_001);
    await waitUntilAct(harness.act, () => navigation.onSelectSession.mock.calls.length === 1);
    expect(server.read.mock.calls.length).toBeGreaterThan(readsBeforePoll);
    expect(server.read.mock.calls.at(-1)).toEqual([identity]);
    expect(navigation.onSelectSession).toHaveBeenCalledExactlyOnceWith(pending.expectedSessionId, "task-1");
    expect(server.launch).toHaveBeenCalledOnce();
    expect(server.start).not.toHaveBeenCalled();
    const readyReads = server.read.mock.calls.length;
    await advanceTimersByTimeAct(harness.act, 6_000);
    expect(server.read).toHaveBeenCalledTimes(readyReads);
    expect(server.sends).toHaveLength(1);
  });

  it.each(["prepared", "creating", "created", "failed", "unknown"] as const)(
    "resumes a saved %s receipt only with POST /:id/start {} and preserves its frozen approval",
    async (status) => {
      const confirmed = status === "created" || status === "failed";
      const receipt = server.put(focusLaunchReceipt({
        id: "retained/receipt", expectedSessionId: "retained/receipt", status,
        sessionId: confirmed ? "retained/receipt" : null, promptStatus: "pending", linkedAt: null,
        creationDispatchedAt: status === "prepared" ? null : FOCUS_TEST_NOW, promptDispatchedAt: null,
        prompt: "The previously approved prompt", taskId: "task-2", taskTitle: "Frozen destination",
        creationOptions: { model: "approved-model", reasoningEffort: "high", contextTier: "long_context", agent: "reviewer" },
        error: status === "failed" || status === "unknown" ? "Prior attempt needs reconciliation" : null,
        errorStage: status === "failed" ? "link" : status === "unknown" ? "creation" : null,
      }));
      if (status === "creating" || status === "unknown") server.sessions.add(receipt.expectedSessionId);
      current = focusDecision({
        launchPrompt: { prompt: "A later prompt must not replace approval", taskId: null },
        details: focusDetails({ contentFingerprint: "new-fingerprint" }),
      });
      const navigation = callbacks();
      await render(current, "launch_prompt", navigation);
      expect(harness.dom.container.textContent).toContain("The previously approved prompt");
      expect(harness.dom.container.textContent).toContain("Frozen destination: Frozen destination");
      expect(harness.dom.container.textContent).toContain("model: approved-model; reasoningEffort: high; contextTier: long_context; agent: reviewer");
      expect(findAllByTag(harness.dom.container, "SELECT")).toHaveLength(0);
      expect(findAllByTag(harness.dom.container, "TEXTAREA")).toHaveLength(0);
      await clickFocusButton(harness, "Resume / reconcile existing launch");
      await hasText("Session ready");
      expect(server.launch).not.toHaveBeenCalled();
      expect(server.start).toHaveBeenCalledExactlyOnceWith(receipt.id);
      expect(mutations()).toEqual([expect.objectContaining({
        method: "POST", path: `${LAUNCH_PATH}/retained%2Freceipt/start`, body: {},
      })]);
      expect(server.requests.some(({ path }) => path === "/api/focus/decisions/decision-1")).toBe(false);
      expect(navigation.onSelectSession).toHaveBeenCalledExactlyOnceWith(receipt.expectedSessionId, "task-2");
      expect(server.sessions.size).toBe(1);
      expect(server.sends).toEqual([{ sessionId: receipt.expectedSessionId, prompt: receipt.prompt }]);
      expect(server.receipts.get(identityKey(identity))?.creationOptions).toEqual(receipt.creationOptions);
    },
  );

  it.each(["unknown", "sending"] as const)("never replays an initial prompt whose delivery is %s", async (promptStatus) => {
    const receipt = server.put(focusLaunchReceipt({
      status: promptStatus === "unknown" ? "unknown" : "created", promptStatus,
      errorStage: "prompt", error: "Delivery is unconfirmed",
    }));
    const navigation = callbacks();
    await render(current, "launch_prompt", navigation);
    await hasText("resending is not offered");
    expect(buttons(harness)).not.toContain("Resume / reconcile existing launch");
    expect(buttons(harness)).not.toContain("Start session");
    const reads = server.read.mock.calls.length;
    await clickFocusButton(harness, "Check launch status");
    expect(server.read.mock.calls.length).toBeGreaterThan(reads);
    await clickFocusButton(harness, "Open existing session");
    expect(navigation.onSelectSession).toHaveBeenCalledExactlyOnceWith(receipt.sessionId, "task-1");
    expect(mutations()).toEqual([]);
    expect(server.sends).toEqual([]);
  });

  it.each([null, "receipt-1"])("keeps a superseded receipt read-only with confirmed session %s", async (sessionId) => {
    server.put(focusLaunchReceipt({ status: "superseded", sessionId, promptStatus: "pending", linkedAt: null }));
    await render();
    await hasText("Launch episode superseded or closed");
    expect(findAllByTag(harness.dom.container, "TEXTAREA")).toHaveLength(0);
    expect(buttons(harness)).not.toContain("Resume / reconcile existing launch");
    expect(buttons(harness)).not.toContain("Start session");
    expect(buttons(harness).includes("Open existing session")).toBe(sessionId !== null);
    await clickFocusButton(harness, "Check launch status");
    expect(mutations()).toEqual([]);
  });

  it.each([
    { code: 409, status: "unknown" as const, errorStage: "creation" as const, confirmed: false },
    { code: 502, status: "failed" as const, errorStage: "link" as const, confirmed: true },
  ])("retains a receipt-bearing HTTP $code and reconciles the same session instead of creating again", async ({ code, status, errorStage, confirmed }) => {
    server.launch.mockImplementation(async (input) => {
      const prepared = server.prepare(input);
      server.sessions.add(prepared.expectedSessionId);
      return launchResponse(server.put({
        ...prepared, status, errorStage, error: "The durable launch needs recovery",
        sessionId: confirmed ? prepared.expectedSessionId : null, creationDispatchedAt: FOCUS_TEST_NOW, version: 2,
      }), code, true);
    });
    const navigation = callbacks();
    await render(current, "launch_prompt", navigation);
    await clickFocusButton(harness, "Start session");
    await hasText("The durable launch needs recovery");
    const receipt = server.receipts.get(identityKey(identity))!;
    const mutationError = harness.queryClient.getMutationCache().getAll()[0]?.state.error;
    expect(mutationError).toBeInstanceOf(FocusLaunchError);
    expect(mutationError).toMatchObject({ status: code, receipt });
    expect(harness.queryClient.getQueryData(queryKeys.focusLaunchReceipt(identity))).toEqual(receipt);
    expect(harness.queryClient.getQueryData(queryKeys.focusLaunchReceiptById(receipt.id))).toEqual(receipt);
    expect(navigation.onSelectSession).not.toHaveBeenCalled();
    expect(server.sends).toEqual([]);
    await clickFocusButton(harness, "Resume / reconcile existing launch");
    await hasText("Session ready");
    expect(server.launch).toHaveBeenCalledOnce();
    expect(server.start).toHaveBeenCalledExactlyOnceWith(receipt.id);
    expect(server.sessions.size).toBe(1);
    expect(server.sends).toEqual([{ sessionId: receipt.expectedSessionId, prompt: receipt.prompt }]);
    expect(navigation.onSelectSession).toHaveBeenCalledExactlyOnceWith(receipt.expectedSessionId, "task-1");
  });

  it("recovers a conflicting new-intent 409 without overwriting another client's frozen receipt or sending twice", async () => {
    server.launch.mockImplementation(async (input) => {
      server.complete(server.prepare({
        ...input, prompt: "Another client's approved prompt", taskId: "task-2",
        model: "frozen-model", reasoningEffort: "high", contextTier: "long_context", agent: "approved-agent",
      }));
      return response({ error: "This episode/source already has a launch with different prompt, destination or session options" }, 409);
    });
    const navigation = callbacks();
    await render(current, "launch_prompt", navigation);
    await changeFocusField(harness, "Prompt to send", "My unsubmitted edits");
    await clickFocusButton(harness, "Start session");
    await hasText("Another client's approved prompt");
    expect(harness.dom.container.textContent).toContain("Frozen destination: Destination task");
    expect(harness.dom.container.textContent).toContain("model: frozen-model");
    expect(harness.dom.container.textContent).not.toContain("My unsubmitted edits");
    expect(findAllByTag(harness.dom.container, "TEXTAREA")).toHaveLength(0);
    const postIndex = server.requests.findIndex(({ method }) => method === "POST");
    expect(server.requests.slice(postIndex + 1).some(({ method, path }) => method === "GET" && path === LAUNCH_PATH)).toBe(true);
    expect(navigation.onSelectSession).not.toHaveBeenCalled();
    await clickFocusButton(harness, "Open existing session");
    expect(navigation.onSelectSession).toHaveBeenCalledExactlyOnceWith("launch-1", "task-2");
    expect(server.launch).toHaveBeenCalledOnce();
    expect(server.start).not.toHaveBeenCalled();
    expect(server.sessions.size).toBe(1);
    expect(server.sends).toEqual([{ sessionId: "launch-1", prompt: "Another client's approved prompt" }]);
  });

  it("detects a competing frozen receipt during preflight before submitting edits", async () => {
    await render();
    await changeFocusField(harness, "Prompt to send", "My edited prompt");
    server.put(focusLaunchReceipt({
      status: "prepared", prompt: "Approved elsewhere", taskId: null, taskTitle: null,
      sessionId: null, promptStatus: "pending", linkedAt: null, creationDispatchedAt: null, promptDispatchedAt: null,
    }));
    await clickFocusButton(harness, "Start session");
    await hasText("Your edits were not submitted");
    expect(harness.dom.container.textContent).toContain("Approved elsewhere");
    expect(harness.dom.container.textContent).toContain("Standalone / Global sessions");
    expect(mutations()).toEqual([]);
  });

  it.each(["network failure", "502 without receipt", "unverifiable success"])(
    "GETs the durable identity after %s and never falls back to ordinary creation",
    async (failure) => {
      server.launch.mockImplementation(async (input) => {
        server.complete(server.prepare(input));
        if (failure === "network failure") throw new TypeError("Connection lost after dispatch");
        return failure === "502 without receipt" ? response({ error: "Gateway lost the response" }, 502)
          : response({ sessionId: "unverified-top-level-session" }, 201);
      });
      const navigation = callbacks();
      await render(current, "launch_prompt", navigation);
      await clickFocusButton(harness, "Start session");
      await hasText("Session ready");
      const postIndex = server.requests.findIndex(({ method }) => method === "POST");
      const recoveryReads = server.requests.slice(postIndex + 1).filter(({ method, path }) => method === "GET" && path === LAUNCH_PATH);
      expect(recoveryReads.length).toBeGreaterThan(0);
      expect(recoveryReads.every(({ query }) => Object.entries(identity).every(([key, value]) => query.get(key) === value))).toBe(true);
      expect(navigation.onSelectSession).not.toHaveBeenCalled();
      await clickFocusButton(harness, "Open existing session");
      expect(navigation.onSelectSession).toHaveBeenCalledExactlyOnceWith("launch-1", "task-1");
      expect(server.launch).toHaveBeenCalledOnce();
      expect(server.start).not.toHaveBeenCalled();
      expect(server.sessions.size).toBe(1);
      expect(server.sends).toHaveLength(1);
    },
  );

  it("blocks creation while ambiguous dispatch recovery is unavailable, then recovers with GET only", async () => {
    const read = server.read.getMockImplementation()!;
    server.launch.mockImplementation(async (input) => {
      server.complete(server.prepare(input));
      server.read.mockImplementation(async () => response({ error: "Receipt store is offline" }, 503));
      throw new TypeError("Connection lost after dispatch");
    });
    await render();
    await clickFocusButton(harness, "Start session");
    await hasText("No ordinary-session fallback will run");
    expect(buttons(harness)).toContain("Recover launch receipt");
    expect(buttons(harness)).not.toContain("Start session");
    expect(buttons(harness)).not.toContain("Send in background");
    server.read.mockImplementation(read);
    await clickFocusButton(harness, "Recover launch receipt");
    await hasText("Session ready");
    expect(server.launch).toHaveBeenCalledOnce();
    expect(server.start).not.toHaveBeenCalled();
    expect(server.sessions.size).toBe(1);
    expect(server.sends).toHaveLength(1);
  });

  it("fails closed on an unavailable initial lookup and offers read-only receipt recovery", async () => {
    server.read.mockResolvedValueOnce(response({ error: "Receipt lookup unavailable" }, 503));
    await render();
    await hasText("Receipt lookup unavailable");
    expect(buttons(harness)).not.toContain("Start session");
    expect(findAllByTag(harness.dom.container, "TEXTAREA")).toHaveLength(0);
    expect(mutations()).toEqual([]);
    await clickFocusButton(harness, "Recover launch receipt");
    await hasText("Prompt to send");
    expect(mutations()).toEqual([]);
  });

  it.each([null, "task-2"])("honors an explicit launch-prompt destination %s even when the source task is archived", async (taskId) => {
    current = focusDecision({ taskState: "archived", launchPrompt: { prompt: "Approved destination", taskId } });
    const navigation = callbacks();
    navigation.tasks[0] = focusTask({ status: "archived" });
    await render(current, "launch_prompt", navigation);
    expect(getReactProps(findAllByTag(harness.dom.container, "SELECT")[0])?.value).toBe(taskId ?? "__global__");
    expect(getReactProps(focusButton(harness.dom.container, "Start session"))?.disabled).toBe(false);
    await clickFocusButton(harness, "Start session");
    await hasText("Session ready");
    expect(server.launch).toHaveBeenCalledExactlyOnceWith({ ...identity, taskId, prompt: "Approved destination" });
    expect(navigation.onSelectSession).toHaveBeenCalledExactlyOnceWith("launch-1", taskId ?? undefined);
    expect(current.taskId).toBe("task-1");
  });

  it.each(["archived", "muted", "orphaned"] as const)("requires an explicit visible destination for a %s source", async (taskState) => {
    current = focusDecision({
      taskState, taskId: taskState === "orphaned" ? null : "task-1",
      launchPrompt: { prompt: "Review this concern" },
    });
    const navigation = callbacks();
    navigation.tasks = [
      focusTask({ status: "archived" }), focusTask({ id: "muted-task", title: "Muted task", muted: true }),
      focusTask({ id: "task-2", title: "Destination task" }),
    ];
    await render(current, "launch_prompt", navigation);
    const select = findAllByTag(harness.dom.container, "SELECT")[0];
    expect(getReactProps(select)?.value).toBe("");
    expect(select.textContent).not.toContain("Bridge task");
    expect(select.textContent).not.toContain("Muted task");
    expect(getReactProps(focusButton(harness.dom.container, "Start session"))?.disabled).toBe(true);
    expect(getReactProps(focusButton(harness.dom.container, "Send in background"))?.disabled).toBe(true);
    expect(mutations()).toEqual([]);
    await changeFocusField(harness, "Session destination", "__global__");
    await clickFocusButton(harness, "Send in background");
    await hasText("Session ready");
    expect(server.launch).toHaveBeenCalledExactlyOnceWith({ ...identity, taskId: null, prompt: "Review this concern" });
  });

  it("does not accept a hidden override or blank prompt as a visible launch destination and approval", async () => {
    current = focusDecision({ launchPrompt: { prompt: "Review", taskId: "muted-task" } });
    const navigation = callbacks();
    navigation.tasks.push(focusTask({ id: "muted-task", title: "Muted destination", muted: true }));
    await render(current, "launch_prompt", navigation);
    expect(getReactProps(focusButton(harness.dom.container, "Start session"))?.disabled).toBe(true);
    await changeFocusField(harness, "Session destination", "task-2");
    await changeFocusField(harness, "Prompt to send", "   ");
    expect(getReactProps(focusButton(harness.dom.container, "Start session"))?.disabled).toBe(true);
    expect(getReactProps(focusButton(harness.dom.container, "Send in background"))?.disabled).toBe(true);
    expect(mutations()).toEqual([]);
  });

  it("keeps discussion and launch-prompt identities separate and includes source context without reusing the launch session", async () => {
    current = focusDecision({ launchPrompt: { prompt: "Launch approval", taskId: null }, lifecycle: "handed_off" });
    await render();
    expect(harness.dom.container.textContent).toContain("Launching records acknowledgement, not an Action handoff or resolution");
    await clickFocusButton(harness, "Send in background");
    await hasText("Session ready");
    expect(harness.dom.container.textContent).toContain("The existing handoff belongs to previously accepted Action work");
    expect(current.lifecycle).toBe("handed_off");
    expect(server.requests.some((request) => request.method === "PATCH")).toBe(false);
    const launchReceipt = server.receipts.get(identityKey(identity))!;
    await harness.render(null);
    current = { ...current, sessionId: launchReceipt.sessionId };
    const navigation = callbacks();
    await render(current, "discussion", navigation);
    expect(getReactProps(findAllByTag(harness.dom.container, "SELECT")[0])?.value).toBe("task-1");
    expect(harness.dom.container.textContent).toContain("Lifecycle: handed_off (acknowledgement and handoff are not resolution)");
    expect(harness.dom.container.textContent).toContain("Consequence of waiting");
    expect(harness.dom.container.textContent).toContain("Evidence URL");
    expect(harness.dom.container.textContent).toContain("Episode: activation-1");
    await changeFocusField(harness, "Message to send", "What remains unverified?");
    await clickFocusButton(harness, "Start session");
    await hasText("Session ready");
    const discussionIdentity: FocusLaunchIdentity = { ...identity, source: "discussion" };
    const discussion = server.receipts.get(identityKey(discussionIdentity))!;
    expect(server.read).toHaveBeenCalledWith(discussionIdentity);
    expect(discussion.id).not.toBe(launchReceipt.id);
    expect(discussion.prompt).toContain("# My message\nWhat remains unverified?");
    expect(discussion.prompt).toContain("Related session ID: launch-1");
    expect(navigation.onSelectSession).toHaveBeenCalledExactlyOnceWith(discussion.sessionId, "task-1");
    expect(server.receipts.size).toBe(2);
    expect(server.sessions.size).toBe(2);
    expect(server.sends).toHaveLength(2);
  });

  it.each(["resolved", "accepted_risk", "dismissed"] as const)("allows inspection of %s context but never starts or reactivates a closed episode", async (lifecycle) => {
    current = focusDecision({
      lifecycle, status: lifecycle === "dismissed" ? "dismissed" : "done",
      details: focusDetails({ lifecycle, resolutionReason: "Retained reason", outcome: "Recorded outcome" }),
    });
    await render(current, "discussion");
    expect(harness.dom.container.textContent).toContain(`Lifecycle: ${lifecycle}`);
    expect(harness.dom.container.textContent).toContain("Retained reason");
    expect(harness.dom.container.textContent).toContain("Recorded outcome");
    expect(harness.dom.container.textContent).toContain("It was not reactivated");
    expect(getReactProps(focusButton(harness.dom.container, "Start session"))?.disabled).toBe(true);
    expect(getReactProps(focusButton(harness.dom.container, "Send in background"))?.disabled).toBe(true);
    expect(mutations()).toEqual([]);
  });

  it("revalidates closure immediately before a new launch instead of resolving or reactivating the source", async () => {
    await render();
    current = { ...current, lifecycle: "resolved", status: "done" };
    await clickFocusButton(harness, "Start session");
    await hasText("This episode is no longer open");
    expect(mutations()).toEqual([]);
  });

  it("requires renewed approval of changed content within the same activation", async () => {
    await render();
    current = focusDecision({
      launchPrompt: { prompt: "Changed recommendation" },
      details: focusDetails({ contentFingerprint: "fingerprint-2" }),
    });
    await clickFocusButton(harness, "Start session");
    await hasText("This item or episode changed");
    expect(mutations()).toEqual([]);
    await clickFocusButton(harness, "Reload item");
    expect(getReactProps(findAllByTag(harness.dom.container, "TEXTAREA")[0])?.value).toBe("Changed recommendation");
    expect(mutations()).toEqual([]);
    await clickFocusButton(harness, "Start session");
    await hasText("Session ready");
    expect(server.launch).toHaveBeenCalledExactlyOnceWith({ ...identity, taskId: "task-1", prompt: "Changed recommendation" });
  });

  it("never retargets stale approval or receipt recovery to a newer activation", async () => {
    await render();
    current = focusDecision({
      activationId: "activation-2", launchPrompt: { prompt: "Different episode" },
      details: focusDetails({ contentFingerprint: "fingerprint-2" }),
    });
    await clickFocusButton(harness, "Start session");
    await hasText("This item or episode changed");
    await clickFocusButton(harness, "Reload item");
    await hasText("the old launch identity will not be retargeted");
    expect(server.read.mock.calls.every(([value]) => identityKey(value) === identityKey(identity))).toBe(true);
    expect(mutations()).toEqual([]);
  });

  it.each([
    { objectId: "another-object" }, { activationId: "another-episode" }, { source: "discussion" as const },
  ])("refuses navigation or mutation for a receipt with a mismatched identity %j", async (mismatch) => {
    server.read.mockImplementation(async () => response({ receipt: focusLaunchReceipt({ ...mismatch, status: "created", promptStatus: "pending" }) }));
    await render();
    await hasText("Receipt identity does not match this episode");
    expect(buttons(harness)).not.toContain("Open existing session");
    expect(buttons(harness)).not.toContain("Resume / reconcile existing launch");
    expect(mutations()).toEqual([]);
  });
});

describe("Focus launch readiness", () => {
  it("requires the confirmed session, successful linking and confirmed prompt delivery, not just ready status", () => {
    expect(focusLaunchReady(focusLaunchReceipt())).toBe(true);
    for (const incomplete of [
      { sessionId: null }, { linkedAt: null }, { status: "created" as const },
      { promptStatus: "pending" as const }, { promptStatus: "sending" as const }, { promptStatus: "unknown" as const },
    ]) expect(focusLaunchReady(focusLaunchReceipt(incomplete))).toBe(false);
  });
});
