import { afterEach, describe, expect, it, vi } from "vitest";
import { holdPageReload, holdVoiceCapture, schedulePageReloadWhenSafe, whenPageReloadSafe, whileHoldingVoiceCapture } from "./voice-capture-guard";

interface FakeSentinel {
  released: boolean;
  release: () => Promise<void>;
}

function stubBrowser() {
  const windowListeners = new Map<string, (event: unknown) => void>();
  const documentListeners = new Map<string, () => void>();
  const sentinels: FakeSentinel[] = [];
  const fakeDocument = {
    visibilityState: "visible",
    addEventListener: (type: string, listener: () => void) => documentListeners.set(type, listener),
    removeEventListener: (type: string) => documentListeners.delete(type),
  };
  vi.stubGlobal("window", {
    addEventListener: (type: string, listener: (event: unknown) => void) => windowListeners.set(type, listener),
    removeEventListener: (type: string) => windowListeners.delete(type),
  });
  vi.stubGlobal("document", fakeDocument);
  vi.stubGlobal("navigator", {
    wakeLock: {
      request: async () => {
        const sentinel: FakeSentinel = {
          released: false,
          release: async () => {
            sentinel.released = true;
          },
        };
        sentinels.push(sentinel);
        return sentinel;
      },
    },
  });
  return { windowListeners, documentListeners, sentinels, fakeDocument };
}

/** Lets the pending wake lock request settle. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("voice capture guard", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("holds reloads for unsent work without taking a wake lock", () => {
    const { sentinels } = stubBrowser();
    const release = holdPageReload();
    const reload = vi.fn();
    const cancel = whenPageReloadSafe(reload);
    try {
      expect(reload).not.toHaveBeenCalled();
      expect(sentinels).toHaveLength(0);
      release();
      release();
      expect(reload).toHaveBeenCalledOnce();
    } finally { cancel(); release(); }
  });

  it("rechecks safety when a capture starts inside the reload delay", async () => {
    stubBrowser();
    vi.useFakeTimers();
    const reload = vi.fn();
    const held = vi.fn();
    const cancel = schedulePageReloadWhenSafe(reload, held);
    let release = () => {};
    try {
      await vi.advanceTimersByTimeAsync(999);
      release = holdVoiceCapture();
      await vi.advanceTimersByTimeAsync(1);
      expect(reload).not.toHaveBeenCalled();
      expect(held).toHaveBeenCalledOnce();
      release();
      expect(reload).toHaveBeenCalledOnce();
    } finally { cancel(); release(); }
  });

  it("cancels both scheduled and held page reloads", async () => {
    stubBrowser();
    vi.useFakeTimers();
    const reload = vi.fn();
    schedulePageReloadWhenSafe(reload, vi.fn())();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reload).not.toHaveBeenCalled();
    const release = holdPageReload();
    const cancel = schedulePageReloadWhenSafe(reload, vi.fn());
    try {
      await vi.advanceTimersByTimeAsync(1_000);
      cancel();
      release();
      expect(reload).not.toHaveBeenCalled();
    } finally { cancel(); release(); }
  });

  it("asks before the tab closes only while a capture is at risk", async () => {
    const { windowListeners } = stubBrowser();
    const end = holdVoiceCapture();

    const event = { preventDefault: vi.fn(), returnValue: undefined as string | undefined };
    windowListeners.get("beforeunload")?.(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.returnValue).toBe("");

    end();
    await settle();
    expect(windowListeners.has("beforeunload")).toBe(false);
  });

  it("keeps the screen awake, takes the lock again when the tab returns, and lets go at the end", async () => {
    const { documentListeners, sentinels, fakeDocument } = stubBrowser();
    const end = holdVoiceCapture();
    await settle();
    expect(sentinels).toHaveLength(1);

    // The browser releases the lock when the tab is hidden.
    sentinels[0]!.released = true;
    fakeDocument.visibilityState = "hidden";
    documentListeners.get("visibilitychange")?.();
    await settle();
    expect(sentinels).toHaveLength(1);

    fakeDocument.visibilityState = "visible";
    documentListeners.get("visibilitychange")?.();
    await settle();
    expect(sentinels).toHaveLength(2);

    end();
    await settle();
    expect(sentinels[1]!.released).toBe(true);
    expect(documentListeners.has("visibilitychange")).toBe(false);
  });

  it("releases a lock that arrives after the capture is already safe", async () => {
    const { sentinels } = stubBrowser();
    holdVoiceCapture()();
    await settle();
    expect(sentinels.map((sentinel) => sentinel.released)).toEqual([true]);
  });

  it("holds a capture for as long as its upload runs, even one that fails", async () => {
    stubBrowser();
    const idle = vi.fn();
    let failUpload = (_error: Error) => {};
    const upload = whileHoldingVoiceCapture(() => new Promise<void>((_resolve, reject) => {
      failUpload = reject;
    }));
    whenPageReloadSafe(idle);
    expect(idle).not.toHaveBeenCalled();

    failUpload(new Error("Network timeout"));
    await expect(upload).rejects.toThrow("Network timeout");
    expect(idle).toHaveBeenCalledOnce();
    await settle();
  });

  it("holds idle callbacks until every capture is safe", async () => {
    stubBrowser();
    const endFirst = holdVoiceCapture();
    const endSecond = holdVoiceCapture();
    const reload = vi.fn();
    const cancelled = vi.fn();
    whenPageReloadSafe(reload);
    whenPageReloadSafe(cancelled)();

    endFirst();
    endFirst();
    expect(reload).not.toHaveBeenCalled();

    endSecond();
    expect(reload).toHaveBeenCalledOnce();
    expect(cancelled).not.toHaveBeenCalled();

    const immediate = vi.fn();
    whenPageReloadSafe(immediate);
    expect(immediate).toHaveBeenCalledOnce();
    await settle();
  });
});
