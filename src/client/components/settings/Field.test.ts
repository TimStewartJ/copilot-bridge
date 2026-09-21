import { createElement, createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { createReactDomHarness, findAllByTag, getReactProps } from "../../test-react-harness";
import { Field } from "./Field";

describe("settings field labels and validation", () => {
  it("associates a generated label without losing the native ref or change handler", async () => {
    const harness = await createReactDomHarness();
    const ref = createRef<HTMLInputElement>();
    const change = vi.fn();
    await harness.render(createElement(Field, {
      label: "Server name",
      children: createElement("input", { ref, onChange: change }),
    }));
    const input = findAllByTag(harness.dom.container, "INPUT")[0];
    const label = findAllByTag(harness.dom.container, "LABEL")[0];
    expect(getReactProps(label)?.htmlFor).toBe(getReactProps(input)?.id);
    expect(getReactProps(input)?.id).toBeTruthy();
    expect(ref.current).toBe(input);
    await harness.act(async () => { getReactProps(input)?.onChange?.({ target: { value: "local" } }); });
    expect(change).toHaveBeenCalledOnce();
  });

  it("preserves supplied ids and connects an error alongside existing help", async () => {
    const harness = await createReactDomHarness();
    await harness.render(createElement(Field, {
      label: "Endpoint",
      error: "Enter a valid URL",
      children: createElement("input", { id: "endpoint", "aria-describedby": "endpoint-help" }),
    }));
    const props = getReactProps(findAllByTag(harness.dom.container, "INPUT")[0]);
    expect(props?.id).toBe("endpoint");
    expect(props?.["aria-invalid"]).toBe(true);
    expect(props?.["aria-describedby"]).toBe("endpoint-help endpoint-error");
    const error = getReactProps(findAllByTag(harness.dom.container, "P")[0]);
    expect(error?.id).toBe("endpoint-error");
    expect(error?.role).toBe("alert");
  });
});
