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

const { SubagentModelsSection } = await import("./SubagentModelsSection");

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

describe("SubagentModelsSection", () => {
  const efforts = ["none", "low", "medium", "high", "xhigh", "max"];
  const models = [
    { id: "gpt-6-luna", name: "GPT-6 Luna", supportedReasoningEfforts: efforts },
    { id: "gpt-6-sol", name: "GPT-6 Sol", supportedReasoningEfforts: efforts },
    { id: "claude-haiku-4.5", name: "Claude Haiku 4.5" },
  ];

  it("shows the Bridge defaults by default and can switch to the CLI settings", async () => {
    queryMocks.useModelsQuery.mockReturnValue({ data: models });
    const draft: AppSettings = { mcpServers: {} };
    const setDraft = vi.fn();
    const harness = await createReactDomHarness({ installDom: installSelectAwareDomShim });
    await harness.render(createElement(SubagentModelsSection, { draft, setDraft }));

    const text = harness.dom.container.textContent ?? "";
    expect(text).toContain("Sub-agent models");
    expect(text).toContain("Bridge default (GPT-6 Luna)");
    expect(text).toContain("Bridge default (GPT-6 Sol)");
    expect(text).toContain("Bridge default (Inherit main session model)");
    expect(text).toContain("Bridge default (Max)");
    expect(text).toContain("Bridge default (High)");
    // Effort cannot be chosen when the model is inherited.
    expect(text).toContain("Follows model");
    const selects = findAllByTag(harness.dom.container, "SELECT");
    // Source plus a model and an effort select for each of seven built-in agents.
    expect(selects).toHaveLength(15);

    await harness.act(async () => {
      getReactProps(selects[0])?.onChange?.({ target: { value: "cli" } });
    });
    expect(setDraft).toHaveBeenCalledWith({ ...draft, subagents: { source: "cli" } });
    await harness.cleanup();
  });

  it("hides per-agent rows while the CLI settings apply", async () => {
    queryMocks.useModelsQuery.mockReturnValue({ data: models });
    const draft: AppSettings = { mcpServers: {}, subagents: { source: "cli", agents: { task: { model: "gpt-6-sol" } } } };
    const setDraft = vi.fn();
    const harness = await createReactDomHarness({ installDom: installSelectAwareDomShim });
    await harness.render(createElement(SubagentModelsSection, { draft, setDraft }));

    const selects = findAllByTag(harness.dom.container, "SELECT");
    expect(selects).toHaveLength(1);
    await harness.act(async () => {
      getReactProps(selects[0])?.onChange?.({ target: { value: "bridge" } });
    });
    // Switching back keeps earlier overrides.
    expect(setDraft).toHaveBeenCalledWith({ ...draft, subagents: { agents: { task: { model: "gpt-6-sol" } } } });
    await harness.cleanup();
  });

  it("keeps a compatible effort when an agent returns to its Bridge default model", async () => {
    queryMocks.useModelsQuery.mockReturnValue({ data: models });
    const draft: AppSettings = {
      mcpServers: {},
      subagents: { agents: { task: { model: "gpt-6-sol", effortLevel: "low" } } },
    };
    const setDraft = vi.fn();
    const harness = await createReactDomHarness({ installDom: installSelectAwareDomShim });
    await harness.render(createElement(SubagentModelsSection, { draft, setDraft }));
    const task = findAllByTag(harness.dom.container, "SELECT")
      .find((select: any) => getReactProps(select)?.id === "subagent-model-task");

    await harness.act(async () => {
      getReactProps(task)?.onChange?.({ target: { value: "" } });
    });
    expect(setDraft).toHaveBeenLastCalledWith({ ...draft, subagents: { agents: { task: { effortLevel: "low" } } } });

    // A model without that effort drops it instead of failing the sub-agent later.
    await harness.act(async () => {
      getReactProps(task)?.onChange?.({ target: { value: "claude-haiku-4.5" } });
    });
    expect(setDraft).toHaveBeenLastCalledWith({ ...draft, subagents: { agents: { task: { model: "claude-haiku-4.5" } } } });
    await harness.cleanup();
  });

  it("stores only overrides and clears the block when the last one is removed", async () => {
    queryMocks.useModelsQuery.mockReturnValue({ data: models });
    const draft: AppSettings = { mcpServers: {}, subagents: { agents: { task: { model: "gpt-5.6-terra" } } } };
    const setDraft = vi.fn();
    const harness = await createReactDomHarness({ installDom: installSelectAwareDomShim });
    await harness.render(createElement(SubagentModelsSection, { draft, setDraft }));

    // A saved model missing from the list stays selectable instead of silently changing.
    expect(harness.dom.container.textContent).toContain("gpt-5.6-terra");
    const selects = findAllByTag(harness.dom.container, "SELECT");
    const find = (name: string) => selects.find((select: any) => getReactProps(select)?.id === `subagent-model-${name}`);
    const findEffort = (name: string) => selects.find((select: any) => getReactProps(select)?.["aria-label"] === `${name} reasoning effort`);

    await harness.act(async () => {
      getReactProps(findEffort("explore"))?.onChange?.({ target: { value: "low" } });
    });
    expect(setDraft).toHaveBeenLastCalledWith({
      ...draft,
      subagents: { agents: { task: { model: "gpt-5.6-terra" }, explore: { effortLevel: "low" } } },
    });
    // A model without configurable effort disables the effort select.
    expect(getReactProps(findEffort("code-review"))?.disabled).toBe(true);

    await harness.act(async () => {
      getReactProps(find("rubber-duck"))?.onChange?.({ target: { value: "runtime-default" } });
    });
    expect(setDraft).toHaveBeenLastCalledWith({
      ...draft,
      subagents: { agents: { task: { model: "gpt-5.6-terra" }, "rubber-duck": { model: "runtime-default" } } },
    });

    await harness.act(async () => {
      getReactProps(find("task"))?.onChange?.({ target: { value: "" } });
    });
    expect(setDraft).toHaveBeenLastCalledWith({ ...draft, subagents: undefined });
    await harness.cleanup();
  });
});
