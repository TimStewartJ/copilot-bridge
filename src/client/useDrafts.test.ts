import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  advanceTimersByTimeAct,
  createReactDomHarness,
  type ReactDomHarness,
} from "./test-react-harness";
import { useDrafts } from "./useDrafts";

function createStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
    clear: () => values.clear(),
  };
}

describe("useDrafts launch persistence", () => {
  let harness: ReactDomHarness | null = null;
  let drafts: ReturnType<typeof useDrafts> | null = null;

  function Probe() {
    drafts = useDrafts([]);
    return null;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("localStorage", createStorage());
  });

  afterEach(async () => {
    await harness?.cleanup();
    harness = null;
    drafts = null;
    vi.unstubAllGlobals();
  });

  async function renderProbe() {
    harness = await createReactDomHarness();
    await harness.render(createElement(Probe));
  }

  it("preserves launch selections while composer text changes and across reload", async () => {
    await renderProbe();
    await harness!.act(async () => {
      drafts!.setDraftLaunchOptions("draft:quickchat", {
        model: "gpt-5.6",
        reasoningEffort: { modelId: "gpt-5.6", value: "high" },
        contextTier: { modelId: "gpt-5.6", value: "long_context" },
      });
      drafts!.setDraft("draft:quickchat", "hello");
    });
    await advanceTimersByTimeAct(harness!.act, 500);

    expect(drafts!.getDraft("draft:quickchat")).toEqual({
      text: "hello",
      launch: {
        model: "gpt-5.6",
        reasoningEffort: { modelId: "gpt-5.6", value: "high" },
        contextTier: { modelId: "gpt-5.6", value: "long_context" },
      },
    });

    await harness!.cleanup();
    harness = null;
    drafts = null;
    await renderProbe();

    expect(drafts!.getDraft("draft:quickchat")?.launch).toEqual({
      model: "gpt-5.6",
      reasoningEffort: { modelId: "gpt-5.6", value: "high" },
      contextTier: { modelId: "gpt-5.6", value: "long_context" },
    });
  });

  it("keeps a launch-only draft when its message is empty", async () => {
    await renderProbe();
    await harness!.act(async () => {
      drafts!.setDraftLaunchOptions("draft:task:task-1", {
        model: "claude-opus-5",
      });
      drafts!.setDraft("draft:task:task-1", "");
    });
    await advanceTimersByTimeAct(harness!.act, 500);

    expect(drafts!.getDraft("draft:task:task-1")).toEqual({
      text: "",
      launch: { model: "claude-opus-5" },
    });
  });

  it("removes text and launch selections only when the draft is explicitly cleared", async () => {
    await renderProbe();
    await harness!.act(async () => {
      drafts!.setDraftLaunchOptions("draft:quickchat", { model: "gpt-5.6" });
      drafts!.setDraft("draft:quickchat", "unsent");
    });
    await advanceTimersByTimeAct(harness!.act, 500);

    await harness!.act(async () => {
      drafts!.clearDraft("draft:quickchat");
    });
    expect(drafts!.getDraft("draft:quickchat")).toBeNull();
    expect(localStorage.getItem("copilot-bridge:session-drafts")).toBe("{}");
  });
});
