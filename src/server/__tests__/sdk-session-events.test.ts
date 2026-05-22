import { describe, expect, it, vi } from "vitest";
import { readSdkSessionEvents } from "../sdk-session-events.js";

describe("SDK session event helpers", () => {
  it("reads beta.6 session events with the SDK session binding intact", async () => {
    const session = {
      marker: "bound-session",
      getEvents: vi.fn(async function (this: { marker: string }) {
        return [{ type: "assistant.message", marker: this.marker }];
      }),
    };

    await expect(readSdkSessionEvents(session)).resolves.toEqual([
      { type: "assistant.message", marker: "bound-session" },
    ]);
    expect(session.getEvents).toHaveBeenCalledOnce();
  });

  it("fails loudly when the SDK session event API is unavailable", async () => {
    await expect(readSdkSessionEvents({})).rejects.toThrow("session event API is not available");
  });

  it("fails loudly when the SDK returns a malformed event payload", async () => {
    await expect(readSdkSessionEvents({ getEvents: vi.fn(async () => ({ events: [] })) }))
      .rejects.toThrow("non-array result");
  });
});
