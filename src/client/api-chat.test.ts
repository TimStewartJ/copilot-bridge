import { afterEach, describe, expect, it, vi } from "vitest";

const telemetryBatcherMock = vi.hoisted(() => ({
  enqueue: vi.fn(),
  flush: vi.fn(),
  flushSync: vi.fn(),
  getPendingCount: vi.fn(() => 0),
  dispose: vi.fn(),
}));

vi.mock("./telemetry-batcher", () => ({
  createTelemetryBatcher: () => telemetryBatcherMock,
}));

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    json: async () => body,
  } as Response;
}

describe("sendChatMessage", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("returns the accepted response envelope", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/chat") {
        return jsonResponse({ status: "accepted", mode: "steered" });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

    const { sendChatMessage } = await import("./api.js");

    await expect(sendChatMessage("session-1", "adjust course")).resolves.toEqual({
      status: "accepted",
      mode: "steered",
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/chat");
  });

  it("includes attachments in the chat request body", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/chat") {
        return jsonResponse({ status: "accepted" });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

    const { sendChatMessage } = await import("./api.js");

    await sendChatMessage("session-1", "(attachment)", [
      {
        type: "file",
        path: "attachments/screenshot.png",
        displayName: "screenshot.png",
      },
    ]);

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      sessionId: "session-1",
      prompt: "(attachment)",
      attachments: [
        {
          type: "file",
          path: "attachments/screenshot.png",
          displayName: "screenshot.png",
        },
      ],
    });
  });

  it("omits the attachments key when no attachments are provided", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/chat") {
        return jsonResponse({ status: "accepted" });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

    const { sendChatMessage } = await import("./api.js");

    await sendChatMessage("session-1", "hello");

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      sessionId: "session-1",
      prompt: "hello",
    });
  });

  it("requests prompt delivery confirmation when asked", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/chat") {
        return jsonResponse({ status: "accepted" });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

    const { sendChatMessage } = await import("./api.js");

    await sendChatMessage("session-1", "hello", undefined, undefined, {
      waitForDelivery: true,
    });

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      sessionId: "session-1",
      prompt: "hello",
      waitForDelivery: true,
    });
  });
});
