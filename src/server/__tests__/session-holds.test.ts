import { describe, expect, it, vi } from "vitest";
import { SessionHolds } from "../session-holds.js";

describe("SessionHolds", () => {
  it("tracks the reason a session is held until the hold ends", () => {
    const holds = new SessionHolds();
    expect(holds.end("s")).toBe(false);

    holds.start("s", "history-undo");
    expect(holds.get("s")).toBe("history-undo");
    expect([...holds.sessionIds()]).toEqual(["s"]);

    expect(holds.end("s")).toBe(true);
    expect(holds.has("s")).toBe(false);
  });

  it("tells subscribers about their session until they unsubscribe", () => {
    const holds = new SessionHolds();
    const listener = vi.fn();
    const unsubscribe = holds.subscribe("s", listener);

    holds.start("s", "image-compaction");
    holds.notify("other");
    holds.notify("s");
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    holds.notify("s");
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("keeps notifying the other subscribers when one throws", () => {
    const holds = new SessionHolds();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const later = vi.fn();
    holds.subscribe("s", () => { throw new Error("boom"); });
    holds.subscribe("s", later);

    holds.notify("s");

    expect(later).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
