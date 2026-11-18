import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "../../api";
import { createReactDomHarness, findAllByTag, getReactProps } from "../../test-react-harness";
import { installSelectAwareDomShim } from "../../test-dom-shim";

const mocks = vi.hoisted(() => ({
  useModelsQuery: vi.fn(),
  invalidateQueries: vi.fn(),
  abTestReport: undefined as unknown,
}));

vi.mock("../../hooks/queries/useModels", () => ({ useModelsQuery: () => mocks.useModelsQuery() }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: readonly unknown[] }) => ({
    data: options.queryKey[0] === "model-ab-test" ? mocks.abTestReport : undefined,
    error: null,
  }),
  useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries, setQueryData: vi.fn() }),
}));
vi.mock("../../hooks/queries/useModelClientInfo", () => ({ useModelClientInfoQuery: () => ({ data: undefined }) }));
vi.mock("../../queryClient", () => ({
  queryKeys: {
    models: ["models"],
    modelClientInfo: ["models", "client"],
    modelAbTest: (startedAt: string | null) => ["model-ab-test", startedAt],
  },
}));
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

    // A new model keeps the effort only if offered: Luna has Deep's high, Opus lacks Fast's max.
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

    // Reviewers offer the chat's model, not one of their own; rubber-duck is described, not set.
    const reviewers = group(harness.dom.container, "Reviewers and delegated work runs on");
    expect(findAllByTag(reviewers, "button").map((element) => element.textContent)).toEqual(["Fast", "Standard", "Deep", "Same as chat"]);
    expect(harness.dom.container.textContent).toContain("Standard (GPT-6.1 Sol) in Claude chats, Deep (Claude Opus 5.5) in GPT chats");

    // Use recommended leaves Reviewers on the chat's model.
    await harness.act(() => getReactProps(button(harness!.dom.container, "Use recommended"))!.onClick());
    expect(setDraft.mock.lastCall?.[0].modelRoles).not.toHaveProperty("reviewers");
  });

  it("compares a tier with any model, and shows each arm's wins and cost per reply", async () => {
    mocks.useModelsQuery.mockReturnValue({ data: MODELS });
    const setDraft = vi.fn();
    harness = await createReactDomHarness({ installDom: installSelectAwareDomShim });
    await harness.render(createElement(ModelsSection, { draft: DRAFT, setDraft }));

    const toggle = findAllByTag(harness.dom.container, "input").find((element) => getReactProps(element)?.id === "model-ab-test");
    await harness.act(() => getReactProps(toggle)!.onChange({ target: { checked: true } }));
    expect(setDraft).toHaveBeenLastCalledWith(expect.objectContaining({ modelAbTest: { enabled: true, a: { tier: "preset2" }, b: { tier: "preset3" } } }));
    // Custom starts from the tier the arm was on, so trying a new model is one change away.
    await harness.act(() => getReactProps(button(group(harness!.dom.container, "Arm B"), "Custom"))!.onClick());
    expect(setDraft.mock.lastCall?.[0].modelAbTest).toEqual({
      enabled: false, a: { tier: "preset2" }, b: { model: "claude-opus-5.5", reasoningEffort: "high" },
    });

    const startedAt = new Date(Date.now() - 2 * 3_600_000).toISOString();
    mocks.abTestReport = {
      startedAt,
      pairs: 4,
      pending: 0,
      unusable: 1,
      arms: [
        { arm: "a", choice: { tier: "preset2" }, setup: { model: "gpt-6.1-sol", reasoningEffort: "high" }, decided: 3, wins: 2, ties: 0, userWins: 1, medianDurationMs: 42_000, medianAiCredits: 50 },
        { arm: "b", choice: { model: "gpt-6-luna" }, decided: 3, wins: 1, ties: 0, userWins: 0 },
      ],
      recent: [],
    };
    await harness.render(createElement(ModelsSection, {
      draft: { ...DRAFT, modelAbTest: { enabled: true, a: { tier: "preset2" }, b: { model: "gpt-6-luna" }, startedAt } } as AppSettings,
      setDraft,
    }));
    const text = harness.dom.container.textContent;
    expect(text).toContain("Started 2h ago");
    expect(text).toContain("B · GPT-6 Luna");
    expect(text).toContain("Won 2 of 3");
    expect(text).toContain("1 by your vote");
    expect(text).toContain("1 not compared");
    // A running test keeps its arms until it is turned off.
    expect(getReactProps(button(group(harness.dom.container, "Arm A"), "Fast"))!.disabled).toBe(true);
    mocks.abTestReport = undefined;
  });
});
