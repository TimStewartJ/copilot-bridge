import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReactDomHarness, findAllByTag, getReactProps, waitUntilAct } from "../test-react-harness";
import { resetConditionalGetCacheForTests } from "../api";
import MessageBubble from "./MessageBubble";
import CompletionCard from "./CompletionCard";
import { BridgeReferenceContext } from "./BridgeReference";

beforeEach(() => {
  resetConditionalGetCacheForTests();
  vi.stubGlobal("fetch", vi.fn(async (input: unknown) => ({
    ok: true, status: 200,
    json: async () => String(input).includes("/docs/resolve")
      ? { alias: { path: "guides/deploy", title: "Deploying" }, missing: null }
      : { tasks: [], sessions: [] },
  })));
});

afterEach(() => vi.unstubAllGlobals());

async function renderContent(content: string, completion = false) {
  const harness = await createReactDomHarness();
  const onOpenDoc = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const element = completion
    ? createElement(CompletionCard, { entry: { type: "completion", content, completion: { content, title: "Done", status: "success", sourceEventType: "session.task_complete" } } })
    : createElement(MessageBubble, { message: { role: "assistant", content } });
  await harness.render(createElement(QueryClientProvider, { client }, createElement(MemoryRouter, null,
    createElement(BridgeReferenceContext.Provider, { value: { onOpenDoc } }, element))));
  return { ...harness, onOpenDoc };
}

describe("Chat doc links", () => {
  it.each([false, true])("resolves wikilinks to canonical doc references in completion=%s", async (completion) => {
    const harness = await renderContent("See [[alias|Deploy guide]].", completion);
    await waitUntilAct(harness.act, () => findAllByTag(harness.dom.container, "A").some((node) => getReactProps(node)?.["data-bridge-reference"] === "doc"));
    const link = findAllByTag(harness.dom.container, "A")[0];
    const props = getReactProps(link)!;
    expect(props.href).toBe("/docs/guides/deploy");
    await harness.act(() => props.onClick({ button: 0, preventDefault: vi.fn() }));
    expect(harness.onOpenDoc).toHaveBeenCalledWith("guides/deploy");
    harness.onOpenDoc.mockClear();
    const preventDefault = vi.fn();
    await harness.act(() => props.onClick({ button: 0, ctrlKey: true, preventDefault }));
    expect(preventDefault).not.toHaveBeenCalled();
    expect(harness.onOpenDoc).not.toHaveBeenCalled();
  });

  it("opens existing bridge doc links through the same preview action", async () => {
    const harness = await renderContent("[Guide](bridge://doc/guides/deploy)");
    const link = findAllByTag(harness.dom.container, "A")[0];
    expect(getReactProps(link)?.["data-bridge-reference-card"]).toBe("true");
    await harness.act(() => getReactProps(link)?.onClick({ button: 0, preventDefault: vi.fn() }));
    expect(harness.onOpenDoc).toHaveBeenCalledWith("guides/deploy");
  });

  it("marks missing wikilinks and leaves code examples literal", async () => {
    const harness = await renderContent("See [[missing|Missing guide]]. Example: `[[alias]]`.");
    await waitUntilAct(harness.act, () => harness.dom.container.textContent?.includes("page not found") ?? false);
    expect(findAllByTag(harness.dom.container, "A")).toHaveLength(0);
    expect(findAllByTag(harness.dom.container, "CODE")[0]?.textContent).toBe("[[alias]]");
  });
});
