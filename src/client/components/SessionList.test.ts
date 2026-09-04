import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings, ModelInfo, Session, SessionModelState } from "../api";
import {
  advanceTimersByTimeAct,
  createReactDomHarness,
  findAllByTag,
  getReactProps,
  waitUntilAct,
} from "../test-react-harness";
import { installSelectAwareDomShim } from "../test-dom-shim";
import { formatReasoningEffortLabel } from "../reasoning-effort";
import { queryClient, queryKeys } from "../queryClient";
import { formatSessionModelLabel } from "../lib/session-model";
import { canKeepCurrentReasoningEffortForModel } from "./SessionList";

const apiMocks = vi.hoisted(() => ({
  fetchModels: vi.fn(),
  refreshModels: vi.fn(),
  fetchSessionModelState: vi.fn(),
  patchSessionModel: vi.fn(),
  fetchSettings: vi.fn(),
  patchSettings: vi.fn(),
}));
const deferredWorkSheetMock = vi.hoisted(() => vi.fn((_props: unknown) => null));

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return { ...actual, ...apiMocks };
});

vi.mock("./DeferredWorkSheet", () => ({
  default: (props: unknown) => deferredWorkSheetMock(props),
}));

async function renderSessionList(sessions: Session[]) {
  const harness = await createReactDomHarness();
  const { default: SessionList } = await import("./SessionList");

  await harness.render(createElement(SessionList, {
    variant: "global",
    sessions,
    activeSessionId: null,
    onSelectSession: vi.fn(),
    onNewSession: vi.fn(),
    showNewButton: false,
  }));

  return { dom: harness.dom, act: harness.act, cleanup: harness.cleanup };
}

function createSession(overrides: Partial<Session> & { sessionId: string }): Session {
  return {
    summary: "Test session",
    deferSummary: { count: 0, runningCount: 0, nextRunAt: null },
    ...overrides,
  };
}

function minutesFromNow(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

beforeEach(() => {
  queryClient.clear();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-04-27T12:00:00.000Z"));
  apiMocks.fetchModels.mockResolvedValue([]);
  apiMocks.refreshModels.mockResolvedValue([]);
  apiMocks.fetchSessionModelState.mockResolvedValue({ source: "unknown" });
  apiMocks.patchSessionModel.mockResolvedValue({ model: "gpt-5.6" });
  apiMocks.fetchSettings.mockResolvedValue({ mcpServers: {} });
  apiMocks.patchSettings.mockImplementation(async (updates: Partial<AppSettings>) => ({
    mcpServers: {},
    ...updates,
  }));
});

afterEach(() => {
  queryClient.clear();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("SessionList input-required indicator", () => {
  it("renders a needs-answer marker for sessions waiting on user input", async () => {
    const { dom, cleanup } = await renderSessionList([
      createSession({
        sessionId: "session-1",
        summary: "Waiting session",
        runState: "busy",
        pendingUserInputCount: 1,
        needsUserInput: true,
      }),
    ]);

    try {
      expect(dom.container.textContent).toContain("Waiting session");
      expect(dom.container.textContent).toContain("Needs answer");
    } finally {
      await cleanup();
    }
  });
});

describe("SessionList external-use indicator", () => {
  it("shows that a session is open in another Copilot client", async () => {
    const { dom, cleanup } = await renderSessionList([
      createSession({
        sessionId: "session-1",
        summary: "Shared session",
        externallyInUse: true,
      }),
    ]);

    try {
      expect(dom.container.textContent).toContain("Open elsewhere");
      const indicator = findAllByTag(dom.container, "SPAN")
        .find((candidate) => getReactProps(candidate)?.title === "This session is open in another Copilot client");
      expect(indicator).toBeDefined();
    } finally {
      await cleanup();
    }
  });
});

describe("SessionList defer summary indicator", () => {
  it("renders a single defer with the next run time", async () => {
    const { dom, cleanup } = await renderSessionList([
      createSession({
        sessionId: "session-1",
        summary: "Deferred session",
        deferSummary: { count: 1, runningCount: 0, nextRunAt: minutesFromNow(5) },
      }),
    ]);

    try {
      expect(dom.container.textContent).toContain("Deferred session");
      expect(dom.container.textContent).toContain("Deferred in 5m");
    } finally {
      await cleanup();
    }
  });

  it("renders a visibly distinct badge while a defer worker is running", async () => {
    const { dom, cleanup } = await renderSessionList([
      createSession({
        sessionId: "session-1",
        summary: "Running deferred session",
        deferSummary: { count: 1, runningCount: 1, nextRunAt: null },
      }),
    ]);

    try {
      expect(dom.container.textContent).toContain("Defer running");
      const badge = findAllByTag(dom.container, "BUTTON").find(
        (button) => getReactProps(button)?.title?.includes("Defer running"),
      );
      expect(getReactProps(badge)?.className).toContain("text-info");
      expect(getReactProps(badge)?.className).toContain("bg-info/10");
    } finally {
      await cleanup();
    }
  });

  it("shows running and queued defer counts together", async () => {
    const { dom, cleanup } = await renderSessionList([
      createSession({
        sessionId: "session-1",
        summary: "Mixed deferred session",
        deferSummary: { count: 2, runningCount: 1, nextRunAt: minutesFromNow(5) },
      }),
    ]);

    try {
      expect(dom.container.textContent).toContain("1 running · 1 queued");
    } finally {
      await cleanup();
    }
  });

  it("opens deferred work from the defer badge", async () => {
    const session = createSession({
      sessionId: "session-1",
      summary: "Deferred session",
      deferSummary: { count: 1, runningCount: 0, nextRunAt: minutesFromNow(5) },
    });
    const { dom, act, cleanup } = await renderSessionList([session]);

    try {
      const badge = findAllByTag(dom.container, "BUTTON").find(
        (button) => getReactProps(button)?.title?.includes("Open deferred work"),
      );
      expect(badge).toBeDefined();
      await act(async () => {
        getReactProps(badge)?.onClick?.({ stopPropagation: vi.fn() });
      });
      expect(deferredWorkSheetMock).toHaveBeenCalledWith(expect.objectContaining({
        session,
        onClose: expect.any(Function),
      }));
    } finally {
      await cleanup();
    }
  });

  it("renders multiple defers with the count and next run time", async () => {
    const { dom, cleanup } = await renderSessionList([
      createSession({
        sessionId: "session-1",
        summary: "Queued session",
        deferSummary: { count: 2, runningCount: 0, nextRunAt: minutesFromNow(5) },
      }),
    ]);

    try {
      expect(dom.container.textContent).toContain("2 defers · next in 5m");
    } finally {
      await cleanup();
    }
  });

  it("does not render a defer label when the summary is cleared", async () => {
    const { dom, cleanup } = await renderSessionList([
      createSession({
        sessionId: "session-1",
        summary: "Cleared session",
        deferSummary: { count: 0, runningCount: 0, nextRunAt: minutesFromNow(5) },
      }),
    ]);

    try {
      expect(dom.container.textContent).toContain("Cleared session");
      expect(dom.container.textContent).not.toContain("Deferred");
      expect(dom.container.textContent).not.toContain("defers");
    } finally {
      await cleanup();
    }
  });

  it("coexists with the needs-answer indicator", async () => {
    const { dom, cleanup } = await renderSessionList([
      createSession({
        sessionId: "session-1",
        summary: "Waiting deferred session",
        needsUserInput: true,
        pendingUserInputCount: 1,
        deferSummary: { count: 1, runningCount: 0, nextRunAt: minutesFromNow(5) },
      }),
    ]);

    try {
      expect(dom.container.textContent).toContain("Needs answer");
      expect(dom.container.textContent).toContain("Deferred in 5m");
    } finally {
      await cleanup();
    }
  });
});

describe("session model menu labels", () => {
  it("formats model names with reasoning effort labels", () => {
    expect(formatSessionModelLabel(
      { model: "gpt-5.5", reasoningEffort: "high", source: "events" },
      [{ id: "gpt-5.5", name: "GPT-5.5" }],
    )).toBe("GPT-5.5 · High");
  });

  it("falls back to the model id when model metadata is unavailable", () => {
    expect(formatSessionModelLabel({ model: "custom-model", source: "events" }, null))
      .toBe("custom-model");
  });

  it("shows long context from session state before model metadata loads", () => {
    expect(formatSessionModelLabel(
      { model: "gpt-5.5", reasoningEffort: "xhigh", contextTier: "long_context", source: "events" },
      null,
    )).toBe("gpt-5.5 · Xhigh · Long context");
  });

  it("uses detailed context labels when model metadata is available", () => {
    expect(formatSessionModelLabel(
      { model: "gpt-5.5", reasoningEffort: "xhigh", contextTier: "long_context", source: "events" },
      [{
        id: "gpt-5.5",
        name: "GPT-5.5",
        billing: {
          tokenPrices: {
            contextMax: 272_000,
            longContext: { contextMax: 922_000 },
          },
        },
      }],
    )).toBe("GPT-5.5 · Xhigh · Long context (922K)");
  });

  it("humanizes unknown reasoning effort values generically", () => {
    expect(formatReasoningEffortLabel("experimental")).toBe("Experimental");
  });

  it("keeps the current reasoning effort only when lookup confirms it is supported", () => {
    const cases = [
      [{ supportedReasoningEfforts: ["xhigh"], currentEffortLookupReady: false }, false],
      [{ supportedReasoningEfforts: ["xhigh"], currentEffortLookupReady: true }, true],
      [{ supportedReasoningEfforts: [], currentReasoningEffort: "high", currentEffortLookupReady: true }, false],
      [{ supportedReasoningEfforts: ["high"], currentReasoningEffort: "xhigh", currentEffortLookupReady: true }, false],
      [{ supportedReasoningEfforts: ["xhigh"], currentReasoningEffort: "xhigh", currentEffortLookupReady: true }, true],
    ] as const;

    for (const [input, expected] of cases) {
      expect(canKeepCurrentReasoningEffortForModel(input)).toBe(expected);
    }
  });
});

describe("SessionList copy session id", () => {
  async function renderSessionMenu() {
    const harness = await createReactDomHarness();
    const { default: SessionList } = await import("./SessionList");

    await harness.render(createElement(SessionList, {
      variant: "global",
      sessions: [createSession({ sessionId: "session-1", summary: "Clipboard session" })],
      activeSessionId: null,
      onSelectSession: vi.fn(),
      onNewSession: vi.fn(),
      showNewButton: false,
    }));

    const row = findAllByTag(harness.dom.container, "BUTTON")
      .find((candidate) => typeof getReactProps(candidate)?.onContextMenu === "function");
    if (!row) throw new Error("Session row button not found");

    await harness.act(async () => {
      getReactProps(row)?.onContextMenu?.({ preventDefault: vi.fn(), clientX: 10, clientY: 10 });
    });

    return harness;
  }

  function findMenuButton(root: any, text: string): any {
    const button = findAllByTag(root, "BUTTON").find((candidate) => (candidate.textContent ?? "").includes(text));
    if (!button) throw new Error(`Button not found with text: ${text}`);
    return button;
  }

  function clickMenuButton(button: any) {
    getReactProps(button)?.onClick?.({
      currentTarget: button,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    });
  }

  function setClipboard(clipboard: unknown) {
    (globalThis.navigator as unknown as { clipboard?: unknown }).clipboard = clipboard;
  }

  it("keeps the menu open with an inline error when the clipboard write rejects", async () => {
    const harness = await renderSessionMenu();
    try {
      setClipboard({ writeText: vi.fn().mockRejectedValue(new Error("Clipboard permission denied")) });

      await harness.act(async () => {
        clickMenuButton(findMenuButton(harness.dom.container, "Copy Session ID"));
      });
      await waitUntilAct(harness.act, () => (harness.dom.container.textContent ?? "").includes("Copy failed"), {
        label: "session id copy failure",
      });

      expect(harness.dom.container.textContent).toContain("Clipboard permission denied");
      expect(harness.dom.container.textContent).not.toContain("Copied!");

      await advanceTimersByTimeAct(harness.act, 2_000);
      expect(harness.dom.container.textContent).toContain("Copy Session ID");
    } finally {
      await harness.cleanup();
    }
  });
});

describe("SessionList change model dialog", () => {
  const TIERED_MODEL: ModelInfo = {
    id: "gpt-5.6",
    name: "GPT-5.6",
    supportedReasoningEfforts: ["low", "high"],
    defaultReasoningEffort: "low",
    capabilities: { limits: { max_context_window_tokens: 1_050_000 } },
    billing: { tokenPrices: { contextMax: 272_000, longContext: { contextMax: 922_000 } } },
  };

  async function openModelDialog(modelState: SessionModelState, models: ModelInfo[]) {
    apiMocks.fetchSessionModelState.mockResolvedValue(modelState);
    apiMocks.fetchModels.mockResolvedValue(models);

    const harness = await createReactDomHarness({ installDom: installSelectAwareDomShim });
    const { default: SessionList } = await import("./SessionList");
    await harness.render(createElement(SessionList, {
      variant: "global",
      sessions: [createSession({ sessionId: "session-1", summary: "Model session" })],
      activeSessionId: null,
      onSelectSession: vi.fn(),
      onNewSession: vi.fn(),
      showNewButton: false,
    }));

    const row = findAllByTag(harness.dom.container, "BUTTON")
      .find((candidate) => typeof getReactProps(candidate)?.onContextMenu === "function");
    if (!row) throw new Error("Session row button not found");
    await harness.act(async () => {
      getReactProps(row)?.onContextMenu?.({ preventDefault: vi.fn(), clientX: 10, clientY: 10 });
    });

    await harness.act(async () => {
      getReactProps(findButton(harness.dom.container, "Change Model..."))?.onClick?.({
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      });
    });
    await waitUntilAct(
      harness.act,
      () => (harness.dom.container.textContent ?? "").includes("Change session model"),
      { label: "change model dialog" },
    );

    return harness;
  }

  function findButton(root: any, text: string): any {
    const button = findAllByTag(root, "BUTTON").find((candidate) => (candidate.textContent ?? "") === text);
    if (!button) throw new Error(`Button not found with text: ${text}`);
    return button;
  }

  async function clickButton(harness: { act: any; dom: { container: any } }, text: string) {
    await harness.act(async () => {
      getReactProps(findButton(harness.dom.container, text))?.onClick?.({
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      });
    });
  }

  async function clickPresetTile(
    harness: { act: any; dom: { container: any } },
    preset: string,
  ) {
    const tile = findAllByTag(harness.dom.container, "BUTTON")
      .find((candidate) => String(getReactProps(candidate)?.["aria-label"] ?? "")
        .startsWith(`${preset}:`));
    if (!tile) throw new Error(`Preset tile not found: ${preset}`);
    await harness.act(async () => {
      getReactProps(tile)?.onClick?.();
    });
  }

  async function selectPresetModel(
    harness: { act: any; dom: { container: any } },
    preset: string,
    modelName: string,
  ) {
    const caret = findAllByTag(harness.dom.container, "BUTTON")
      .find((candidate) => getReactProps(candidate)?.["aria-label"] === `Choose ${preset} model`);
    if (!caret) throw new Error(`Preset caret not found: ${preset}`);
    await harness.act(async () => {
      getReactProps(caret)?.onClick?.();
    });
    await clickButton(harness, modelName);
  }

  it("submits the effort and context tier picked from the option rows", async () => {
    const harness = await openModelDialog(
      { model: "gpt-5.6", reasoningEffort: "low", contextTier: "default", source: "live" },
      [TIERED_MODEL],
    );
    try {
      await waitUntilAct(
        harness.act,
        () => (harness.dom.container.textContent ?? "").includes("Long context (922K)"),
        { label: "model metadata" },
      );

      await clickButton(harness, "High");
      await clickButton(harness, "Long context (922K)");
      await clickButton(harness, "Save");
      await waitUntilAct(harness.act, () => apiMocks.patchSessionModel.mock.calls.length > 0, {
        label: "session model patch",
      });

      expect(apiMocks.patchSessionModel).toHaveBeenCalledWith("session-1", "gpt-5.6", "high", "long_context");
      expect(queryClient.getQueryData(queryKeys.sessionModel("session-1"))).toEqual({
        model: "gpt-5.6",
        reasoningEffort: "high",
        contextTier: "long_context",
        source: "live",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("opens with the current session's long-context tier selected", async () => {
    const harness = await openModelDialog(
      { model: "gpt-5.6", reasoningEffort: "high", contextTier: "long_context", source: "live" },
      [TIERED_MODEL],
    );
    try {
      await waitUntilAct(
        harness.act,
        () => (harness.dom.container.textContent ?? "").includes("Long context (922K)"),
        { label: "model metadata" },
      );

      expect(getReactProps(findButton(harness.dom.container, "Long context (922K)"))?.["aria-pressed"])
        .toBe(true);
      expect(getReactProps(findButton(harness.dom.container, "Standard context (272K)"))?.["aria-pressed"])
        .toBe(false);
    } finally {
      await harness.cleanup();
    }
  });

  it("drops a picked effort when switching to a model without effort metadata", async () => {
    const harness = await openModelDialog(
      { model: "gpt-5.6", reasoningEffort: "low", contextTier: "default", source: "live" },
      [TIERED_MODEL, { id: "plain-model", name: "Plain Model" }],
    );
    try {
      await waitUntilAct(
        harness.act,
        () => (harness.dom.container.textContent ?? "").includes("Long context (922K)"),
        { label: "model metadata" },
      );

      await clickButton(harness, "High");
      await clickPresetTile(harness, "Preset 3");

      await clickButton(harness, "Save");
      await waitUntilAct(harness.act, () => apiMocks.patchSessionModel.mock.calls.length > 0, {
        label: "session model patch",
      });

      expect(apiMocks.patchSessionModel).toHaveBeenCalledWith("session-1", "plain-model", undefined, undefined);
    } finally {
      await harness.cleanup();
    }
  });

  it("keeps SDK order in change-model preset menus", async () => {
    const harness = await openModelDialog(
      { model: "gpt-5.6", reasoningEffort: "low", contextTier: "default", source: "live" },
      [
        TIERED_MODEL,
        { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
        { id: "claude-haiku-4.5", name: "Claude Haiku 4.5" },
        {
          id: "claude-disabled",
          name: "Claude Aardvark",
          policy: { state: "disabled" },
        },
      ],
    );
    try {
      await waitUntilAct(
        harness.act,
        () => (harness.dom.container.textContent ?? "").includes("Claude Sonnet 5"),
        { label: "ordered model metadata" },
      );

      const preset2 = findAllByTag(harness.dom.container, "BUTTON")
        .find((button) => String(getReactProps(button)?.["aria-label"] ?? "").startsWith("Preset 2:"));
      expect(preset2?.textContent).toContain("Claude Sonnet 5");

      const caret = findAllByTag(harness.dom.container, "BUTTON")
        .find((button) => getReactProps(button)?.["aria-label"] === "Choose Preset 2 model");
      if (!caret) throw new Error("Preset 2 refine caret was not rendered");
      await harness.act(async () => {
        getReactProps(caret)?.onClick?.();
      });

      const options = findAllByTag(harness.dom.container, "BUTTON")
        .filter((button) => getReactProps(button)?.role === "option");
      expect(options.map((button) => button.textContent)).toEqual([
        "GPT-5.6",
        "Claude Sonnet 5",
        "Claude Haiku 4.5",
      ]);
      expect(document.activeElement).toBe(options[0]);
    } finally {
      await harness.cleanup();
    }
  });

  it("keeps the current effort when the selected model has no effort metadata", async () => {
    const harness = await openModelDialog(
      { model: "mystery-model", reasoningEffort: "high", source: "events" },
      [TIERED_MODEL],
    );
    try {
      await waitUntilAct(
        harness.act,
        () => (harness.dom.container.textContent ?? "").includes("Default context"),
        { label: "model metadata" },
      );

      // The save omits the effort, so the inert placeholder names what is kept.
      const effortRow = findButton(harness.dom.container, "High");
      expect(getReactProps(effortRow)?.disabled).toBe(true);

      await clickButton(harness, "Save");
      await waitUntilAct(harness.act, () => apiMocks.patchSessionModel.mock.calls.length > 0, {
        label: "session model patch",
      });

      expect(apiMocks.patchSessionModel).toHaveBeenCalledWith("session-1", "mystery-model", undefined, undefined);
    } finally {
      await harness.cleanup();
    }
  });

  it("keeps dialog changes local when Cancel is pressed", async () => {
    const originalState: SessionModelState = {
      model: "gpt-5.6",
      reasoningEffort: "low",
      contextTier: "default",
      source: "live",
    };
    const harness = await openModelDialog(originalState, [
      TIERED_MODEL,
      { id: "claude-opus-5", name: "Claude Opus 5" },
    ]);
    try {
      await waitUntilAct(
        harness.act,
        () => (harness.dom.container.textContent ?? "").includes("Long context (922K)"),
        { label: "model metadata" },
      );
      await clickPresetTile(harness, "Preset 2");
      await clickButton(harness, "Cancel");

      expect(apiMocks.patchSessionModel).not.toHaveBeenCalled();
      expect(queryClient.getQueryData(queryKeys.sessionModel("session-1"))).toEqual(originalState);
      expect(harness.dom.container.textContent).not.toContain("Change session model");
    } finally {
      await harness.cleanup();
    }
  });

  it("refreshes untouched dialog drafts when a stale cached model is replaced", async () => {
    let resolveModelState!: (state: SessionModelState) => void;
    apiMocks.fetchSessionModelState.mockReturnValue(new Promise((resolve) => {
      resolveModelState = resolve;
    }));
    apiMocks.fetchModels.mockResolvedValue([
      TIERED_MODEL,
      { id: "claude-opus-5", name: "Claude Opus 5" },
    ]);
    queryClient.setQueryData(
      queryKeys.sessionModel("session-1"),
      { model: "gpt-5.6", source: "events" } satisfies SessionModelState,
      { updatedAt: 0 },
    );

    const harness = await createReactDomHarness({ installDom: installSelectAwareDomShim });
    const { default: SessionList } = await import("./SessionList");
    await harness.render(createElement(SessionList, {
      variant: "global",
      sessions: [createSession({ sessionId: "session-1", summary: "Model session" })],
      activeSessionId: null,
      onSelectSession: vi.fn(),
      onNewSession: vi.fn(),
      showNewButton: false,
    }));

    try {
      const row = findAllByTag(harness.dom.container, "BUTTON")
        .find((candidate) => typeof getReactProps(candidate)?.onContextMenu === "function");
      if (!row) throw new Error("Session row button not found");
      await harness.act(async () => {
        getReactProps(row)?.onContextMenu?.({ preventDefault: vi.fn(), clientX: 10, clientY: 10 });
      });
      await clickButton(harness, "Change Model...");
      await waitUntilAct(
        harness.act,
        () => (harness.dom.container.textContent ?? "").includes("Change session model"),
        { label: "change model dialog" },
      );

      const findPreset = (preset: string) => findAllByTag(harness.dom.container, "BUTTON")
        .find((candidate) => String(getReactProps(candidate)?.["aria-label"] ?? "")
          .startsWith(`${preset}:`));
      expect(getReactProps(findPreset("Preset 1"))?.["aria-pressed"]).toBe(true);

      await harness.act(async () => {
        resolveModelState({
          model: "claude-opus-5",
          contextTier: "default",
          source: "live",
        });
      });
      await waitUntilAct(
        harness.act,
        () => getReactProps(findPreset("Preset 2"))?.["aria-pressed"] === true,
        { label: "fresh model dialog state" },
      );
      expect(getReactProps(findPreset("Preset 1"))?.["aria-pressed"]).toBe(false);
    } finally {
      await harness.cleanup();
    }
  });

  describe("shared model preset memory", () => {
    const CLAUDE_OPUS: ModelInfo = {
      id: "claude-opus-5",
      name: "Claude Opus 5",
      supportedReasoningEfforts: ["low", "medium", "high"],
      defaultReasoningEffort: "medium",
      capabilities: { limits: { max_context_window_tokens: 1_000_000 } },
      billing: { tokenPrices: { contextMax: 200_000, longContext: { contextMax: 1_000_000 } } },
    };
    const CLAUDE_SONNET: ModelInfo = {
      id: "claude-sonnet-5",
      name: "Claude Sonnet 5",
      supportedReasoningEfforts: ["low", "medium", "high"],
      defaultReasoningEffort: "medium",
    };

    function seedSettings(settings: Partial<AppSettings>) {
      queryClient.setQueryData<AppSettings>(queryKeys.settings, { mcpServers: {}, ...settings });
    }

    function findTile(harness: { dom: { container: any } }, preset: string): any {
      const tile = findAllByTag(harness.dom.container, "BUTTON")
        .find((candidate) => String(getReactProps(candidate)?.["aria-label"] ?? "")
          .startsWith(`${preset}:`));
      if (!tile) throw new Error(`Preset tile not found: ${preset}`);
      return tile;
    }

    it("shows the remembered model per preset and restores its effort and context", async () => {
      seedSettings({
        model: "gpt-5.6",
        modelPresets: {
          preset2: { model: "claude-opus-5", reasoningEffort: "high", contextTier: "long_context" },
        },
        lastModelPreset: "preset1",
      });
      const harness = await openModelDialog(
        { model: "gpt-5.6", reasoningEffort: "low", contextTier: "default", source: "live" },
        [TIERED_MODEL, CLAUDE_SONNET, CLAUDE_OPUS],
      );
      try {
        await waitUntilAct(
          harness.act,
          () => (harness.dom.container.textContent ?? "").includes("Claude Opus 5"),
          { label: "model metadata" },
        );

        expect(findTile(harness, "Preset 2").textContent).toContain("Claude Opus 5");

        await clickPresetTile(harness, "Preset 2");
        await clickButton(harness, "Save");
        await waitUntilAct(harness.act, () => apiMocks.patchSessionModel.mock.calls.length > 0, {
          label: "session model patch",
        });

        expect(apiMocks.patchSessionModel).toHaveBeenCalledWith(
          "session-1",
          "claude-opus-5",
          "high",
          "long_context",
        );
      } finally {
        await harness.cleanup();
      }
    });

    it("drops remembered effort and context the target model cannot honor", async () => {
      seedSettings({
        modelPresets: {
          preset2: { model: "claude-sonnet-5", reasoningEffort: "xhigh", contextTier: "long_context" },
        },
      });
      const harness = await openModelDialog(
        { model: "gpt-5.6", reasoningEffort: "low", contextTier: "default", source: "live" },
        [TIERED_MODEL, CLAUDE_SONNET],
      );
      try {
        await waitUntilAct(
          harness.act,
          () => (harness.dom.container.textContent ?? "").includes("Claude Sonnet 5"),
          { label: "model metadata" },
        );

        await clickPresetTile(harness, "Preset 2");
        await clickButton(harness, "Save");
        await waitUntilAct(harness.act, () => apiMocks.patchSessionModel.mock.calls.length > 0, {
          label: "session model patch",
        });

        // The unsupported remembered effort is dropped, so the dialog keeps the
        // session's current effort (omitted from the save); Sonnet has no long context.
        expect(apiMocks.patchSessionModel).toHaveBeenCalledWith(
          "session-1",
          "claude-sonnet-5",
          undefined,
          undefined,
        );
      } finally {
        await harness.cleanup();
      }
    });

    it("remembers a saved switch for the new-chat picker", async () => {
      seedSettings({
        modelPresets: { preset1: { model: "gpt-5.6", reasoningEffort: "low" } },
        lastModelPreset: "preset1",
      });
      apiMocks.patchSessionModel.mockResolvedValue({
        model: "claude-opus-5",
        reasoningEffort: "high",
        contextTier: "long_context",
      });
      const harness = await openModelDialog(
        { model: "gpt-5.6", reasoningEffort: "low", contextTier: "default", source: "live" },
        [TIERED_MODEL, CLAUDE_OPUS],
      );
      try {
        await waitUntilAct(
          harness.act,
          () => (harness.dom.container.textContent ?? "").includes("Claude Opus 5"),
          { label: "model metadata" },
        );

        await clickPresetTile(harness, "Preset 2");
        await clickButton(harness, "High");
        await clickButton(harness, "Long context (1M)");
        await clickButton(harness, "Save");
        await waitUntilAct(harness.act, () => apiMocks.patchSettings.mock.calls.length > 0, {
          label: "settings patch",
        });

        const expected = {
          modelPresets: {
            preset1: { model: "gpt-5.6", reasoningEffort: "low" },
            preset2: { model: "claude-opus-5", reasoningEffort: "high", contextTier: "long_context" },
          },
          lastModelPreset: "preset2",
        };
        expect(apiMocks.patchSettings).toHaveBeenCalledWith(expected);
        expect(queryClient.getQueryData<AppSettings>(queryKeys.settings)).toMatchObject(expected);
      } finally {
        await harness.cleanup();
      }
    });

    it("can assign any model to a preset slot", async () => {
      seedSettings({
        modelPresets: {
          preset1: { model: "gpt-5.6", reasoningEffort: "low", contextTier: "default" },
          preset2: { model: "claude-opus-5", reasoningEffort: "medium" },
        },
        lastModelPreset: "preset1",
      });
      apiMocks.patchSessionModel.mockResolvedValue({
        model: "claude-opus-5",
        reasoningEffort: "medium",
      });
      const harness = await openModelDialog(
        { model: "gpt-5.6", reasoningEffort: "low", contextTier: "default", source: "live" },
        [TIERED_MODEL, CLAUDE_OPUS],
      );
      try {
        await waitUntilAct(
          harness.act,
          () => (harness.dom.container.textContent ?? "").includes("Claude Opus 5"),
          { label: "model metadata" },
        );

        await selectPresetModel(harness, "Preset 1", "Claude Opus 5");
        await clickButton(harness, "Medium");
        await clickButton(harness, "Save");
        await waitUntilAct(harness.act, () => apiMocks.patchSettings.mock.calls.length > 0, {
          label: "settings patch",
        });

        expect(apiMocks.patchSessionModel).toHaveBeenCalledWith(
          "session-1",
          "claude-opus-5",
          "medium",
          "default",
        );
        expect(apiMocks.patchSettings).toHaveBeenCalledWith({
          modelPresets: {
            preset1: { model: "claude-opus-5", reasoningEffort: "medium", contextTier: "default" },
            preset2: { model: "claude-opus-5", reasoningEffort: "medium" },
          },
          lastModelPreset: "preset1",
        });
      } finally {
        await harness.cleanup();
      }
    });

    it("leaves memory untouched when the dialog is cancelled", async () => {
      seedSettings({
        modelPresets: { preset1: { model: "gpt-5.6" } },
        lastModelPreset: "preset1",
      });
      const harness = await openModelDialog(
        { model: "gpt-5.6", reasoningEffort: "low", contextTier: "default", source: "live" },
        [TIERED_MODEL, CLAUDE_OPUS],
      );
      try {
        await waitUntilAct(
          harness.act,
          () => (harness.dom.container.textContent ?? "").includes("Claude Opus 5"),
          { label: "model metadata" },
        );

        await clickPresetTile(harness, "Preset 2");
        await clickButton(harness, "Cancel");

        expect(apiMocks.patchSettings).not.toHaveBeenCalled();
        expect(queryClient.getQueryData<AppSettings>(queryKeys.settings)).toMatchObject({
          modelPresets: { preset1: { model: "gpt-5.6" } },
          lastModelPreset: "preset1",
        });
      } finally {
        await harness.cleanup();
      }
    });
  });
});
