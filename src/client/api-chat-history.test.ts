import { afterEach, describe, expect, it, vi } from "vitest";
import { undoSessionTurn } from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
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
  });
});
