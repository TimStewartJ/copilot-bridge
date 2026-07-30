import { installDomShim } from "./test-dom-shim";

type DomShim = ReturnType<typeof installDomShim>;
type DomListener = (event: unknown) => void;

export interface FakeKeyboardEvent {
  type: "keydown";
  key: string;
  defaultPrevented: boolean;
  preventDefault: () => void;
  stopPropagation: () => void;
}

export interface KeyEventDom {
  /** Pass to createReactDomHarness({ installDom }). */
  installDom: () => DomShim;
  /** Dispatch a document-level keydown to listeners registered by components. */
  dispatchKeyDown: (key: string, options?: { defaultPrevented?: boolean }) => void;
  /** How many document keydown listeners are currently attached. */
  keydownListenerCount: () => number;
}

export interface KeyEventDomOptions {
  /** Base shim installer to layer on top of, e.g. installSelectAwareDomShim. */
  baseInstall?: () => DomShim;
}

/**
 * The shared DOM shim intentionally keeps document.addEventListener a no-op, so
 * document-level key handling cannot be observed. This wraps the shim with a
 * real listener registry for the keydown-driven behavior under test.
 */
export function createKeyEventDom(options: KeyEventDomOptions = {}): KeyEventDom {
  const baseInstall = options.baseInstall ?? installDomShim;
  let dispatch: KeyEventDom["dispatchKeyDown"] | null = null;
  let countKeydownListeners: () => number = () => 0;

  const installDom = (): DomShim => {
    const dom = baseInstall();
    const documentRef = globalThis.document as unknown as {
      addEventListener: (type: string, listener: DomListener) => void;
      removeEventListener: (type: string, listener: DomListener) => void;
    };
    const originalAdd = documentRef.addEventListener;
    const originalRemove = documentRef.removeEventListener;
    const listeners = new Map<string, Set<DomListener>>();

    documentRef.addEventListener = (type, listener) => {
      if (typeof listener !== "function") return;
      const listenersForType = listeners.get(type) ?? new Set<DomListener>();
      listenersForType.add(listener);
      listeners.set(type, listenersForType);
    };
    documentRef.removeEventListener = (type, listener) => {
      listeners.get(type)?.delete(listener);
    };

    countKeydownListeners = () => listeners.get("keydown")?.size ?? 0;

    dispatch = (key, options = {}) => {
      const event: FakeKeyboardEvent = {
        type: "keydown",
        key,
        defaultPrevented: options.defaultPrevented ?? false,
        preventDefault() {
          event.defaultPrevented = true;
        },
        stopPropagation() {},
      };
      for (const listener of [...(listeners.get("keydown") ?? [])]) {
        listener(event);
      }
    };

    return {
      container: dom.container,
      cleanup() {
        dispatch = null;
        countKeydownListeners = () => 0;
        listeners.clear();
        documentRef.addEventListener = originalAdd;
        documentRef.removeEventListener = originalRemove;
        dom.cleanup();
      },
    };
  };

  return {
    installDom,
    dispatchKeyDown(key, options) {
      if (!dispatch) throw new Error("dispatchKeyDown requires an installed key-event DOM shim");
      dispatch(key, options);
    },
    keydownListenerCount: () => countKeydownListeners(),
  };
}

/** Collects every element exposing role="dialog" under the given node. */
export function findDialogElements(root: any): any[] {
  const found: any[] = [];
  const visit = (node: any) => {
    if (!node) return;
    if (typeof node.getAttribute === "function" && node.getAttribute("role") === "dialog") {
      found.push(node);
    }
    for (const child of node.childNodes ?? []) visit(child);
  };
  visit(root);
  return found;
}

function findElementById(root: any, id: string): any | null {
  if (!root) return null;
  if (typeof root.getAttribute === "function" && root.getAttribute("id") === id) return root;
  for (const child of root.childNodes ?? []) {
    const match = findElementById(child, id);
    if (match) return match;
  }
  return null;
}

/**
 * Resolves the accessible name of a dialog element the way assistive tech does:
 * aria-labelledby wins and its IDREFs are dereferenced in order, otherwise
 * aria-label is used.
 */
export function resolveAccessibleName(root: any, dialog: any): string {
  const labelledBy = dialog.getAttribute("aria-labelledby");
  if (labelledBy) {
    return labelledBy
      .split(/\s+/)
      .filter(Boolean)
      .map((id: string) => (findElementById(root, id)?.textContent ?? "").trim())
      .filter(Boolean)
      .join(" ");
  }
  return (dialog.getAttribute("aria-label") ?? "").trim();
}
