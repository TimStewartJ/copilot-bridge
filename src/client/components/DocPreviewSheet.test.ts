import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReactDomHarness, findAllByTag, getReactProps, waitUntilAct } from "../test-react-harness";
import { resetConditionalGetCacheForTests, type DocPage } from "../api";
import DocPreviewSheet from "./DocPreviewSheet";

function page(path: string, body: string): DocPage {
  return {
    path, body, title: path, tags: [], frontmatter: {}, folder: "guides",
    isDbItem: false, isFolderIndex: false,
    created: "2026-10-09T00:00:00.000Z", modified: "2026-10-09T00:00:00.000Z",
  };
}

beforeEach(() => {
  resetConditionalGetCacheForTests();
  vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
    const path = String(input);
    let body: unknown = {};
    let status = 200;
    if (path === "/api/docs/tree") body = { tree: [], hasRootIndex: false };
    if (path === "/api/docs/resolve") body = { "guides/child": { path: "guides/child", title: "Child" } };
    if (path === "/api/docs/pages/guides/parent") body = page("guides/parent", "# Parent\n\nSee [[guides/child|child page]].");
    if (path === "/api/docs/pages/guides/child") body = page("guides/child", "# Child\n\nChild body.");
    if (path === "/api/docs/pages/missing") { status = 404; body = { error: "Page not found" }; }
    return { ok: status === 200, status, statusText: status === 404 ? "Not Found" : "OK", json: async () => body };
  }));
});

afterEach(() => vi.unstubAllGlobals());

async function renderPreview(path: string) {
  const harness = await createReactDomHarness();
  const onClose = vi.fn();
  const onOpenFull = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await harness.render(createElement(QueryClientProvider, { client },
    createElement(MemoryRouter, null, createElement(DocPreviewSheet, { docPath: path, onClose, onOpenFull }))));
  return { ...harness, onClose, onOpenFull };
}

describe("DocPreviewSheet", () => {
  it("uses one scrim behind the dialog and dismisses only clicks on that background", async () => {
    const harness = await renderPreview("guides/parent");
    const scrims = findAllByTag(harness.dom.container, "DIV").filter((node) => (
      getReactProps(node)?.className?.includes("fixed inset-0 z-50")
    ));
    expect(scrims).toHaveLength(1);
    const [scrim] = scrims;
    const [section] = findAllByTag(harness.dom.container, "SECTION");
    expect(scrim.contains(section)).toBe(true);
    await harness.act(() => getReactProps(scrim)?.onClick({ target: section, currentTarget: scrim }));
    expect(harness.onClose).not.toHaveBeenCalled();
    await harness.act(() => getReactProps(scrim)?.onClick({ target: scrim, currentTarget: scrim }));
    expect(harness.onClose).toHaveBeenCalledOnce();
  });

  it("keeps nested links in one preview, supports previous, and opens the current page in full", async () => {
    const harness = await renderPreview("guides/parent");
    await waitUntilAct(harness.act, () => findAllByTag(harness.dom.container, "A").some((node) => node.textContent === "child page"));
    const link = findAllByTag(harness.dom.container, "A").find((node) => node.textContent === "child page");
    await harness.act(() => getReactProps(link)?.onClick({ button: 0, preventDefault: vi.fn() }));
    await waitUntilAct(harness.act, () => harness.dom.container.textContent?.includes("Child body.") ?? false);
    expect(findAllByTag(harness.dom.container, "SECTION")).toHaveLength(1);
    const previous = findAllByTag(harness.dom.container, "BUTTON").find((node) => getReactProps(node)?.["aria-label"] === "Previous preview");
    await harness.act(() => getReactProps(previous)?.onClick());
    await waitUntilAct(harness.act, () => harness.dom.container.textContent?.includes("child page") ?? false);
    const full = findAllByTag(harness.dom.container, "BUTTON").find((node) => node.textContent?.includes("Open full"));
    await harness.act(() => getReactProps(full)?.onClick());
    expect(harness.onOpenFull).toHaveBeenCalledWith("guides/parent", "");
    expect(harness.onClose).not.toHaveBeenCalled();
  });

  it("shows a missing page explicitly instead of leaving old content in the sheet", async () => {
    const harness = await renderPreview("missing");
    await waitUntilAct(harness.act, () => harness.dom.container.textContent?.includes("Page not found") ?? false);
    expect(harness.dom.container.textContent).not.toContain("Child body.");
    const close = findAllByTag(harness.dom.container, "BUTTON").find((node) => getReactProps(node)?.["aria-label"] === "Close doc preview");
    await harness.act(() => getReactProps(close)?.onClick());
    expect(harness.onClose).toHaveBeenCalledOnce();
  });
});
