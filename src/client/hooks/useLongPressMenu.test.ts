import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  advanceTimersByTimeAct,
  createReactDomHarness,
  findAllByTag,
  getReactProps,
  type ReactDomHarness,
} from "../test-react-harness";
import useLongPressMenu from "./useLongPressMenu";

function LongPressFixture({ onActivate }: { onActivate: () => void }) {
  const { bind, menu, isTarget } = useLongPressMenu<string>();
  return createElement("button", {
    ...bind("message-1", onActivate),
    type: "button",
    "data-menu-open": menu?.id === "message-1" ? "true" : "false",
    "data-pressing": isTarget("message-1") ? "true" : "false",
  }, "Message");
}

function findButton(harness: ReactDomHarness): any {
  const button = findAllByTag(harness.dom.container, "BUTTON")[0];
  if (!button) throw new Error("Long-press button not found");
  return button;
}

describe("useLongPressMenu", () => {
  let harness: ReactDomHarness | null = null;

  beforeEach(async () => {
    vi.useFakeTimers();
    harness = await createReactDomHarness();
  });

  afterEach(async () => {
    await harness?.cleanup();
    harness = null;
  });

  it("opens after the hold delay and suppresses the synthesized click", async () => {
    if (!harness) throw new Error("Harness not initialized");
    const onActivate = vi.fn();
    await harness.render(createElement(LongPressFixture, { onActivate }));

    await harness.act(async () => {
      getReactProps(findButton(harness!))?.onTouchStart?.({
        touches: [{ clientX: 20, clientY: 30 }],
      });
    });
    expect(findButton(harness).getAttribute("data-pressing")).toBe("true");

    await advanceTimersByTimeAct(harness.act, 500);
    expect(findButton(harness).getAttribute("data-menu-open")).toBe("true");

    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    await harness.act(async () => {
      getReactProps(findButton(harness!))?.onClick?.({ preventDefault, stopPropagation });
    });

    expect(preventDefault).toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalled();
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("cancels when the touch moves beyond the threshold", async () => {
    if (!harness) throw new Error("Harness not initialized");
    await harness.render(createElement(LongPressFixture, { onActivate: vi.fn() }));

    await harness.act(async () => {
      const props = getReactProps(findButton(harness!));
      props?.onTouchStart?.({ touches: [{ clientX: 10, clientY: 10 }] });
      props?.onTouchMove?.({ touches: [{ clientX: 30, clientY: 10 }] });
    });
    await advanceTimersByTimeAct(harness.act, 500);

    expect(findButton(harness).getAttribute("data-pressing")).toBe("false");
    expect(findButton(harness).getAttribute("data-menu-open")).toBe("false");
  });

  it("ignores touch events without an active touch point", async () => {
    if (!harness) throw new Error("Harness not initialized");
    await harness.render(createElement(LongPressFixture, { onActivate: vi.fn() }));

    await harness.act(async () => {
      getReactProps(findButton(harness!))?.onTouchStart?.({ touches: [] });
    });
    await advanceTimersByTimeAct(harness.act, 500);

    expect(findButton(harness).getAttribute("data-pressing")).toBe("false");
    expect(findButton(harness).getAttribute("data-menu-open")).toBe("false");
  });
});
