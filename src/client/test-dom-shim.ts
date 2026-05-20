type FakeNode = {
  nodeType: number;
  ownerDocument: FakeDocument;
  parentNode: FakeNode | null;
  childNodes: FakeNode[];
  appendChild: (child: FakeNode) => FakeNode;
  removeChild: (child: FakeNode) => FakeNode;
  insertBefore: (child: FakeNode, before: FakeNode | null) => FakeNode;
  contains: (target: FakeNode | null) => boolean;
  textContent?: string;
  nodeValue?: string;
};

type FakeTextNode = FakeNode & {
  data: string;
};

type FakeElement = FakeNode & {
  tagName: string;
  nodeName: string;
  namespaceURI: string;
  style: Record<string, string>;
  attributes: Record<string, string>;
  dataset: Record<string, string>;
  addEventListener: () => void;
  removeEventListener: () => void;
  setAttribute: (name: string, value: string) => void;
  removeAttribute: (name: string) => void;
  setAttributeNS: (_ns: string | null, name: string, value: string) => void;
  removeAttributeNS: (_ns: string | null, name: string) => void;
  getAttribute: (name: string) => string | null;
  focus: () => void;
  blur: () => void;
  getBoundingClientRect: () => DOMRect;
  firstChild: FakeNode | null;
  lastChild: FakeNode | null;
};

type FakeDocument = {
  nodeType: number;
  activeElement: FakeElement | null;
  body: FakeElement | null;
  documentElement: FakeElement | null;
  defaultView: FakeWindow | null;
  addEventListener: () => void;
  removeEventListener: () => void;
  createElement: (tag: string) => FakeElement;
  createElementNS: (_ns: string, tag: string) => FakeElement;
  createTextNode: (text: string) => FakeTextNode;
  createComment: (text: string) => FakeTextNode;
  createDocumentFragment: () => FakeNode;
};

type FakeWindow = {
  document: FakeDocument;
  navigator: { userAgent: string };
  addEventListener: () => void;
  removeEventListener: () => void;
  getComputedStyle: () => Record<string, string>;
  requestAnimationFrame: (cb: (ts: number) => void) => number;
  cancelAnimationFrame: (id: number) => void;
  HTMLElement: typeof HTMLElement;
  Element: typeof Element;
  HTMLIFrameElement: typeof HTMLIFrameElement;
  SVGElement: typeof SVGElement;
  Node: typeof Node;
  Text: typeof Text;
  Comment: typeof Comment;
};

type ShimGlobalKey =
  | "document"
  | "window"
  | "navigator"
  | "HTMLElement"
  | "Element"
  | "HTMLIFrameElement"
  | "SVGElement"
  | "Node"
  | "Text"
  | "Comment";

type DescriptorSnapshot = Map<PropertyKey, PropertyDescriptor>;

type DomShimState = {
  document: FakeDocument;
  windowObject: FakeWindow;
  navigator: FakeWindow["navigator"];
  createElement: (tag: string) => FakeElement;
  documentSnapshot: DescriptorSnapshot;
  windowSnapshot: DescriptorSnapshot;
  navigatorSnapshot: DescriptorSnapshot;
  activeContainers: Set<FakeElement>;
};

type DomShimGlobal = typeof globalThis & {
  __copilotBridgeDomShimState?: DomShimState;
};

function createBaseNode(nodeType: number, ownerDocument: FakeDocument): FakeNode {
  return {
    nodeType,
    ownerDocument,
    parentNode: null,
    childNodes: [],
    appendChild(child) {
      child.parentNode = this;
      this.childNodes.push(child);
      return child;
    },
    removeChild(child) {
      const index = this.childNodes.indexOf(child);
      if (index >= 0) {
        this.childNodes.splice(index, 1);
      }
      child.parentNode = null;
      return child;
    },
    insertBefore(child, before) {
      const index = before ? this.childNodes.indexOf(before) : -1;
      child.parentNode = this;
      if (index >= 0) {
        this.childNodes.splice(index, 0, child);
      } else {
        this.childNodes.push(child);
      }
      return child;
    },
    contains(target) {
      if (!target) return false;
      if (target === this) return true;
      return this.childNodes.some((child) => child.contains(target));
    },
  };
}

function defineTextNodeTextAccessors(node: FakeTextNode) {
  let value = node.data;
  Object.defineProperty(node, "data", {
    configurable: true,
    enumerable: true,
    get: () => value,
    set: (next: string) => {
      value = String(next);
    },
  });
  Object.defineProperty(node, "nodeValue", {
    configurable: true,
    enumerable: true,
    get: () => value,
    set: (next: string | undefined) => {
      value = String(next ?? "");
    },
  });
  Object.defineProperty(node, "textContent", {
    configurable: true,
    enumerable: true,
    get: () => value,
    set: (next: string | undefined) => {
      value = String(next ?? "");
    },
  });
}

function resetNode(node: FakeNode) {
  for (const child of node.childNodes) {
    child.parentNode = null;
  }
  node.childNodes = [];
}

function snapshotObject(object: object): DescriptorSnapshot {
  const snapshot: DescriptorSnapshot = new Map();
  for (const key of Reflect.ownKeys(object)) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (descriptor) snapshot.set(key, descriptor);
  }
  return snapshot;
}

function restoreObject(object: object, snapshot: DescriptorSnapshot) {
  const target = object as Record<PropertyKey, unknown>;
  for (const key of Reflect.ownKeys(object)) {
    if (!snapshot.has(key)) {
      delete target[key];
    }
  }
  for (const [key, descriptor] of snapshot) {
    Object.defineProperty(object, key, descriptor);
  }
}

function createFakeConstructor<T>(): T {
  return function FakeConstructor() {} as unknown as T;
}

function createDomShimState(): DomShimState {
  const document: FakeDocument = {
    nodeType: 9,
    activeElement: null,
    body: null,
    documentElement: null,
    defaultView: null,
    addEventListener() {},
    removeEventListener() {},
    createElement: undefined as never,
    createElementNS: undefined as never,
    createTextNode: undefined as never,
    createComment: undefined as never,
    createDocumentFragment: undefined as never,
  };

  document.createTextNode = (text: string) => {
    const node = {
      ...createBaseNode(3, document),
      data: text,
    } as FakeTextNode;
    defineTextNodeTextAccessors(node);
    return node;
  };

  document.createComment = (text: string) => {
    const node = {
      ...createBaseNode(8, document),
      data: text,
    } as FakeTextNode;
    defineTextNodeTextAccessors(node);
    return node;
  };

  document.createDocumentFragment = () => createBaseNode(11, document);

  const createElement = (tag: string): FakeElement => {
    const element = {
      ...createBaseNode(1, document),
      tagName: tag.toUpperCase(),
      nodeName: tag.toUpperCase(),
      namespaceURI: "http://www.w3.org/1999/xhtml",
      style: {},
      attributes: {},
      dataset: {},
      addEventListener() {},
      removeEventListener() {},
      setAttribute(name: string, value: string) {
        this.attributes[name] = String(value);
      },
      removeAttribute(name: string) {
        delete this.attributes[name];
      },
      setAttributeNS(_ns: string | null, name: string, value: string) {
        this.setAttribute(name, value);
      },
      removeAttributeNS(_ns: string | null, name: string) {
        this.removeAttribute(name);
      },
      getAttribute(name: string) {
        return this.attributes[name] ?? null;
      },
      focus() {
        document.activeElement = this;
      },
      blur() {
        if (document.activeElement === this) {
          document.activeElement = null;
        }
      },
      getBoundingClientRect() {
        return {
          x: 0,
          y: 0,
          width: 0,
          height: 0,
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          toJSON: () => ({}),
        } as DOMRect;
      },
      get firstChild() {
        return this.childNodes[0] ?? null;
      },
      get lastChild() {
        return this.childNodes[this.childNodes.length - 1] ?? null;
      },
    } as FakeElement;

    Object.defineProperty(element, "textContent", {
      configurable: true,
      enumerable: true,
      get: () => element.childNodes.map((child) => child.textContent ?? child.nodeValue ?? "").join(""),
      set: (value: string | undefined) => {
        const next = String(value ?? "");
        resetNode(element);
        element.childNodes = next ? [document.createTextNode(next)] : [];
        for (const child of element.childNodes) {
          child.parentNode = element;
        }
      },
    });

    return element;
  };

  document.createElement = createElement;
  document.createElementNS = (_ns: string, tag: string) => createElement(tag);

  const container = createElement("div");
  const html = createElement("html");
  const navigator = { userAgent: "node" };
  let animationFrameId = 0;
  const pendingAnimationFrames = new Set<number>();

  const windowObject: FakeWindow = {
    document,
    navigator,
    addEventListener() {},
    removeEventListener() {},
    getComputedStyle: () => ({}),
    requestAnimationFrame: (cb) => {
      const id = animationFrameId += 1;
      pendingAnimationFrames.add(id);
      queueMicrotask(() => {
        if (!pendingAnimationFrames.delete(id)) return;
        cb(Date.now());
      });
      return id;
    },
    cancelAnimationFrame: (id) => {
      pendingAnimationFrames.delete(id);
    },
    HTMLElement: createFakeConstructor<typeof HTMLElement>(),
    Element: createFakeConstructor<typeof Element>(),
    HTMLIFrameElement: createFakeConstructor<typeof HTMLIFrameElement>(),
    SVGElement: createFakeConstructor<typeof SVGElement>(),
    Node: createFakeConstructor<typeof Node>(),
    Text: createFakeConstructor<typeof Text>(),
    Comment: createFakeConstructor<typeof Comment>(),
  };

  document.body = container;
  document.documentElement = html;
  document.defaultView = windowObject;

  return {
    document,
    windowObject,
    navigator,
    createElement,
    documentSnapshot: snapshotObject(document),
    windowSnapshot: snapshotObject(windowObject),
    navigatorSnapshot: snapshotObject(navigator),
    activeContainers: new Set(),
  };
}

function getDomShimState(): DomShimState {
  const shimGlobal = globalThis as DomShimGlobal;
  shimGlobal.__copilotBridgeDomShimState ??= createDomShimState();
  return shimGlobal.__copilotBridgeDomShimState;
}

function installGlobal(key: ShimGlobalKey, value: unknown) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value,
  });
}

function installSingletonGlobals(state: DomShimState) {
  installGlobal("document", state.document);
  installGlobal("window", state.windowObject);
  installGlobal("navigator", state.navigator);
  installGlobal("HTMLElement", state.windowObject.HTMLElement);
  installGlobal("Element", state.windowObject.Element);
  installGlobal("HTMLIFrameElement", state.windowObject.HTMLIFrameElement);
  installGlobal("SVGElement", state.windowObject.SVGElement);
  installGlobal("Node", state.windowObject.Node);
  installGlobal("Text", state.windowObject.Text);
  installGlobal("Comment", state.windowObject.Comment);
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    writable: true,
    value: true,
  });
}

function resetSingletonDom(state: DomShimState): FakeElement {
  restoreObject(state.document, state.documentSnapshot);
  restoreObject(state.windowObject, state.windowSnapshot);
  restoreObject(state.navigator, state.navigatorSnapshot);

  const container = state.createElement("div");
  const html = state.createElement("html");
  state.document.activeElement = null;
  state.document.body = container;
  state.document.documentElement = html;
  state.document.defaultView = state.windowObject;
  installSingletonGlobals(state);
  return container;
}

export function installDomShim() {
  const state = getDomShimState();
  if (state.activeContainers.size > 0) {
    throw new Error("installDomShim does not support overlapping active DOM shims");
  }
  const container = resetSingletonDom(state);
  state.activeContainers.add(container);
  let cleanedUp = false;

  return {
    container,
    cleanup() {
      if (cleanedUp) return;
      cleanedUp = true;
      state.activeContainers.delete(container);
      resetNode(container);
      if (state.document.body === container) {
        resetSingletonDom(state);
      }
    },
  };
}
