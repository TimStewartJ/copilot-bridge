import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createReactDomHarness, findAllByTag, getReactProps, waitUntilAct, type ReactDomHarness } from "../test-react-harness";
import type { HelmConversation, HelmState } from "./helm-api";

const SESSION_A = "aaaaaaaa-0000-4000-8000-000000000001";
const SESSION_B = "bbbbbbbb-0000-4000-8000-000000000002";

function conversation(overrides: Partial<HelmConversation>): HelmConversation {
  return {
    sessionId: SESSION_A,
    title: "Morning triage",
    createdAt: "2026-09-18T08:00:00.000Z",
    lastActiveAt: "2026-09-18T09:00:00.000Z",
    turnCount: 4,
    kept: false,
    busy: false,
    handsFree: false,
    ...overrides,
  };
}

const POLICY = { freshAfterMs: 6 * 3_600_000, retainMs: 14 * 86_400_000, maxConversations: 25 };

const state = vi.hoisted(() => ({
  helm: null as unknown,
  chatViewProps: null as Record<string, any> | null,
  settingsSheetProps: null as Record<string, any> | null,
}));

const settings = vi.hoisted(() => ({
  data: { helm: { spokenReasoningEffort: "xhigh" } } as { helm?: Record<string, string> },
  mutate: vi.fn(),
  refetchSessionModel: vi.fn(),
}));

const api = vi.hoisted(() => ({
  createHelmConversation: vi.fn(),
  startFreshHelm: vi.fn(),
  resumeHelmConversation: vi.fn(),
  setHelmConversationKept: vi.fn(),
  deleteHelmConversation: vi.fn(),
  sendChatMessage: vi.fn(),
  sendMaterializedFirstPrompt: vi.fn(),
}));

const handsFree = vi.hoisted(() => ({
  active: false,
  helmSessionId: null as string | null,
  phase: "ready",
  error: null as string | null,
  status: { install: { installed: true } } as { install: { installed: boolean } } | null,
  refreshStatus: vi.fn(async () => handsFree.status),
  clearError: vi.fn(() => {
    handsFree.error = null;
  }),
  start: vi.fn(async (target: string | (() => Promise<string>)) => {
    handsFree.helmSessionId = typeof target === "string" ? target : await target();
    handsFree.active = true;
  }),
  stop: vi.fn(async () => {
    handsFree.active = false;
    handsFree.helmSessionId = null;
  }),
}));

const queryCache = vi.hoisted(() => ({
  setQueryData: vi.fn((_key: unknown, update: unknown) => {
    state.helm = typeof update === "function" ? (update as (previous: unknown) => unknown)(state.helm) : update;
  }),
  invalidateQueries: vi.fn(async () => undefined),
}));

vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => queryCache }));
vi.mock("../api", () => ({ sendChatMessage: api.sendChatMessage }));
vi.mock("../first-send-session-cleanup", () => ({ sendMaterializedFirstPrompt: api.sendMaterializedFirstPrompt }));
vi.mock("../hooks/queries/useModels", () => ({ useModelsQuery: () => ({ data: [] }) }));
vi.mock("../hooks/queries/useSessionModel", () => ({
  useSessionModelQuery: () => ({ data: { model: "gpt-5.6-luna" }, isLoading: false, isFetching: false, error: null, refetch: settings.refetchSessionModel }),
}));
vi.mock("../hooks/queries/useSettings", () => ({
  useSettingsQuery: () => ({ data: settings.data }),
  useSettingsMutation: () => ({ mutate: settings.mutate }),
}));
vi.mock("../components/SessionModelSummary", () => ({ default: () => null }));
vi.mock("../components/ChatView", () => ({
  default: (props: Record<string, any>) => {
    state.chatViewProps = props;
    return createElement("div", { "data-chat-view": "true" }, props.emptyState as ReactNode, props.composerAccessory as ReactNode);
  },
}));
vi.mock("../voice/HandsFreeProvider", () => ({ useHandsFree: () => handsFree }));
vi.mock("../voice/HandsFreeDock", () => ({
  HandsFreeDock: () => createElement("div", { "data-dock": "true" }),
  HandsFreeSetupPanel: () => createElement("div", { "data-setup": "true" }),
}));
vi.mock("../voice/VoiceSettingsSheet", () => ({
  VoiceSettingsSheet: (props: Record<string, any>) => {
    state.settingsSheetProps = props;
    return createElement("div", { "data-settings": "true" });
  },
}));
vi.mock("./helm-api", async () => {
  const actual = await vi.importActual<typeof import("./helm-api")>("./helm-api");
  return {
    ...actual,
    ...api,
    useHelmStateQuery: () => ({ data: state.helm, isLoading: false, error: null }),
    useHelmModelPreference: () => ["", vi.fn()],
  };
});

const { default: HelmView, HELM_DRAFT_COMPOSER_KEY } = await import("./HelmView");

function helmState(overrides: Partial<HelmState>): HelmState {
  return { current: null, resumable: null, recent: [], policy: POLICY, reasoningEfforts: { typed: "max", spoken: "xhigh" }, ...overrides };
}

function createProps() {
  return {
    onMessageSent: vi.fn(),
    getDraft: vi.fn(() => null),
    setDraft: vi.fn(),
    clearDraft: vi.fn(),
    getVoiceJob: vi.fn(() => null),
    startBackgroundVoiceJob: vi.fn(async () => undefined),
    retryVoiceJobUpload: vi.fn(),
    reviewVoiceJob: vi.fn(),
    clearVoiceJobError: vi.fn(),
    discardVoiceRecording: vi.fn(),
    sessionReloadSignals: {},
    sessionBusySignals: { [SESSION_A]: 3 },
    sessionHistorySignals: {},
  };
}

function findButton(root: unknown, match: (props: Record<string, any>, text: string) => boolean) {
  const button = findAllByTag(root, "BUTTON").find((candidate) => match(getReactProps(candidate) ?? {}, candidate.textContent ?? ""));
  if (!button) throw new Error("button not found");
  return getReactProps(button)!;
}

describe("HelmView", () => {
  let harness: ReactDomHarness;
  let props: ReturnType<typeof createProps>;

  async function render() {
    await harness.render(createElement(HelmView, props));
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    state.chatViewProps = null;
    state.settingsSheetProps = null;
    handsFree.active = false;
    handsFree.helmSessionId = null;
    handsFree.phase = "ready";
    handsFree.error = null;
    handsFree.status = { install: { installed: true } };
    props = createProps();
    harness = await createReactDomHarness();
  });

  it("is an ordinary chat over the current Helm conversation", async () => {
    state.helm = helmState({ current: conversation({}) });
    await render();
    expect(state.chatViewProps).toMatchObject({
      sessionId: SESSION_A,
      composerKey: SESSION_A,
      busySignal: 3,
      onCreateAndSend: undefined,
      hideVoiceInput: false,
      composerAccessory: null,
      composerPlaceholder: "Ask Helm…",
    });
    expect(props.getVoiceJob).toHaveBeenCalledWith(SESSION_A);
    expect(handsFree.refreshStatus).toHaveBeenCalled();
  });

  it("creates the conversation with the first message and keeps the view mounted through it", async () => {
    state.helm = helmState({});
    api.createHelmConversation.mockResolvedValue(conversation({ sessionId: SESSION_B, turnCount: 0, title: null }));
    api.sendMaterializedFirstPrompt.mockResolvedValue(undefined);
    await render();
    expect(state.chatViewProps).toMatchObject({ sessionId: null, composerKey: HELM_DRAFT_COMPOSER_KEY });

    await harness.act(() => state.chatViewProps!.onCreateAndSend("what needs me?", undefined, "interactive", "client-1"));
    expect(api.createHelmConversation).toHaveBeenCalledOnce();
    expect(api.sendMaterializedFirstPrompt).toHaveBeenCalledWith({
      sessionId: SESSION_B,
      prompt: "what needs me?",
      attachments: undefined,
      mode: "interactive",
      clientMessageId: "client-1",
    });
    expect((state.helm as HelmState).current?.sessionId).toBe(SESSION_B);
    expect(props.clearDraft).toHaveBeenCalledWith(HELM_DRAFT_COMPOSER_KEY);
  });

  it("keeps a recording made before any conversation exists inside Helm", async () => {
    state.helm = helmState({});
    api.createHelmConversation.mockResolvedValue(conversation({ sessionId: SESSION_B, turnCount: 0 }));
    await render();
    const audio = { size: 1 } as Blob;
    await harness.act(() => state.chatViewProps!.onSubmitVoiceCapture({ composerKey: HELM_DRAFT_COMPOSER_KEY, audio, submitMode: "send" }));
    expect(props.startBackgroundVoiceJob).toHaveBeenCalledWith({ composerKey: SESSION_B, audio, submitMode: "send" });
  });

  it("offers the way back after opening fresh, and resumes it", async () => {
    const earlier = conversation({});
    state.helm = helmState({ resumable: earlier, recent: [earlier] });
    api.resumeHelmConversation.mockResolvedValue({ ...earlier });
    await render();
    const resume = findButton(harness.dom.container, (_props, text) => text.includes("Pick up where you left off"));
    await harness.act(() => resume.onClick());
    await waitUntilAct(harness.act, () => (state.helm as HelmState).current?.sessionId === SESSION_A);
    expect(api.resumeHelmConversation).toHaveBeenCalledWith(SESSION_A);
    expect((state.helm as HelmState).recent).toEqual([]);
  });

  it("enters hands-free on the same conversation and docks it above the composer", async () => {
    state.helm = helmState({ current: conversation({}) });
    await render();
    const toggle = findButton(harness.dom.container, (buttonProps) => buttonProps["aria-pressed"] === false && buttonProps["aria-label"] === "Hands-free");
    await harness.act(() => toggle.onClick());
    expect(handsFree.start).toHaveBeenCalledWith(SESSION_A);

    await render();
    expect(state.chatViewProps!.hideVoiceInput).toBe(true);
    expect(state.chatViewProps!.composerPlaceholder).toContain("answer out loud");
    expect(findAllByTag(harness.dom.container, "DIV").some((div) => getReactProps(div)?.["data-dock"])).toBe(true);
    // Same session before and after: entering hands-free changed the mode, not the context.
    expect(state.chatViewProps!.sessionId).toBe(SESSION_A);

    const end = findButton(harness.dom.container, (buttonProps) => buttonProps["aria-pressed"] === true);
    await harness.act(() => end.onClick());
    expect(handsFree.stop).toHaveBeenCalledOnce();
    await render();
    expect(state.chatViewProps).toMatchObject({ sessionId: SESSION_A, hideVoiceInput: false, composerAccessory: null });
  });

  it("creates a conversation on demand when hands-free starts from a fresh Helm", async () => {
    state.helm = helmState({});
    api.createHelmConversation.mockResolvedValue(conversation({ sessionId: SESSION_B, turnCount: 0 }));
    await render();
    const goHandsFree = findButton(harness.dom.container, (_props, text) => text.includes("Go hands-free"));
    await harness.act(() => goHandsFree.onClick());
    // A function, not an id: audio starts inside the tap, then the conversation is created.
    expect(typeof handsFree.start.mock.calls[0]![0]).toBe("function");
    expect(api.createHelmConversation).toHaveBeenCalledOnce();
    expect(handsFree.helmSessionId).toBe(SESSION_B);
  });

  it("offers speech engine setup instead of starting when it is not installed", async () => {
    state.helm = helmState({ current: conversation({}) });
    handsFree.status = { install: { installed: false } };
    await render();
    const toggle = findButton(harness.dom.container, (buttonProps) => buttonProps["aria-pressed"] === false && buttonProps["aria-label"] === "Hands-free");
    await harness.act(() => toggle.onClick());
    expect(handsFree.start).not.toHaveBeenCalled();
    expect(findAllByTag(harness.dom.container, "DIV").some((div) => getReactProps(div)?.["data-setup"])).toBe(true);
  });

  it("resets without deleting, and takes hands-free along to the new conversation", async () => {
    const current = conversation({});
    state.helm = helmState({ current });
    handsFree.active = true;
    handsFree.helmSessionId = SESSION_A;
    api.startFreshHelm.mockResolvedValue(helmState({ resumable: current, recent: [current] }));
    api.createHelmConversation.mockResolvedValue(conversation({ sessionId: SESSION_B, turnCount: 0, title: null }));
    await render();

    const reset = findButton(harness.dom.container, (buttonProps) => buttonProps["aria-label"] === "New conversation");
    await harness.act(() => reset.onClick());
    await waitUntilAct(harness.act, () => handsFree.helmSessionId === SESSION_B);

    expect(handsFree.stop).toHaveBeenCalledOnce();
    expect(api.startFreshHelm).toHaveBeenCalledOnce();
    expect(api.deleteHelmConversation).not.toHaveBeenCalled();
    const next = state.helm as HelmState;
    expect(next.current?.sessionId).toBe(SESSION_B);
    expect(next.recent.map((entry) => entry.sessionId)).toEqual([SESSION_A]);
  });

  it("shows why hands-free could not start, and lets the message be dismissed", async () => {
    state.helm = helmState({ current: conversation({}) });
    handsFree.phase = "error";
    handsFree.error = "No microphone was found. Check your browser and OS audio input settings, then try again.";
    await render();
    const alert = findAllByTag(harness.dom.container, "DIV").find((div) => getReactProps(div)?.role === "alert");
    expect(alert?.textContent).toContain("No microphone was found.");
    // Chat keeps working underneath: hands-free failing is not a Helm failure.
    expect(state.chatViewProps).toMatchObject({ sessionId: SESSION_A, hideVoiceInput: false, composerAccessory: null });

    const dismiss = findButton(alert, (buttonProps) => buttonProps["aria-label"] === "Dismiss");
    await harness.act(() => dismiss.onClick());
    expect(handsFree.clearError).toHaveBeenCalledOnce();
    await render();
    expect(findAllByTag(harness.dom.container, "DIV").some((div) => getReactProps(div)?.role === "alert")).toBe(false);
  });

  it("lets each mode think at its own effort, keeping the other mode's setting", async () => {
    state.helm = helmState({ current: conversation({}) });
    await render();
    const open = findButton(harness.dom.container, (buttonProps) => buttonProps["aria-label"] === "Helm settings");
    await harness.act(() => open.onClick());
    expect(state.settingsSheetProps!.helmEfforts).toMatchObject({ typed: "max", spoken: "xhigh", modelId: "gpt-5.6-luna", error: null });

    await harness.act(() => state.settingsSheetProps!.helmEfforts.onChange("typed", "high"));
    // Shown at once, and saved next to the spoken setting rather than over it.
    expect((state.helm as HelmState).reasoningEfforts).toEqual({ typed: "high", spoken: "xhigh" });
    expect(settings.mutate).toHaveBeenCalledWith(
      { helm: { spokenReasoningEffort: "xhigh", typedReasoningEffort: "high" } },
      expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
    );

    // A rejected save puts the picker back and says why.
    await harness.act(() => settings.mutate.mock.calls[0]![1].onError(new Error("helm.typedReasoningEffort must be a reasoning effort name")));
    expect((state.helm as HelmState).reasoningEfforts).toEqual({ typed: "max", spoken: "xhigh" });
    await render();
    expect(state.settingsSheetProps!.helmEfforts.error).toBe("helm.typedReasoningEffort must be a reasoning effort name");
  });

  it("re-reads the model summary after each turn, since the effort changes with the mode", async () => {
    state.helm = helmState({ current: conversation({ lastActiveAt: "2026-09-18T09:00:00.000Z" }) });
    await render();
    const before = settings.refetchSessionModel.mock.calls.length;
    state.helm = helmState({ current: conversation({ lastActiveAt: "2026-09-18T09:05:00.000Z" }) });
    await render();
    expect(settings.refetchSessionModel.mock.calls.length).toBe(before + 1);
  });

  it("sends a suggestion straight to Helm", async () => {
    state.helm = helmState({ current: conversation({ turnCount: 0, title: null }) });
    api.sendChatMessage.mockResolvedValue({ status: "accepted" });
    await render();
    const suggestion = findButton(harness.dom.container, (_props, text) => text === "What needs me right now?");
    await harness.act(() => suggestion.onClick());
    expect(api.sendChatMessage).toHaveBeenCalledWith(SESSION_A, "What needs me right now?", undefined, undefined, { waitForDelivery: true });
    expect(props.onMessageSent).toHaveBeenCalledOnce();
  });
});
