import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDialogTestHarness, type DialogTestHarness } from "../test-dialog-harness";
import { findAllByTag, getReactProps } from "../test-react-harness";

import FocusDialog from "../design/Dialog";

describe("Focus session modal keyboard containment", () => {
  let harness: DialogTestHarness;
  beforeEach(async () => { harness = await createDialogTestHarness(); });
  afterEach(async () => { await harness.cleanup(); });

  it("focuses its prompt, contains Tab in both directions, and restores prior focus on close", async () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    await harness.render(createElement(FocusDialog, { title: "Native question", pending: false, onClose: vi.fn(), children: createElement("div", null,
      createElement("textarea", { defaultValue: "Inspect the source" }), createElement("button", { type: "button" }, "Submit")) }));
    const dialog = findAllByTag(harness.dom.container, "DIV").find((node) => getReactProps(node)?.role === "dialog");
    const buttons = findAllByTag(dialog, "BUTTON");
    const first = buttons[0];
    const last = buttons.at(-1);
    expect(document.activeElement).toBe(findAllByTag(dialog, "TEXTAREA")[0]);
    const forward = vi.fn();
    await harness.act(async () => {
      last.focus();
      getReactProps(dialog)?.onKeyDown?.({ key: "Tab", shiftKey: false, preventDefault: forward });
    });
    expect(forward).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(first);
    const backward = vi.fn();
    await harness.act(async () => {
      getReactProps(dialog)?.onKeyDown?.({ key: "Tab", shiftKey: true, preventDefault: backward });
    });
    expect(backward).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(last);
    await harness.render(null);
    expect(document.activeElement).toBe(trigger);
    document.body.removeChild(trigger);
  });

  it("skips navigation controls in collapsed retained-episode details when trapping focus", async () => {
    await harness.render(createElement(FocusDialog, { title: "Retained episode", pending: false, onClose: vi.fn(),
      children: createElement("details", null,
        createElement("summary", null, "Earlier state"),
        createElement("button", { type: "button" }, "Hidden session navigation")),
    }));
    const dialog = findAllByTag(harness.dom.container, "DIV").find((node) => getReactProps(node)?.role === "dialog");
    const close = findAllByTag(dialog, "BUTTON")[0];
    const summary = findAllByTag(dialog, "SUMMARY")[0];
    await harness.act(async () => {
      close.focus();
      getReactProps(dialog)?.onKeyDown?.({ key: "Tab", shiftKey: true, preventDefault: vi.fn() });
    });
    expect(document.activeElement).toBe(summary);
    await harness.act(async () => {
      getReactProps(dialog)?.onKeyDown?.({ key: "Tab", shiftKey: false, preventDefault: vi.fn() });
    });
    expect(document.activeElement).toBe(close);
  });
  it("does not trap focus inside a disabled native-question fieldset", async () => {
    await harness.render(createElement(FocusDialog, { title: "Unavailable source", pending: false, onClose: vi.fn(),
      children: createElement("fieldset", { disabled: true }, createElement("input", { defaultValue: "Retained draft" }), createElement("button", null, "Disabled submit")),
    }));
    const dialog = findAllByTag(harness.dom.container, "DIV").find(node => getReactProps(node)?.role === "dialog");
    const close = findAllByTag(dialog, "BUTTON")[0];
    await harness.act(async () => {
      close.focus();
      getReactProps(dialog)?.onKeyDown?.({ key: "Tab", shiftKey: false, preventDefault: vi.fn() });
    });
    expect(document.activeElement).toBe(close);
  });
});
