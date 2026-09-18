import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  createReactDomHarness,
  findAllByTag,
  getReactProps,
} from "../../test-react-harness";
import { installSelectAwareDomShim } from "../../test-dom-shim";

const { ServerEditor } = await import("./ServerEditor");

describe("ServerEditor save", () => {
  it("keeps stored config fields the form does not show", async () => {
    const onSave = vi.fn();
    const stored = { command: "node", args: ["teams.js"], tools: ["*"], deferTools: "never" };
    const harness = await createReactDomHarness({ installDom: installSelectAwareDomShim });
    await harness.render(createElement(ServerEditor, {
      name: "teams",
      config: stored,
      existingNames: [],
      onSave,
      onCancel: vi.fn(),
    }));

    const update = findAllByTag(harness.dom.container, "BUTTON")
      .find((button) => button.textContent === "Update");
    if (!update) throw new Error("Update button not found");
    await harness.act(async () => {
      getReactProps(update)?.onClick?.();
    });

    expect(onSave).toHaveBeenCalledWith(
      { command: "node", args: ["teams.js"], tools: ["*"], executionScope: "auto", deferTools: "never" },
      "teams",
    );
  });
});
