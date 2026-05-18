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
  requestAnimationFrame: (cb: (ts: number) => void) => ReturnType<typeof setTimeout>;
  cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => void;
  HTMLElement: typeof HTMLElement;
  Element: typeof Element;
  HTMLIFrameElement: typeof HTMLIFrameElement;
  SVGElement: typeof SVGElement;
  Node: typeof Node;
  Text: typeof Text;
  Comment: typeof Comment;
};

type RestorableGlobalKeys =
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

export function installDomShim() {
  const originals = new Map<RestorableGlobalKeys, PropertyDescriptor | undefined>();
  const remember = (key: RestorableGlobalKeys) => {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  };
  for (const key of [
    "document",
    "window",
    "navigator",
    "HTMLElement",
    "Element",
    "HTMLIFrameElement",
    "SVGElement",
    "Node",
    "Text",
    "Comment",
  ] satisfies RestorableGlobalKeys[]) {
    remember(key);
  }

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

  const windowObject: FakeWindow = {
    document,
    navigator: { userAgent: "node" },
    addEventListener() {},
    removeEventListener() {},
    getComputedStyle: () => ({}),
    requestAnimationFrame: (cb) => setTimeout(() => cb(Date.now()), 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    HTMLElement: function HTMLElement() {} as typeof HTMLElement,
    Element: function Element() {} as typeof Element,
    HTMLIFrameElement: function HTMLIFrameElement() {} as typeof HTMLIFrameElement,
    SVGElement: function SVGElement() {} as typeof SVGElement,
    Node: function Node() {} as typeof Node,
    Text: function Text() {} as typeof Text,
    Comment: function Comment() {} as typeof Comment,
  };

  document.body = container;
  document.documentElement = html;
  document.defaultView = windowObject;
  const actEnvironmentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");

  const installGlobal = (key: RestorableGlobalKeys, value: unknown) => {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  };

  installGlobal("document", document);
  installGlobal("window", windowObject);
  installGlobal("navigator", windowObject.navigator);
  installGlobal("HTMLElement", windowObject.HTMLElement);
  installGlobal("Element", windowObject.Element);
  installGlobal("HTMLIFrameElement", windowObject.HTMLIFrameElement);
  installGlobal("SVGElement", windowObject.SVGElement);
  installGlobal("Node", windowObject.Node);
  installGlobal("Text", windowObject.Text);
  installGlobal("Comment", windowObject.Comment);
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    writable: true,
    value: true,
  });

  return {
    container,
    cleanup() {
      for (const [key, descriptor] of originals) {
        if (!descriptor) {
          delete (globalThis as any)[key];
        } else {
          Object.defineProperty(globalThis, key, descriptor);
        }
      }
      if (!actEnvironmentDescriptor) {
        delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
      } else {
        Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironmentDescriptor);
      }
    },
  };
}
