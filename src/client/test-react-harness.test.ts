import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { createReactDomHarness } from "./test-react-harness";

describe("createReactDomHarness cleanup", () => {
  it("registers cleanup with the test lifecycle", async () => {
    const harness = await createReactDomHarness();

    await harness.render(createElement("div", null, "mounted"));

    expect(harness.dom.container.textContent).toBe("mounted");
    expect(globalThis.window).toBeDefined();
  });

  it("cleans up a harness left by the previous test without removing singleton globals", () => {
    expect(globalThis.window).toBeDefined();
    expect(globalThis.document.body?.textContent).toBe("");
  });

  it("unmounts under real timers without changing the caller timer mode", async () => {
    const singletonWindow = globalThis.window;
    vi.useFakeTimers();
    const harness = await createReactDomHarness();

    await harness.render(createElement("div", null, "timer cleanup"));
    await harness.cleanup();

    expect(vi.isFakeTimers()).toBe(true);
    expect(globalThis.window).toBe(singletonWindow);
    expect(globalThis.document.body?.textContent).toBe("");
  });
});
