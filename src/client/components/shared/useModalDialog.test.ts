import { StrictMode, createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { createReactDomHarness } from "../../test-react-harness";
import {
  createKeyEventDom,
  findDialogElements,
  resolveAccessibleName,
} from "../../test-modal-dialog-dom";
import { useModalDialog, type ModalDialogOptions } from "./useModalDialog";

interface TestDialogProps extends ModalDialogOptions {
  heading?: string;
}

function TestDialog({ heading = "Test dialog", ...options }: TestDialogProps) {
  const { titleId, dialogProps } = useModalDialog(options);
  if (options.open === false) return null;
  return createElement("div", dialogProps, createElement("h2", { id: titleId }, heading));
}

async function renderDialogs(children: unknown) {
  const keyEventDom = createKeyEventDom();
  const harness = await createReactDomHarness({ installDom: keyEventDom.installDom });
  await harness.render(children as any);
  return {
    harness,
    keydownListenerCount: keyEventDom.keydownListenerCount,
    dispatchKey: async (key: string, options?: { defaultPrevented?: boolean }) => {
      await harness.act(async () => {
        keyEventDom.dispatchKeyDown(key, options);
      });
    },
  };
}

const dialog = (props: TestDialogProps & { key: string }) => createElement(TestDialog, props);

describe("useModalDialog", () => {
  it("names the dialog from its heading, or from an explicit label", async () => {
    const { harness } = await renderDialogs(createElement("div", null, [
      dialog({ onDismiss: vi.fn(), heading: "Session Plan", key: "headed" }),
      dialog({ onDismiss: vi.fn(), label: "Change session model", key: "labelled" }),
    ]));
    try {
      const [headed, labelled] = findDialogElements(harness.dom.container);
      expect(headed.getAttribute("aria-modal")).toBe("true");
      expect(headed.getAttribute("aria-labelledby")).toBeTruthy();
      expect(resolveAccessibleName(harness.dom.container, headed)).toBe("Session Plan");

      expect(labelled.getAttribute("aria-labelledby")).toBeNull();
      expect(resolveAccessibleName(harness.dom.container, labelled)).toBe("Change session model");
    } finally {
      await harness.cleanup();
    }
  });

  it("dismisses only the topmost overlay, then hands Escape back when it closes", async () => {
    const onDismissBottom = vi.fn();
    const onDismissTop = vi.fn();
    const bottom = dialog({ onDismiss: onDismissBottom, heading: "Bottom", key: "bottom" });
    const { harness, dispatchKey } = await renderDialogs(createElement("div", null, [
      bottom,
      dialog({ onDismiss: onDismissTop, heading: "Top", key: "top" }),
    ]));
    try {
      await dispatchKey("Escape");
      expect(onDismissTop).toHaveBeenCalledTimes(1);
      expect(onDismissBottom).not.toHaveBeenCalled();

      await harness.render(createElement("div", null, [bottom]));
      await dispatchKey("Escape");
      expect(onDismissBottom).toHaveBeenCalledTimes(1);
      expect(onDismissTop).toHaveBeenCalledTimes(1);
    } finally {
      await harness.cleanup();
    }
  });

  it("swallows Escape while the topmost overlay is not dismissible, and tracks prop updates", async () => {
    const onDismissBottom = vi.fn();
    const staleDismiss = vi.fn();
    const freshDismiss = vi.fn();
    const renderTree = (dismissible: boolean, onDismiss: () => void) => createElement("div", null, [
      dialog({ onDismiss: onDismissBottom, heading: "Bottom", key: "bottom" }),
      dialog({ onDismiss, heading: "Top", key: "top", dismissible }),
    ]);
    const { harness, dispatchKey } = await renderDialogs(renderTree(false, staleDismiss));
    try {
      await dispatchKey("Escape");
      expect(staleDismiss).not.toHaveBeenCalled();
      expect(onDismissBottom).not.toHaveBeenCalled();

      // Rerendering must refresh both the guard and the callback on the stack entry.
      await harness.render(renderTree(true, freshDismiss));
      await dispatchKey("Escape");
      expect(freshDismiss).toHaveBeenCalledTimes(1);
      expect(staleDismiss).not.toHaveBeenCalled();
      expect(onDismissBottom).not.toHaveBeenCalled();
    } finally {
      await harness.cleanup();
    }
  });

  it("ignores closed overlays, other keys, and an Escape another handler consumed", async () => {
    const onDismiss = vi.fn();
    const onDismissClosed = vi.fn();
    const { harness, dispatchKey } = await renderDialogs(createElement("div", null, [
      dialog({ onDismiss, key: "open" }),
      dialog({ onDismiss: onDismissClosed, key: "closed", open: false }),
    ]));
    try {
      expect(findDialogElements(harness.dom.container)).toHaveLength(1);

      await dispatchKey("Enter");
      await dispatchKey("Escape", { defaultPrevented: true });
      expect(onDismiss).not.toHaveBeenCalled();

      await dispatchKey("Escape");
      expect(onDismiss).toHaveBeenCalledTimes(1);
      expect(onDismissClosed).not.toHaveBeenCalled();
    } finally {
      await harness.cleanup();
    }
  });

  it("keeps exactly one document listener across StrictMode, teardown, and reopen", async () => {
    const onDismiss = vi.fn();
    const reopened = vi.fn();
    const { harness, dispatchKey, keydownListenerCount } = await renderDialogs(
      createElement(StrictMode, null, dialog({ onDismiss, key: "strict" })),
    );
    try {
      expect(keydownListenerCount()).toBe(1);
      await dispatchKey("Escape");
      expect(onDismiss).toHaveBeenCalledTimes(1);

      await harness.render(createElement("div", null, "no overlays"));
      expect(keydownListenerCount()).toBe(0);
      await dispatchKey("Escape");
      expect(onDismiss).toHaveBeenCalledTimes(1);

      await harness.render(dialog({ onDismiss: reopened, key: "reopened" }));
      expect(keydownListenerCount()).toBe(1);
      await dispatchKey("Escape");
      expect(reopened).toHaveBeenCalledTimes(1);
    } finally {
      await harness.cleanup();
    }
  });
});
