import { describe, expect, it, vi } from "vitest";
import { readSdkSessionEvents } from "../sdk-session-events.js";

describe("SDK session event helpers", () => {
  it("reads events correctly, fails loudly on missing API or malformed payload", async () => {
    // reads beta.6 session events with the SDK session binding intact
    {
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
    }

    // fails loudly when the SDK session event API is unavailable
    await expect(readSdkSessionEvents({})).rejects.toThrow("session event API is not available");

    // fails loudly when the SDK returns a malformed event payload
    await expect(readSdkSessionEvents({ getEvents: vi.fn(async () => ({ events: [] })) }))
      .rejects.toThrow("non-array result");
  });
});
