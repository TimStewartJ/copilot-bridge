import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelInfo, Session, SessionModelState } from "../api";
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
}));

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return { ...actual, ...apiMocks };
});

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

  return { dom: harness.dom, cleanup: harness.cleanup };
}

function createSession(overrides: Partial<Session> & { sessionId: string }): Session {
  return {
    summary: "Test session",
    deferSummary: { count: 0, nextRunAt: null },
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
        busy: true,
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

describe("SessionList defer summary indicator", () => {
  it("renders a single defer with the next run time", async () => {
    const { dom, cleanup } = await renderSessionList([
      createSession({
        sessionId: "session-1",
        summary: "Deferred session",
        deferSummary: { count: 1, nextRunAt: minutesFromNow(5) },
      }),
    ]);

    try {
      expect(dom.container.textContent).toContain("Deferred session");
      expect(dom.container.textContent).toContain("Deferred in 5m");
    } finally {
      await cleanup();
    }
  });

  it("renders multiple defers with the count and next run time", async () => {
    const { dom, cleanup } = await renderSessionList([
      createSession({
        sessionId: "session-1",
        summary: "Queued session",
        deferSummary: { count: 2, nextRunAt: minutesFromNow(5) },
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
        deferSummary: { count: 0, nextRunAt: minutesFromNow(5) },
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
        deferSummary: { count: 1, nextRunAt: minutesFromNow(5) },
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

  async function clickFamilyTile(
    harness: { act: any; dom: { container: any } },
    family: string,
  ) {
    const tile = findAllByTag(harness.dom.container, "BUTTON")
      .find((candidate) => String(getReactProps(candidate)?.["aria-label"] ?? "")
        .startsWith(`${family}:`));
    if (!tile) throw new Error(`Family tile not found: ${family}`);
    await harness.act(async () => {
      getReactProps(tile)?.onClick?.();
    });
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
      // "plain-model" has no gpt-/claude- prefix, so it lives in the Other family.
      await clickFamilyTile(harness, "Other");

      await clickButton(harness, "Save");
      await waitUntilAct(harness.act, () => apiMocks.patchSessionModel.mock.calls.length > 0, {
        label: "session model patch",
      });

      expect(apiMocks.patchSessionModel).toHaveBeenCalledWith("session-1", "plain-model", undefined, undefined);
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
      await clickFamilyTile(harness, "Claude");
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

      const findFamily = (family: string) => findAllByTag(harness.dom.container, "BUTTON")
        .find((candidate) => String(getReactProps(candidate)?.["aria-label"] ?? "")
          .startsWith(`${family}:`));
      expect(getReactProps(findFamily("GPT"))?.["aria-pressed"]).toBe(true);

      await harness.act(async () => {
        resolveModelState({
          model: "claude-opus-5",
          contextTier: "default",
          source: "live",
        });
      });
      await waitUntilAct(
        harness.act,
        () => getReactProps(findFamily("Claude"))?.["aria-pressed"] === true,
        { label: "fresh model dialog state" },
      );
      expect(getReactProps(findFamily("GPT"))?.["aria-pressed"]).toBe(false);
    } finally {
      await harness.cleanup();
    }
  });
});
