import { describe, expect, it, vi } from "vitest";
import { installDomShim } from "./test-dom-shim";

describe("installDomShim", () => {
  it("keeps one stable DOM global while resetting per-test state", () => {
    const first = installDomShim();
    const windowRef = globalThis.window;
    const documentRef = globalThis.document;
    const navigatorRef = globalThis.navigator;
    const createElementRef = document.createElement;

    first.container.textContent = "dirty";
    (globalThis.window as unknown as { open?: () => void }).open = vi.fn();
    (globalThis.navigator as unknown as { clipboard?: { writeText: () => void } }).clipboard = {
      writeText: vi.fn(),
    };
    document.createElement = ((tagName: string) => createElementRef(`x-${tagName}`)) as typeof document.createElement;

    first.cleanup();

    expect(globalThis.window).toBe(windowRef);
    expect(globalThis.document).toBe(documentRef);
    expect(globalThis.navigator).toBe(navigatorRef);
    expect((globalThis.window as unknown as { open?: () => void }).open).toBeUndefined();
    expect((globalThis.navigator as unknown as { clipboard?: unknown }).clipboard).toBeUndefined();
    expect(document.createElement("span").tagName).toBe("SPAN");
    expect(globalThis.document.body?.textContent).toBe("");

    const second = installDomShim();
    try {
      expect(globalThis.window).toBe(windowRef);
      expect(globalThis.document).toBe(documentRef);
      expect(globalThis.navigator).toBe(navigatorRef);
      expect(second.container).not.toBe(first.container);
      expect(globalThis.document.body).toBe(second.container);
    } finally {
      second.cleanup();
    }
  });

  it("fails loudly instead of clobbering an active shim", () => {
    const first = installDomShim();
    try {
      expect(() => installDomShim()).toThrow("overlapping active DOM shims");
    } finally {
      first.cleanup();
    }
  });

  it("runs animation frames through deterministic microtasks", async () => {
    const shim = installDomShim();
    try {
      const callback = vi.fn();
      window.requestAnimationFrame(callback);
      expect(callback).not.toHaveBeenCalled();

      await Promise.resolve();

      expect(callback).toHaveBeenCalledOnce();
      expect(callback.mock.calls[0][0]).toEqual(expect.any(Number));

      const canceledCallback = vi.fn();
      const id = window.requestAnimationFrame(canceledCallback);
      window.cancelAnimationFrame(id);

      await Promise.resolve();

      expect(canceledCallback).not.toHaveBeenCalled();
    } finally {
      shim.cleanup();
    }
  });
});
