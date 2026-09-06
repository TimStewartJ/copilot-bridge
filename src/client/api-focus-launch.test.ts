import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FocusLaunchIdentity, FocusLaunchRequest, FocusLaunchResult, FocusSessionLaunch } from "./api";
import { FOCUS_TEST_NOW, FOCUS_TEST_NOW_MS, focusLaunchReceipt } from "./test-focus-fixtures";

type RecordedRequest = { url: string; method: string; body?: unknown };
let api: typeof import("./api");

const identity: FocusLaunchIdentity = {
  objectId: "decision-1", activationId: "activation-1", source: "launch_prompt",
};
const unverifiedMessage = "Focus launch response could not be verified. Recover the episode receipt before retrying.";

function mockResponses(...responses: Response[]): RecordedRequest[] {
  const requests: RecordedRequest[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/telemetry/batch")) return Response.json({});
    requests.push({
      url, method: init?.method ?? "GET",
      ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}),
    });
    const response = responses.shift();
    if (!response) throw new Error(`Unexpected request: ${url}`);
    return response;
  }));
  return requests;
}

function launchResult(receipt = focusLaunchReceipt(), created = false): FocusLaunchResult {
  return {
    created, sessionId: receipt.sessionId ?? receipt.expectedSessionId, receipt,
    ...(receipt.error ? { error: receipt.error } : {}),
  };
}

function preparedReceipt(overrides: Partial<FocusSessionLaunch> = {}): FocusSessionLaunch {
  return focusLaunchReceipt({
    status: "prepared", sessionId: null, promptStatus: "pending", creationDispatchedAt: null,
    linkedAt: null, promptDispatchedAt: null, version: 0, ...overrides,
  });
}

async function expectApiError(result: Promise<unknown>, status: number, message = unverifiedMessage) {
  const error = await result.then(() => undefined, (failure: unknown) => failure);
  expect(error).toBeInstanceOf(api.ApiError);
  expect(error).not.toBeInstanceOf(api.FocusLaunchError);
  expect(error).toMatchObject({ name: "ApiError", status, message });
  expect(error).not.toHaveProperty("receipt");
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(FOCUS_TEST_NOW_MS);
  vi.stubEnv("BASE_URL", "/");
  mockResponses();
  api = await import("./api");
});

afterEach(async () => {
  try {
    await vi.runOnlyPendingTimersAsync();
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
  }
});

describe("durable Focus launch reads", () => {
  it.each(["launch_prompt", "discussion"] as const)("looks up the exact %s identity without creating or sending work", async (source) => {
    const lookup = { objectId: "decision /?#", activationId: "episode /?#", source };
    const receipt = focusLaunchReceipt({ ...lookup, creationOptions: { model: "gpt-5.4", contextTier: "long_context" } });
    const requests = mockResponses(Response.json({ receipt }));
    await expect(api.fetchFocusLaunchReceipt(lookup)).resolves.toEqual(receipt);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(requests).toEqual([{
      method: "GET",
      url: `/api/focus/session-launches?objectId=decision+%2F%3F%23&activationId=episode+%2F%3F%23&source=${source}`,
    }]);
  });

  it("returns a missing receipt as null without preparing a replacement", async () => {
    const requests = mockResponses(Response.json({ receipt: null }));
    await expect(api.fetchFocusLaunchReceipt(identity)).resolves.toBeNull();
    expect(requests).toEqual([{
      method: "GET", url: "/api/focus/session-launches?objectId=decision-1&activationId=activation-1&source=launch_prompt",
    }]);
  });

  it("lists both sources for one episode and reads an encoded receipt ID", async () => {
    const objectId = "decision /?#";
    const activationId = "episode /?#";
    const receipts = [
      focusLaunchReceipt({ objectId, activationId }),
      focusLaunchReceipt({
        id: "discussion /?#", objectId, activationId, source: "discussion",
        expectedSessionId: "discussion /?#", sessionId: "discussion /?#",
      }),
    ];
    const requests = mockResponses(Response.json({ receipts }), Response.json({ receipt: receipts[1] }), Response.json({ receipts: [] }));
    await expect(api.fetchFocusLaunchReceipts(objectId, activationId)).resolves.toEqual(receipts);
    await expect(api.fetchFocusLaunchReceiptById("discussion /?#")).resolves.toEqual(receipts[1]);
    await expect(api.fetchFocusLaunchReceipts(objectId, "new-episode")).resolves.toEqual([]);
    expect(requests).toEqual([
      { method: "GET", url: "/api/focus/session-launches?objectId=decision+%2F%3F%23&activationId=episode+%2F%3F%23" },
      { method: "GET", url: "/api/focus/session-launches/discussion%20%2F%3F%23" },
      { method: "GET", url: "/api/focus/session-launches?objectId=decision+%2F%3F%23&activationId=new-episode" },
    ]);
  });

  it("does not replace a missing receipt-ID read with session creation", async () => {
    const requests = mockResponses(Response.json({ error: "Focus launch receipt not found" }, { status: 404 }));
    await expectApiError(api.fetchFocusLaunchReceiptById("missing /?#"), 404, "Focus launch receipt not found");
    expect(requests).toEqual([{ method: "GET", url: "/api/focus/session-launches/missing%20%2F%3F%23" }]);
  });
});

describe("server-owned Focus launch mutations", () => {
  it.each([
    { source: "launch_prompt", taskId: "destination-task" },
    { source: "discussion", taskId: null },
  ] as const)("sends a flat $source intent with explicit taskId=$taskId and session options", async ({ source, taskId }) => {
    const input: FocusLaunchRequest = {
      ...identity, source, taskId, prompt: "Review this evidence without changing production.",
      model: "gpt-5.4", reasoningEffort: "high", contextTier: "long_context", agent: "release-reviewer",
    };
    Object.freeze(input);
    const receipt = focusLaunchReceipt({
      source, taskId, taskTitle: taskId === null ? null : "Destination task", prompt: input.prompt,
      creationOptions: {
        model: input.model, reasoningEffort: input.reasoningEffort, contextTier: input.contextTier, agent: input.agent,
      },
    });
    const result = launchResult(receipt, true);
    const requests = mockResponses(Response.json(result, { status: 201 }));
    await expect(api.launchFocusSession(input)).resolves.toEqual(result);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(requests).toEqual([{ method: "POST", url: "/api/focus/session-launches", body: input }]);
    expect(vi.mocked(fetch).mock.calls[0]?.[1]?.headers).toEqual({ "Content-Type": "application/json" });
    expect(requests[0]?.body).not.toHaveProperty("focusLaunch");
    expect(requests[0]?.body).not.toHaveProperty("creationOptions");
  });

  it("leaves omitted choices to the server and returns its frozen intent without a separate prompt send", async () => {
    const receipt = focusLaunchReceipt({
      taskId: null, taskTitle: null, prompt: "The server supplied this saved launch prompt.",
      creationOptions: { model: "gpt-5.4", reasoningEffort: "medium" },
    });
    const result = launchResult(receipt, true);
    const requests = mockResponses(Response.json(result, { status: 201 }));
    await expect(api.launchFocusSession(identity)).resolves.toEqual(result);
    expect(requests).toEqual([{ method: "POST", url: "/api/focus/session-launches", body: identity }]);
    expect(requests[0]?.body).not.toHaveProperty("taskId");
    expect(requests[0]?.body).not.toHaveProperty("prompt");
    expect(requests[0]?.body).not.toHaveProperty("model");
  });

  it("prepares without starting work, then starts only the encoded persisted receipt with an empty body", async () => {
    const receipt = preparedReceipt({ id: "receipt /?#", expectedSessionId: "receipt /?#" });
    const prepared = launchResult(receipt, true);
    const ready = launchResult(focusLaunchReceipt({
      id: receipt.id, expectedSessionId: receipt.expectedSessionId, sessionId: receipt.expectedSessionId, version: 6,
    }));
    const requests = mockResponses(Response.json(prepared, { status: 201 }), Response.json(ready));
    await expect(api.prepareFocusSessionLaunch(identity)).resolves.toEqual(prepared);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(requests).toEqual([{ method: "POST", url: "/api/focus/session-launches/prepare", body: identity }]);
    expect(prepared.receipt.sessionId).toBeNull();
    expect(prepared.receipt.promptStatus).toBe("pending");

    await expect(api.startFocusSessionLaunch(receipt.id)).resolves.toEqual(ready);
    expect(requests).toEqual([
      { method: "POST", url: "/api/focus/session-launches/prepare", body: identity },
      { method: "POST", url: "/api/focus/session-launches/receipt%20%2F%3F%23/start", body: {} },
    ]);
  });

  it.each(["creating", "created"] as const)("keeps a 202 %s receipt non-ready even when the envelope contains a session ID", async (status) => {
    const receipt = preparedReceipt({
      status, sessionId: status === "creating" ? null : "receipt-1",
      creationDispatchedAt: FOCUS_TEST_NOW, version: status === "creating" ? 2 : 3,
    });
    const result = launchResult(receipt);
    const requests = mockResponses(Response.json(result, { status: 202 }));
    const received = await api.startFocusSessionLaunch(receipt.id);
    expect(received).toEqual(result);
    expect(received.sessionId).toBe(receipt.expectedSessionId);
    expect(received.receipt.status).toBe(status);
    expect(received.receipt.sessionId).toBe(status === "creating" ? null : receipt.expectedSessionId);
    expect(received.receipt.promptStatus).toBe("pending");
    expect(received.receipt.linkedAt).toBeNull();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(requests).toEqual([{ method: "POST", url: "/api/focus/session-launches/receipt-1/start", body: {} }]);
  });

  it("preserves the server's existing ready receipt on an explicit replay without ordinary session or send endpoints", async () => {
    const receipt = focusLaunchReceipt();
    const requests = mockResponses(Response.json(launchResult(receipt, true), { status: 201 }), Response.json(launchResult(receipt)));
    await expect(api.launchFocusSession(identity)).resolves.toEqual(launchResult(receipt, true));
    await expect(api.launchFocusSession(identity)).resolves.toEqual(launchResult(receipt));
    expect(requests).toEqual([
      { method: "POST", url: "/api/focus/session-launches", body: identity },
      { method: "POST", url: "/api/focus/session-launches", body: identity },
    ]);
  });

  it("rejects a frozen-intent conflict as ApiError and permits an explicit read of the unchanged receipt", async () => {
    const receipt = preparedReceipt();
    const error = "This episode/source already has a launch with different prompt, destination or session options";
    const changed: FocusLaunchRequest = { ...identity, prompt: "A different prompt", taskId: null, model: "gpt-5.4" };
    const requests = mockResponses(
      Response.json(launchResult(receipt, true), { status: 201 }),
      Response.json({ error }, { status: 409 }),
      Response.json({ receipt }),
    );
    await api.prepareFocusSessionLaunch(identity);
    await expectApiError(api.prepareFocusSessionLaunch(changed), 409, error);
    await expect(api.fetchFocusLaunchReceipt(identity)).resolves.toEqual(receipt);
    expect(requests).toEqual([
      { method: "POST", url: "/api/focus/session-launches/prepare", body: identity },
      { method: "POST", url: "/api/focus/session-launches/prepare", body: changed },
      { method: "GET", url: "/api/focus/session-launches?objectId=decision-1&activationId=activation-1&source=launch_prompt" },
    ]);
  });
});

describe("Focus launch error receipt preservation", () => {
  it.each([
    {
      status: 409,
      receipt: preparedReceipt({
        status: "unknown", creationDispatchedAt: FOCUS_TEST_NOW, errorStage: "creation",
        error: "Creation was dispatched but its result is unknown", version: 3,
      }),
    },
    {
      status: 409,
      receipt: focusLaunchReceipt({
        status: "unknown", promptStatus: "unknown", errorStage: "prompt",
        error: "Initial prompt delivery is unconfirmed", version: 6,
      }),
    },
    {
      status: 409,
      receipt: preparedReceipt({
        status: "superseded", errorStage: "creation",
        error: "This Focus episode is no longer open/current", version: 2,
      }),
    },
    {
      status: 502,
      receipt: preparedReceipt({ status: "failed", errorStage: "creation", error: "Backend unavailable", version: 2 }),
    },
    {
      status: 502,
      receipt: focusLaunchReceipt({
        status: "failed", linkedAt: null, promptDispatchedAt: null, promptStatus: "pending",
        errorStage: "link", error: "Focus link unavailable",
      }),
    },
    {
      status: 502,
      receipt: focusLaunchReceipt({
        status: "failed", promptDispatchedAt: null, promptStatus: "pending",
        errorStage: "prompt", error: "Session warming failed", version: 5,
      }),
    },
  ])("retains the complete $receipt.status/$receipt.errorStage receipt from HTTP $status", async ({ status, receipt }) => {
    const requests = mockResponses(Response.json(launchResult(receipt), { status }));
    const error = await api.launchFocusSession(identity).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(api.FocusLaunchError);
    expect(error).toBeInstanceOf(api.ApiError);
    expect(error).toMatchObject({ name: "FocusLaunchError", status, message: receipt.error, receipt });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(requests).toEqual([{ method: "POST", url: "/api/focus/session-launches", body: identity }]);
  });

  it.each([
    { responseError: "Response recovery advice", receiptError: "Retained failure", expected: "Response recovery advice" },
    { responseError: undefined, receiptError: "Retained failure", expected: "Retained failure" },
    { responseError: undefined, receiptError: null, expected: "Focus launch needs recovery" },
  ])("uses the most specific verified failure message: $expected", async ({ responseError, receiptError, expected }) => {
    const receipt = focusLaunchReceipt({ status: "unknown", promptStatus: "unknown", errorStage: "prompt", error: receiptError });
    const result = { ...launchResult(receipt), error: responseError };
    const requests = mockResponses(Response.json(result, { status: 409 }));
    const error = await api.startFocusSessionLaunch(receipt.id).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(api.FocusLaunchError);
    expect(error).toMatchObject({ status: 409, message: expected, receipt });
    expect(requests).toEqual([{ method: "POST", url: "/api/focus/session-launches/receipt-1/start", body: {} }]);
  });

  it("uses ApiError when a non-success response has an unverified receipt", async () => {
    const error = "The retained receipt could not be read";
    const requests = mockResponses(Response.json({ ...launchResult(), receipt: { id: "receipt-1" }, error }, { status: 502 }));
    await expectApiError(api.startFocusSessionLaunch("receipt-1"), 502, error);
    expect(requests).toHaveLength(1);
  });

  it.each([400, 404, 503])("retains receipt-less HTTP %s rejection without falling back to ordinary creation", async (status) => {
    const error = "Focus launch cannot start";
    const requests = mockResponses(Response.json({ error }, { status }));
    await expectApiError(api.launchFocusSession(identity), status, error);
    expect(requests).toEqual([{ method: "POST", url: "/api/focus/session-launches", body: identity }]);
  });
});

describe("unverified Focus launch responses", () => {
  it.each([
    { name: "HTML success", status: 200, body: "<html>Proxy response</html>" },
    { name: "truncated JSON", status: 201, body: '{"receipt":' },
    { name: "empty success", status: 204, body: null },
    { name: "HTML failure", status: 502, body: "<html>Bad gateway</html>" },
  ])("refuses $name without retrying or inventing readiness", async ({ status, body }) => {
    const requests = mockResponses(new Response(body, { status }));
    await expectApiError(api.launchFocusSession(identity), status);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(requests).toEqual([{ method: "POST", url: "/api/focus/session-launches", body: identity }]);
  });

  it.each([
    { name: "null body", body: null },
    { name: "ordinary session response", body: { sessionId: "ordinary-session" } },
    { name: "missing created flag", body: { ...launchResult(), created: undefined } },
    { name: "nonboolean created flag", body: { ...launchResult(), created: "false" } },
    { name: "missing envelope session ID", body: { ...launchResult(), sessionId: undefined } },
    { name: "null envelope session ID", body: { ...launchResult(), sessionId: null } },
    { name: "missing receipt", body: { ...launchResult(), receipt: undefined } },
    { name: "null receipt", body: { ...launchResult(), receipt: null } },
    { name: "array receipt", body: { ...launchResult(), receipt: [] } },
  ])("refuses a successful response with $name", async ({ body }) => {
    const requests = mockResponses(Response.json(body));
    await expectApiError(api.prepareFocusSessionLaunch(identity), 200);
    expect(requests).toEqual([{ method: "POST", url: "/api/focus/session-launches/prepare", body: identity }]);
  });

  it.each([
    "id", "objectId", "activationId", "source", "objectType", "objectTitle", "status",
    "taskId", "taskTitle", "prompt", "promptFingerprint", "creationOptions", "expectedSessionId", "sessionId",
    "promptStatus", "creationDispatchedAt", "linkedAt", "promptDispatchedAt", "error", "errorStage",
    "version", "createdAt", "updatedAt",
  ] satisfies Array<keyof FocusSessionLaunch>)("requires the complete receipt field %s even on HTTP success", async (field) => {
    const receipt: Record<string, unknown> = { ...focusLaunchReceipt() };
    delete receipt[field];
    const requests = mockResponses(Response.json({ ...launchResult(), receipt }));
    await expectApiError(api.startFocusSessionLaunch("receipt-1"), 200);
    expect(requests).toEqual([{ method: "POST", url: "/api/focus/session-launches/receipt-1/start", body: {} }]);
  });

  it.each([
    { name: "array creation options", patch: { creationOptions: [] } },
    { name: "null creation options", patch: { creationOptions: null } },
    { name: "legacy chat source", patch: { source: "chat" } },
    { name: "Action object type", patch: { objectType: "action" } },
    { name: "unrecognized status", patch: { status: "done" } },
    { name: "unrecognized prompt status", patch: { promptStatus: "ready" } },
    { name: "unrecognized error stage", patch: { errorStage: "delivery" } },
    { name: "negative version", patch: { version: -1 } },
    { name: "fractional version", patch: { version: 1.5 } },
    { name: "nonstring task ID", patch: { taskId: 1 } },
    { name: "nonstring session ID", patch: { sessionId: {} } },
    { name: "null prompt fingerprint", patch: { promptFingerprint: null } },
  ])("refuses a receipt with $name", async ({ patch }) => {
    const requests = mockResponses(Response.json({ ...launchResult(), receipt: { ...focusLaunchReceipt(), ...patch } }));
    await expectApiError(api.launchFocusSession(identity), 200);
    expect(requests).toHaveLength(1);
  });
});

it("prefixes every durable launch endpoint with the staging base while encoding identities only once", async () => {
  vi.stubEnv("BASE_URL", "/staging/launch-preview///");
  vi.resetModules();
  api = await import("./api");
  const input: FocusLaunchIdentity = { objectId: "decision /?#", activationId: "episode /?#", source: "discussion" };
  const receipt = focusLaunchReceipt({
    ...input, id: "receipt /?#", expectedSessionId: "receipt /?#", sessionId: "receipt /?#",
  });
  const result = launchResult(receipt);
  const requests = mockResponses(
    Response.json({ receipt }), Response.json({ receipts: [receipt] }), Response.json({ receipt }),
    Response.json(result), Response.json(result), Response.json(result),
  );
  await expect(api.fetchFocusLaunchReceipt(input)).resolves.toEqual(receipt);
  await expect(api.fetchFocusLaunchReceipts(input.objectId, input.activationId)).resolves.toEqual([receipt]);
  await expect(api.fetchFocusLaunchReceiptById(receipt.id)).resolves.toEqual(receipt);
  await expect(api.launchFocusSession(input)).resolves.toEqual(result);
  await expect(api.prepareFocusSessionLaunch(input)).resolves.toEqual(result);
  await expect(api.startFocusSessionLaunch(receipt.id)).resolves.toEqual(result);
  expect(requests).toEqual([
    { method: "GET", url: "/staging/launch-preview/api/focus/session-launches?objectId=decision+%2F%3F%23&activationId=episode+%2F%3F%23&source=discussion" },
    { method: "GET", url: "/staging/launch-preview/api/focus/session-launches?objectId=decision+%2F%3F%23&activationId=episode+%2F%3F%23" },
    { method: "GET", url: "/staging/launch-preview/api/focus/session-launches/receipt%20%2F%3F%23" },
    { method: "POST", url: "/staging/launch-preview/api/focus/session-launches", body: input },
    { method: "POST", url: "/staging/launch-preview/api/focus/session-launches/prepare", body: input },
    { method: "POST", url: "/staging/launch-preview/api/focus/session-launches/receipt%20%2F%3F%23/start", body: {} },
  ]);
});
