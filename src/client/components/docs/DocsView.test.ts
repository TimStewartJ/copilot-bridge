import { createElement, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import {
  createReactDomHarness,
  findAllByTag,
  getReactProps,
  waitUntilAct,
  type ReactDomHarness,
} from "../../test-react-harness";
import { createKeyEventDom, findDialogElements, resolveAccessibleName } from "../../test-modal-dialog-dom";
import { resetConditionalGetCacheForTests, type DocPage, type DocTreeNode } from "../../api";
import DocsView from "./DocsView";

const tree: DocTreeNode[] = [
  {
    name: "guides",
    type: "folder",
    path: "guides",
    children: [
      { name: "deploy", type: "file", path: "guides/deploy", title: "Deploying", description: "How releases ship.", modified: "2026-04-01T00:00:00.000Z" },
      { name: "rollback", type: "file", path: "guides/rollback", title: "Guides — Rolling back" },
    ],
  },
];

const deployPage: DocPage = {
  path: "guides/deploy",
  title: "Deploying",
  tags: ["release"],
  frontmatter: { title: "Deploying", description: "How releases ship.", tags: ["release"], owner: "core", created: "2026-01-01T00:00:00.000Z", modified: "2026-04-01T00:00:00.000Z" },
  body: "# Deploying\n\nShip it carefully\nacross two lines.\n\n## Steps\n\n- build\n- release\n",
  folder: "guides",
  isDbItem: false,
  isFolderIndex: false,
  created: "2026-01-01T00:00:00.000Z",
  modified: "2026-04-01T00:00:00.000Z",
};

interface RecordedRequest {
  path: string;
  method: string;
  body: unknown;
}

function response(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, statusText: status === 404 ? "Not Found" : "OK", json: async () => body };
}

function stubDocsApi(requests: RecordedRequest[]) {
  vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: { method?: string; body?: string }) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, "");
    const method = init?.method ?? "GET";
    requests.push({ path, method, body: init?.body ? JSON.parse(init.body) : undefined });
    if (path === "/api/docs/tree") return response({ tree, hasRootIndex: false });
    if (path === "/api/tags") return response({ tags: [] });
    if (path === "/api/docs/pages/guides/deploy") {
      return method === "GET" ? response(deployPage) : response({ path: "guides/deploy", success: true });
    }
    if (path.startsWith("/api/docs/pages/")) return response({ error: "Page not found" }, 404);
    return response({});
  }));
}

function createStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

function docsAt(route: string): ReactElement {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return createElement(
    QueryClientProvider,
    { client: queryClient },
    createElement(MemoryRouter, { initialEntries: [route] }, createElement(DocsView)),
  );
}

function text(harness: ReactDomHarness): string {
  return harness.dom.container.textContent ?? "";
}

function findButton(harness: ReactDomHarness, matcher: (props: Record<string, any>, node: any) => boolean) {
  const button = findAllByTag(harness.dom.container, "BUTTON").find((node) => matcher(getReactProps(node) ?? {}, node));
  if (!button) throw new Error("Button not found");
  return button;
}

async function click(harness: ReactDomHarness, matcher: (props: Record<string, any>, node: any) => boolean) {
  const button = findButton(harness, matcher);
  await harness.act(async () => {
    await getReactProps(button)?.onClick?.({ stopPropagation() {}, preventDefault() {}, currentTarget: button });
  });
}

let requests: RecordedRequest[];

beforeEach(() => {
  requests = [];
  resetConditionalGetCacheForTests();
  vi.stubGlobal("localStorage", createStorage());
  stubDocsApi(requests);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("DocsView", () => {
  it("shows a page's title once, with its summary, and titles instead of slugs in the tree", async () => {
    const harness = await createReactDomHarness();
    await harness.render(docsAt("/docs/guides/deploy"));
    await waitUntilAct(harness.act, () => text(harness).includes("Ship it carefully"), { label: "page body" });

    // The body opens with "# Deploying"; the header already shows it, so it must not repeat.
    const titles = findAllByTag(harness.dom.container, "H1").filter((node) => node.textContent?.includes("Deploying"));
    expect(titles).toHaveLength(1);
    expect(text(harness)).toContain("How releases ship.");

    // Hard-wrapped source lines flow as one paragraph rather than breaking at the wrap column.
    expect(findAllByTag(harness.dom.container, "BR")).toHaveLength(0);

    const steps = findAllByTag(harness.dom.container, "H2").find((node) => node.textContent?.startsWith("Steps"));
    expect(steps?.getAttribute("id")).toBe("steps");

    const treeLabels = findAllByTag(harness.dom.container, "BUTTON")
      .filter((node) => typeof getReactProps(node)?.["data-row-key"] === "string")
      .map((node) => node.textContent);
    expect(treeLabels).toEqual(["guides", "Deploying", "Rolling back"]);
  });

  it("gives a folder without an index page an overview, so every breadcrumb leads somewhere", async () => {
    const harness = await createReactDomHarness();
    await harness.render(docsAt("/docs/guides"));
    await waitUntilAct(harness.act, () => text(harness).includes("New page here"), { label: "folder overview" });

    expect(text(harness)).toContain("2 items");
    expect(text(harness)).toContain("How releases ship.");
    expect(text(harness)).not.toContain("There is no page here");
  });

  it("says so when a page does not exist instead of showing an empty screen", async () => {
    const harness = await createReactDomHarness();
    await harness.render(docsAt("/docs/guides/nope"));
    await waitUntilAct(harness.act, () => text(harness).includes("There is no page here"), { label: "not found" });

    expect(text(harness)).toContain("guides/nope");
    expect(text(harness)).toContain("Create this page");
  });

  it("saves structured fields with the revision it edited, keeping frontmatter it does not manage", async () => {
    const harness = await createReactDomHarness();
    await harness.render(docsAt("/docs/guides/deploy"));
    await waitUntilAct(harness.act, () => text(harness).includes("Ship it carefully"), { label: "page body" });

    await click(harness, (_props, node) => node.textContent?.trim() === "Edit");
    const titleInput = findAllByTag(harness.dom.container, "INPUT").find((node) => getReactProps(node)?.value === "Deploying");
    if (!titleInput) throw new Error("Title input not found");
    expect(getReactProps(findButton(harness, (_props, node) => node.textContent?.trim() === "Save changes"))?.disabled).toBe(true);

    await harness.act(async () => {
      getReactProps(titleInput)?.onChange?.({ target: { value: "Deploying: the safe way" } });
    });
    await click(harness, (_props, node) => node.textContent?.trim() === "Save changes");
    await waitUntilAct(harness.act, () => requests.some((request) => request.method === "PUT"), { label: "save request" });

    const save = requests.find((request) => request.method === "PUT");
    expect(save?.path).toBe("/api/docs/pages/guides/deploy");
    expect(save?.body).toEqual({
      frontmatter: {
        title: "Deploying: the safe way",
        description: "How releases ship.",
        tags: ["release"],
        owner: "core",
        created: "2026-01-01T00:00:00.000Z",
        modified: "2026-04-01T00:00:00.000Z",
      },
      // The leading H1 mirrored the old title, so it follows the new one.
      body: "# Deploying: the safe way\n\nShip it carefully\nacross two lines.\n\n## Steps\n\n- build\n- release\n",
      baseModified: "2026-04-01T00:00:00.000Z",
    });
  });

  it("opens new-page as a named modal dialog that Escape closes", async () => {
    const keyEventDom = createKeyEventDom();
    const harness = await createReactDomHarness({ installDom: keyEventDom.installDom });
    await harness.render(docsAt("/docs/guides/deploy"));
    await waitUntilAct(harness.act, () => text(harness).includes("Ship it carefully"), { label: "page body" });

    await click(harness, (props) => props["aria-label"] === "New page");
    const dialogs = findDialogElements(harness.dom.container);
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0].getAttribute("aria-modal")).toBe("true");
    expect(resolveAccessibleName(harness.dom.container, dialogs[0])).toBe("New page");
    // It starts in the folder the reader is in.
    expect(findAllByTag(dialogs[0], "INPUT").some((node) => getReactProps(node)?.value === "guides")).toBe(true);

    await harness.act(async () => {
      keyEventDom.dispatchKeyDown("Escape");
    });
    expect(findDialogElements(harness.dom.container)).toHaveLength(0);
  });
});
