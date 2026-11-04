import { afterEach, describe, expect, it, vi } from "vitest";
import { undoSessionTurn } from "./api";

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

  it("includes attachments in the request body when provided, omits the key otherwise", async () => {
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
    ], undefined, { waitForDelivery: true, clientMessageId: "client-message-1" });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/chat");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      sessionId: "session-1",
      prompt: "(attachment)",
      waitForDelivery: true,
      clientMessageId: "client-message-1",
      attachments: [
        {
          type: "file",
          path: "attachments/screenshot.png",
          displayName: "screenshot.png",
        },
      ],
    });

    fetchMock.mockClear();
    await sendChatMessage("session-1", "hello");

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      sessionId: "session-1",
      prompt: "hello",
    });
  });
});

describe("chat history client API", () => {
  it("posts the raw user turn boundary to the undo endpoint", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ eventsRemoved: 3 }),
    })));

    await expect(undoSessionTurn("session/one", "user-event-2"))
      .resolves.toEqual({ eventsRemoved: 3 });

    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "/api/sessions/session%2Fone/undo",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventId: "user-event-2" }),
      },
    );

    vi.unstubAllGlobals();
  });
});
