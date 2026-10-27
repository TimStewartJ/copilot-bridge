import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "../../api";
import { createReactDomHarness, findAllByTag, getReactProps } from "../../test-react-harness";
import { installSelectAwareDomShim } from "../../test-dom-shim";

const mocks = vi.hoisted(() => ({
  useModelsQuery: vi.fn(),
  invalidateQueries: vi.fn(),
}));

vi.mock("../../hooks/queries/useModels", () => ({ useModelsQuery: () => mocks.useModelsQuery() }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: undefined, error: null }),
  useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries, setQueryData: vi.fn() }),
}));
vi.mock("../../hooks/queries/useModelClientInfo", () => ({ useModelClientInfoQuery: () => ({ data: undefined }) }));
vi.mock("../../queryClient", () => ({ queryKeys: { models: ["models"], modelClientInfo: ["models", "client"] } }));
vi.mock("./ModelMoveDisclosure", () => ({ ModelMoveDisclosure: () => null }));

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

function select(root: any, id: string): any {
  const found = findAllByTag(root, "select").find((element) => getReactProps(element)?.id === id);
  if (!found) throw new Error(`No select ${id}`);
  return found;
}

describe("ModelsSection", () => {
  it("shows each tier's setup on its tile and edits the picked one with button rows", async () => {
    mocks.useModelsQuery.mockReturnValue({ data: MODELS });
    const setDraft = vi.fn();
    harness = await createReactDomHarness({ installDom: installSelectAwareDomShim });
    await harness.render(createElement(ModelsSection, { draft: DRAFT, setDraft }));

    // The tier picked last in the composer opens for editing; each tile says what it is set to.
    const fast = button(harness.dom.container, "Fast: GPT-6 Luna");
    expect(getReactProps(fast)?.["aria-pressed"]).toBe(true);
    expect(fast.textContent).toContain("Max");
    expect(getReactProps(select(harness.dom.container, "tier-preset1-model"))!.value).toBe("gpt-6-luna");

    await harness.act(() => getReactProps(button(harness!.dom.container, "Deep: Claude Opus 5.5"))!.onClick());
    const effort = group(harness.dom.container, "Deep tier effort");
    expect(findAllByTag(effort, "button").map((element) => element.textContent)).toEqual(["Low", "High"]);
    await harness.act(() => getReactProps(button(effort, "Low"))!.onClick());
    expect(setDraft).toHaveBeenLastCalledWith(expect.objectContaining({
      modelPresets: expect.objectContaining({ preset3: { model: "claude-opus-5.5", reasoningEffort: "low" } }),
    }));

    // A new model keeps the effort only when it offers it: Deep's high is on Luna, Fast's max is not on Opus.
    await harness.act(() => getReactProps(select(harness!.dom.container, "tier-preset3-model"))!.onChange({ target: { value: "gpt-6-luna" } }));
    expect(setDraft.mock.lastCall?.[0].modelPresets.preset3).toEqual({ model: "gpt-6-luna", reasoningEffort: "high" });
  });

  it("edits every role's own model in its row, wherever that role keeps it", async () => {
    mocks.useModelsQuery.mockReturnValue({ data: MODELS });
    const setDraft = vi.fn();
    harness = await createReactDomHarness({ installDom: installSelectAwareDomShim });
    // New chats keeps its own model in the older setting (model); Helm in its role.
    await harness.render(createElement(ModelsSection, {
      draft: { ...DRAFT, modelRoles: { helm: { model: "gpt-6-luna", reasoningEffort: "high" } } } as AppSettings,
      setDraft,
    }));
    expect(getReactProps(select(harness.dom.container, "role-chat-model"))!.value).toBe("gpt-6.1-sol");
    expect(getReactProps(select(harness.dom.container, "role-helm-model"))!.value).toBe("gpt-6-luna");
    await harness.act(() => getReactProps(select(harness!.dom.container, "role-chat-model"))!.onChange({ target: { value: "claude-opus-5.5" } }));
    expect(setDraft.mock.lastCall?.[0]).toMatchObject({ model: "claude-opus-5.5" });
    await harness.act(() => getReactProps(button(group(harness!.dom.container, "Helm effort"), "Max"))!.onClick());
    expect(setDraft.mock.lastCall?.[0].modelRoles.helm).toEqual({ model: "gpt-6-luna", reasoningEffort: "max" });
  });

  it("puts a role on a tier with one tap", async () => {
    mocks.useModelsQuery.mockReturnValue({ data: MODELS });
    const setDraft = vi.fn();
    harness = await createReactDomHarness({ installDom: installSelectAwareDomShim });
    await harness.render(createElement(ModelsSection, { draft: DRAFT, setDraft }));

    const helm = group(harness.dom.container, "Helm runs on");
    // No Auto: a role nobody set shows the tier it runs on (Helm: Deep).
    expect(findAllByTag(helm, "button").map((element) => element.textContent)).toEqual(["Fast", "Standard", "Deep", "Custom"]);
    expect(getReactProps(button(helm, "Deep"))!["aria-pressed"] ?? getReactProps(button(helm, "Deep"))!["aria-checked"]).toBe(true);
    await harness.act(() => getReactProps(button(helm, "Standard"))!.onClick());
    expect(setDraft).toHaveBeenLastCalledWith(expect.objectContaining({ modelRoles: { helm: { tier: "preset2" } } }));

    // Reviewers offer the chat's own model instead of a model of their own; rubber-duck is described, not set.
    const reviewers = group(harness.dom.container, "Reviewers and delegated work runs on");
    expect(findAllByTag(reviewers, "button").map((element) => element.textContent)).toEqual(["Fast", "Standard", "Deep", "Same as chat"]);
    expect(harness.dom.container.textContent).toContain("Standard (GPT-6.1 Sol) in Claude chats, Deep (Claude Opus 5.5) in GPT chats");

    // Use recommended leaves Reviewers on the chat's model.
    await harness.act(() => getReactProps(button(harness!.dom.container, "Use recommended"))!.onClick());
    expect(setDraft.mock.lastCall?.[0].modelRoles).not.toHaveProperty("reviewers");
  });
});
