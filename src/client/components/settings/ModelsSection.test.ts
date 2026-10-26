import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "../../api";
import { createReactDomHarness, findAllByTag, getReactProps } from "../../test-react-harness";

const mocks = vi.hoisted(() => ({
  useModelsQuery: vi.fn(),
  invalidateQueries: vi.fn(),
}));

vi.mock("../../hooks/queries/useModels", () => ({ useModelsQuery: () => mocks.useModelsQuery() }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: undefined, error: null }),
  useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries }),
}));

const { ModelsSection } = await import("./ModelsSection");

const MODELS = [
  { id: "gpt-6-luna", name: "GPT-6 Luna", supportedReasoningEfforts: ["low", "high", "max"] },
  { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", supportedReasoningEfforts: ["low", "high", "xhigh"] },
  { id: "claude-opus-5.5", name: "Claude Opus 5.5", supportedReasoningEfforts: ["low", "high"] },
];

const DRAFT: AppSettings = {
  model: "gpt-6.1-sol",
  lastModelPreset: "preset1",
  modelPresets: {
    preset1: { model: "gpt-6-luna", reasoningEffort: "max" },
    preset2: { model: "gpt-6.1-sol", reasoningEffort: "high" },
    preset3: { model: "claude-opus-5.5", reasoningEffort: "high" },
  },
} as AppSettings;

function button(root: any, label: string): any {
  const found = findAllByTag(root, "button").find((element) => {
    const props = getReactProps(element);
    return props?.["aria-label"] === label || element.textContent === label;
  });
  if (!found) throw new Error(`No button ${label}`);
  return found;
}

function group(root: any, label: string): any {
  const found = findAllByTag(root, "div").find((element) => getReactProps(element)?.["aria-label"] === label);
  if (!found) throw new Error(`No group ${label}`);
  return found;
}

let harness: Awaited<ReturnType<typeof createReactDomHarness>> | undefined;
afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

describe("ModelsSection", () => {
  it("edits tiers with the new-chat picker and its effort row", async () => {
    mocks.useModelsQuery.mockReturnValue({ data: MODELS });
    const setDraft = vi.fn();
    harness = await createReactDomHarness();
    await harness.render(createElement(ModelsSection, { draft: DRAFT, setDraft }));

    // The tier picked last in the composer opens for editing, named on its tile.
    expect(getReactProps(button(harness.dom.container, "Fast: GPT-6 Luna"))?.["aria-pressed"]).toBe(true);
    expect(button(harness.dom.container, "Fast: GPT-6 Luna").textContent).toBe("FastGPT-6 Luna");

    await harness.act(() => getReactProps(button(harness!.dom.container, "Deep: Claude Opus 5.5"))!.onClick());
    const effort = group(harness.dom.container, "Deep effort");
    expect(findAllByTag(effort, "button").map((element) => element.textContent)).toEqual(["Low", "High"]);
    await harness.act(() => getReactProps(button(effort, "Low"))!.onClick());
    expect(setDraft).toHaveBeenLastCalledWith(expect.objectContaining({
      modelPresets: expect.objectContaining({ preset3: { model: "claude-opus-5.5", reasoningEffort: "low" } }),
    }));
  });

  it("puts a role on a tier with one tap", async () => {
    mocks.useModelsQuery.mockReturnValue({ data: MODELS });
    const setDraft = vi.fn();
    harness = await createReactDomHarness();
    await harness.render(createElement(ModelsSection, { draft: DRAFT, setDraft }));

    const helm = group(harness.dom.container, "Helm runs on");
    expect(findAllByTag(helm, "button").map((element) => element.textContent)).toEqual(["Fast", "Standard", "Deep", "Auto", "Own"]);
    await harness.act(() => getReactProps(button(helm, "Deep"))!.onClick());
    expect(setDraft).toHaveBeenLastCalledWith(expect.objectContaining({ modelRoles: { helm: { tier: "preset3" } } }));

    // Reviewers offer the chat's own model instead of a model of their own; rubber-duck is described, not set.
    const reviewers = group(harness.dom.container, "Reviewers and delegated work runs on");
    expect(findAllByTag(reviewers, "button").map((element) => element.textContent)).toEqual(["Fast", "Standard", "Deep", "Same as chat"]);
    expect(harness.dom.container.textContent).toContain("Standard (GPT-6.1 Sol) in Claude chats, Deep (Claude Opus 5.5) in GPT chats");

    // Use recommended leaves Reviewers on the chat's model.
    await harness.act(() => getReactProps(button(harness!.dom.container, "Use recommended"))!.onClick());
    expect(setDraft.mock.lastCall?.[0].modelRoles).not.toHaveProperty("reviewers");
  });
});
