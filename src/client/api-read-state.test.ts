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

  it("falls back to keepalive fetch when sendBeacon is unavailable", () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true });

    markSessionReadOnPageHide("session-2", { fetchFn });

    expect(fetchFn).toHaveBeenCalledWith(
      "/api/read-state/session-2",
      expect.objectContaining({ method: "POST", keepalive: true }),
    );
  });

  it("falls back to keepalive fetch when sendBeacon declines the request", () => {
    const sendBeacon = vi.fn().mockReturnValue(false);
    const fetchFn = vi.fn().mockResolvedValue({ ok: true });

    markSessionReadOnPageHide("session-3", {
      navigator: { sendBeacon },
      fetchFn,
    });

    expect(sendBeacon).toHaveBeenCalledWith("/api/read-state/session-3");
    expect(fetchFn).toHaveBeenCalledWith(
      "/api/read-state/session-3",
      expect.objectContaining({ method: "POST", keepalive: true }),
    );
  });
});
