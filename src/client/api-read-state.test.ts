import { describe, expect, it, vi } from "vitest";
import { markSessionReadOnPageHide } from "./api.js";

describe("markSessionReadOnPageHide", () => {
  it("prefers sendBeacon when available", () => {
    const sendBeacon = vi.fn().mockReturnValue(true);
    const fetchFn = vi.fn();

    markSessionReadOnPageHide("session-1", {
      navigator: { sendBeacon },
      fetchFn,
    });

    expect(sendBeacon).toHaveBeenCalledWith("/api/read-state/session-1");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("sends read-through cursor as JSON when provided", async () => {
    const sendBeacon = vi.fn().mockReturnValue(true);
    const fetchFn = vi.fn();

    markSessionReadOnPageHide("session-1", {
      readThroughActivityAt: "2026-05-07T21:00:00.000Z",
      navigator: { sendBeacon },
      fetchFn,
    });

    expect(sendBeacon).toHaveBeenCalledWith(
      "/api/read-state/session-1",
      expect.any(Blob),
    );
    const payload = sendBeacon.mock.calls[0][1] as Blob;
    expect(payload.type).toBe("application/json");
    expect(JSON.parse(await payload.text())).toEqual({
      readThroughActivityAt: "2026-05-07T21:00:00.000Z",
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("falls back to keepalive fetch when sendBeacon is unavailable", () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true });

    markSessionReadOnPageHide("session-2", {
      readThroughActivityAt: "2026-05-07T21:00:00.000Z",
      fetchFn,
    });

    expect(fetchFn).toHaveBeenCalledWith(
      "/api/read-state/session-2",
      expect.objectContaining({
        method: "POST",
        keepalive: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ readThroughActivityAt: "2026-05-07T21:00:00.000Z" }),
      }),
    );
  });

  it("falls back to keepalive fetch when sendBeacon declines the request", () => {
    const sendBeacon = vi.fn().mockReturnValue(false);
    const fetchFn = vi.fn().mockResolvedValue({ ok: true });

    markSessionReadOnPageHide("session-3", {
      readThroughActivityAt: "2026-05-07T21:00:00.000Z",
      navigator: { sendBeacon },
      fetchFn,
    });

    expect(sendBeacon).toHaveBeenCalledWith("/api/read-state/session-3", expect.any(Blob));
    expect(fetchFn).toHaveBeenCalledWith(
      "/api/read-state/session-3",
      expect.objectContaining({
        method: "POST",
        keepalive: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ readThroughActivityAt: "2026-05-07T21:00:00.000Z" }),
      }),
    );
  });
});
