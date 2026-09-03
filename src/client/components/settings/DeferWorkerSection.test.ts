import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import type { AppSettings } from "../../api";
import {
  createReactDomHarness,
  findAllByTag,
  getReactProps,
} from "../../test-react-harness";
import { installDomShim } from "../../test-dom-shim";

const queryMocks = vi.hoisted(() => ({
  useModelsQuery: vi.fn(),
}));

vi.mock("../../hooks/queries/useModels", () => ({
  useModelsQuery: () => queryMocks.useModelsQuery(),
}));

const { DeferWorkerSection } = await import("./DeferWorkerSection");

function installSelectAwareDomShim() {
  const dom = installDomShim();
  const documentRef = globalThis.document as typeof globalThis.document & {
    createElement: (tag: string) => any;
  };
  const originalCreateElement = documentRef.createElement.bind(documentRef);
  documentRef.createElement = (tag: string) => {
    const element = originalCreateElement(tag);
    const normalizedTag = tag.toUpperCase();
    if (normalizedTag === "SELECT") {
      Object.defineProperty(element, "options", {
        configurable: true,
        get: () => Array.from(element.childNodes ?? [])
          .filter((child: any) => child.tagName === "OPTION"),
      });
    }
    if (normalizedTag === "OPTION") {
      Object.defineProperty(element, "value", {
        configurable: true,
        get: () => element.getAttribute("value") ?? element.textContent ?? "",
        set: (value) => element.setAttribute("value", String(value)),
      });
      Object.defineProperty(element, "selected", {
        configurable: true,
        writable: true,
        value: false,
      });
    }
    return element;
  };
  return dom;
}

describe("DeferWorkerSection", () => {
  it("renders model, context, and effort settings and updates the shared draft", async () => {
    queryMocks.useModelsQuery.mockReturnValue({
      data: [{
        id: "small-model",
        name: "Small Model",
        supportedReasoningEfforts: ["low", "high"],
        billing: {
          tokenPrices: {
            contextMax: 128_000,
            longContext: { contextMax: 512_000 },
          },
        },
      }],
    });
    const draft: AppSettings = {
      mcpServers: {},
      deferWorker: {
        reasoningEffort: "low",
        contextTier: "default",
      },
    };
    const setDraft = vi.fn();
    const harness = await createReactDomHarness({ installDom: installSelectAwareDomShim });
    await harness.render(createElement(DeferWorkerSection, { draft, setDraft }));

    expect(harness.dom.container.textContent).toContain("Deferred Work");
    expect(harness.dom.container.textContent).toContain("Automatic (economy model when available)");
    const selects = findAllByTag(harness.dom.container, "SELECT");
    expect(selects).toHaveLength(3);

    await harness.act(async () => {
      getReactProps(selects[0])?.onChange?.({ target: { value: "small-model" } });
    });

    expect(setDraft).toHaveBeenCalledWith({
      ...draft,
      deferWorker: {
        model: "small-model",
        reasoningEffort: "low",
        contextTier: "default",
      },
    });
    await harness.cleanup();
  });
});
