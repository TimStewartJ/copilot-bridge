import { createElement, createRef } from "react";
import { X } from "lucide-react";
import { afterEach, describe, expect, it } from "vitest";
import { createReactDomHarness, findAllByTag, getReactProps, type ReactDomHarness } from "../../test-react-harness";
import { DS } from "../../design/tokens";
import { DocsButton, DocsIconButton, DocsInput, DocsSelect, DocsTextarea } from "./docs-ui";

describe("docs design adapters", () => {
  let harness: ReactDomHarness | undefined;

  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  it("keeps native input refs, invalid state and shared phone typography", async () => {
    harness = await createReactDomHarness();
    const input = createRef<HTMLInputElement>();
    const select = createRef<HTMLSelectElement>();
    const textarea = createRef<HTMLTextAreaElement>();
    await harness.render(createElement("div", null,
      createElement(DocsInput, { ref: input, invalid: true, "aria-label": "Title" }),
      createElement(DocsSelect, { ref: select, "aria-label": "Status" }, createElement("option", null, "Open")),
      createElement(DocsTextarea, { ref: textarea, rows: 6, "aria-label": "Description" }),
    ));
    expect(input.current).toBe(findAllByTag(harness.dom.container, "INPUT")[0]);
    expect(select.current).toBe(findAllByTag(harness.dom.container, "SELECT")[0]);
    expect(textarea.current).toBe(findAllByTag(harness.dom.container, "TEXTAREA")[0]);
    expect(getReactProps(input.current)?.["aria-invalid"]).toBe(true);
    for (const field of [input.current, select.current, textarea.current]) {
      expect(getReactProps(field)?.className).toContain(DS.field.input);
    }
    expect(getReactProps(textarea.current)?.rows).toBe(6);
    expect(getReactProps(textarea.current)?.className).not.toContain(DS.field.inputSize.md);
  });

  it("retains loading, disabled and accessible action contracts", async () => {
    harness = await createReactDomHarness();
    const button = createRef<HTMLButtonElement>();
    const icon = createRef<HTMLButtonElement>();
    await harness.render(createElement("div", null,
      createElement(DocsButton, { ref: button, loading: true, variant: "primary" }, "Save"),
      createElement(DocsIconButton, { ref: icon, icon: X, label: "Close editor", active: true }),
    ));
    expect(getReactProps(button.current)?.disabled).toBe(true);
    expect(getReactProps(button.current)?.type).toBe("button");
    expect(getReactProps(button.current)?.className).toContain(DS.button.variant.primary);
    expect(getReactProps(icon.current)?.["aria-label"]).toBe("Close editor");
    expect(getReactProps(icon.current)?.className).toContain(DS.row.selected);
  });
});
