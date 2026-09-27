import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReactDomHarness, findAllByTag, getReactProps, type ReactDomHarness } from "../test-react-harness";
import { installDomShim } from "../test-dom-shim";
import NotesSheet from "./NotesSheet";

// The shim's textarea has no value until React writes one; the sheet reads it to place the caret.
function installTextareaAwareDomShim() {
  const dom = installDomShim();
  const documentRef = globalThis.document as typeof globalThis.document & { createElement: (tag: string) => any };
  const originalCreateElement = documentRef.createElement.bind(documentRef);
  documentRef.createElement = (tag: string) => {
    const element: any = originalCreateElement(tag);
    if (tag.toUpperCase() === "TEXTAREA" && element.value === undefined) element.value = "";
    return element;
  };
  return dom;
}

describe("NotesSheet", () => {
  let harness: ReactDomHarness | null = null;

  afterEach(async () => {
    await harness?.cleanup();
    harness = null;
  });

  async function renderEditing(onSave: (text: string) => void | Promise<void>) {
    harness = await createReactDomHarness({ installDom: installTextareaAwareDomShim });
    await harness.render(createElement(NotesSheet, {
      notes: "Old rules",
      title: "Instructions",
      onSave,
      onClose: () => {},
      startInEditMode: true,
    }));
    const container = harness.dom.container as any;
    const textarea = findAllByTag(container, "TEXTAREA")[0];
    await harness.act(async () => { getReactProps(textarea)?.onChange({ target: { value: "New rules" } }); });
    const save = findAllByTag(container, "BUTTON").find((button) => button.textContent === "Save");
    await harness.act(async () => { getReactProps(save)?.onClick(); });
    return container;
  }

  it("keeps the draft open and says why when saving fails", async () => {
    const onSave = vi.fn(async () => { throw new Error("Server said no"); });
    const container = await renderEditing(onSave);
    expect(onSave).toHaveBeenCalledWith("New rules");
    expect(container.textContent).toContain("Editing Instructions");
    expect(container.textContent).toContain("Server said no");
    expect(getReactProps(findAllByTag(container, "TEXTAREA")[0])?.value).toBe("New rules");
  });

  it("leaves edit mode once the save succeeds", async () => {
    const onSave = vi.fn(async () => {});
    const container = await renderEditing(onSave);
    expect(onSave).toHaveBeenCalledWith("New rules");
    expect(findAllByTag(container, "TEXTAREA")).toHaveLength(0);
    expect(container.textContent).not.toContain("Editing Instructions");
  });
});
