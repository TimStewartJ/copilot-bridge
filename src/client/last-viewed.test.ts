import { afterEach, describe, expect, it, vi } from "vitest";
import { getLastMobileWorkSegment, setLastMobileWorkSegment } from "./last-viewed";

function stubLocalStorage(initial: Record<string, string> = {}): void {
  const store = new Map(Object.entries(initial));
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("last mobile Work segment", () => {
  it("opens on tasks until the chats list has been shown", () => {
    stubLocalStorage();
    expect(getLastMobileWorkSegment()).toBe("tasks");

    setLastMobileWorkSegment("chats");
    expect(getLastMobileWorkSegment()).toBe("chats");

    setLastMobileWorkSegment("tasks");
    expect(getLastMobileWorkSegment()).toBe("tasks");
  });

  it("falls back to tasks for an unknown value or unavailable storage", () => {
    stubLocalStorage({ "bridge-last-mobile-work-segment": "docs" });
    expect(getLastMobileWorkSegment()).toBe("tasks");

    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("storage blocked");
      },
      setItem: () => {
        throw new Error("storage blocked");
      },
    });
    expect(() => setLastMobileWorkSegment("chats")).not.toThrow();
    expect(getLastMobileWorkSegment()).toBe("tasks");
  });
});
