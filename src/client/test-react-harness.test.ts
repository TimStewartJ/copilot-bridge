import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  advanceTimersByTimeAct,
  createReactDomHarness,
  waitUntilAct,
  type Act,
} from "./test-react-harness";

const passthroughAct: Act = async (callback) => {
  await callback();
};

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

describe("React DOM harness deterministic waits", () => {
  it("resolves waitUntilAct after deterministic microtask flushes", async () => {
    let ready = false;
    queueMicrotask(() => {
      ready = true;
    });

    await waitUntilAct(passthroughAct, () => ready);

    expect(ready).toBe(true);
  });

  it("fails waitUntilAct after bounded React flushes instead of wall-clock time", async () => {
    await expect(waitUntilAct(passthroughAct, () => false, {
      label: "missing state",
      maxFlushes: 2,
    })).rejects.toThrow("Condition (missing state) was not met after 2 React flushes");
  });

  it("advances known delays only when fake timers are active", async () => {
    await expect(advanceTimersByTimeAct(passthroughAct, 1))
      .rejects.toThrow("advanceTimersByTimeAct requires fake timers");

    vi.useFakeTimers();
    let fired = false;
    setTimeout(() => {
      fired = true;
    }, 25);

    await advanceTimersByTimeAct(passthroughAct, 25);

    expect(fired).toBe(true);
  });
});
