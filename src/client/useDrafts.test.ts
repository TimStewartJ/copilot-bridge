import { createElement } from "react";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  advanceTimersByTimeAct,
  createReactDomHarness,
  type ReactDomHarness,
} from "./test-react-harness";
import { useDrafts } from "./useDrafts";
import type { Session } from "./api";

function createStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
    removeItem: (key: string) => {
      values.delete(key);
    },
    clear: () => values.clear(),
  };
}

describe("useDrafts launch persistence", () => {
  let harness: ReactDomHarness | null = null;
  let drafts: ReturnType<typeof useDrafts> | null = null;
  let storage: ReturnType<typeof createStorage>;

  function Probe() {
    drafts = useDrafts([]);
    return null;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    storage = createStorage();
    vi.stubGlobal("localStorage", storage);
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

  function seedStorage(value: unknown) {
    storage.setItem("copilot-bridge:session-drafts", JSON.stringify(value));
    storage.setItem.mockClear();
  }

  it.each([null, []])("repairs a non-record storage root: %j", async (stored) => {
    seedStorage(stored);
    await renderProbe();

    expect(drafts!.getDraft("draft:quickchat")).toBeNull();
    expect(localStorage.getItem("copilot-bridge:session-drafts")).toBe("{}");
  });

  it("salvages valid drafts and fields while removing malformed persisted data", async () => {
    seedStorage({
      "draft:quickchat": {
        text: "hello",
        attachments: [
          {
            type: "blob",
            data: "aGVsbG8=",
            mimeType: "text/plain",
            displayName: "hello.txt",
          },
          {
            type: "uploaded",
            displayName: "photo.png",
            mimeType: "image/png",
            size: 42,
            previewUrl: "blob:stale-after-reload",
          },
          {
            type: "file",
            path: join("test-files", "report.txt"),
            displayName: "report.txt",
          },
          { type: "uploaded", displayName: "bad.bin", mimeType: "application/octet-stream", size: -1 },
          { type: "unknown" },
        ],
        launch: {
          model: "claude-sonnet-5",
          presetSlot: "preset2",
          agent: "api-reviewer",
          reasoningEffort: { modelId: "claude-sonnet-5", value: 42 },
          contextTier: { modelId: "claude-sonnet-5", value: "long_context" },
          legacy: true,
        },
        legacy: "remove me",
      },
      "draft:task:task-1": {
        text: "",
        launch: { model: "gpt-5.6" },
      },
      "draft:empty": { text: "" },
      "session-invalid": { text: 42 },
      "session-null": null,
    });

    await renderProbe();

    expect(drafts!.getDraft("draft:quickchat")).toEqual({
      text: "hello",
      attachments: [
        {
          type: "blob",
          data: "aGVsbG8=",
          mimeType: "text/plain",
          displayName: "hello.txt",
        },
        {
          type: "uploaded",
          displayName: "photo.png",
          mimeType: "image/png",
          size: 42,
        },
        {
          type: "file",
          path: join("test-files", "report.txt"),
          displayName: "report.txt",
        },
      ],
      launch: {
        model: "claude-sonnet-5",
        presetSlot: "preset2",
        contextTier: { modelId: "claude-sonnet-5", value: "long_context" },
      },
    });
    expect(drafts!.getDraft("draft:task:task-1")).toEqual({
      text: "",
      launch: { model: "gpt-5.6" },
    });
    expect(drafts!.hasDraft("draft:empty")).toBe(false);
    expect(drafts!.hasDraft("session-invalid")).toBe(false);
    expect(drafts!.hasDraft("session-null")).toBe(false);
    expect(JSON.parse(localStorage.getItem("copilot-bridge:session-drafts") ?? "")).toEqual({
      "draft:quickchat": drafts!.getDraft("draft:quickchat"),
      "draft:task:task-1": drafts!.getDraft("draft:task:task-1"),
    });
  });

  it("repairs malformed JSON", async () => {
    storage.setItem("copilot-bridge:session-drafts", "{broken");
    storage.setItem.mockClear();

    await renderProbe();

    expect(drafts!.getDraft("draft:quickchat")).toBeNull();
    expect(localStorage.getItem("copilot-bridge:session-drafts")).toBe("{}");
  });

  it("keeps the chosen launch options from an empty composer through typing, reload and explicit clear", async () => {
    const key = "draft:quickchat";
    const launch = {
      model: "gpt-5.6", presetSlot: "preset1",
      reasoningEffort: { modelId: "gpt-5.6", value: "high" },
      contextTier: { modelId: "gpt-5.6", value: "long_context" },
    } as const;
    await renderProbe();
    await harness!.act(async () => {
      drafts!.setDraftLaunchOptions(key, launch);
      drafts!.setDraft(key, "");
    });
    expect(drafts!.getDraft(key)).toEqual({ text: "", launch });

    const attachments = [{ type: "file" as const, path: join("test-files", "notes.txt"), displayName: "notes.txt" }];
    await harness!.act(async () => { drafts!.setDraft(key, "hello", attachments); });
    await advanceTimersByTimeAct(harness!.act, 500);
    const expected = { text: "hello", attachments, launch };
    expect(drafts!.getDraft(key)).toEqual(expected);

    await harness!.cleanup();
    storage.setItem.mockClear();
    await renderProbe();
    expect(drafts!.getDraft(key)).toEqual(expected);
    expect(storage.setItem).not.toHaveBeenCalled();

    await harness!.act(async () => { drafts!.clearDraft(key); });
    expect(drafts!.getDraft(key)).toBeNull();
    expect(localStorage.getItem("copilot-bridge:session-drafts")).toBe("{}");
  });

  it("keeps the active draft while session inventory settles and prunes only unowned conversations", async () => {
    const otherSession: Session = {
      sessionId: "other-session",
      deferSummary: { count: 0, runningCount: 0, nextRunAt: null },
    };
    const taskDraft = {
      text: "", launch: { model: "gpt-5.6", contextTier: { modelId: "gpt-5.6", value: "default" } },
    };
    seedStorage({ "helm-session": { text: "ask Helm later" }, "gone-session": { text: "stale" }, "draft:task:task-1": taskDraft });
    let active: string | null = "archived-session";
    let preserved: readonly string[] | null = null;
    function HelmDraftProbe() {
      drafts = useDrafts([otherSession], active, preserved);
      return null;
    }

    harness = await createReactDomHarness();
    await harness.render(createElement(HelmDraftProbe));
    expect(drafts!.getDraft("draft:task:task-1")).toEqual(taskDraft);
    expect(storage.setItem).not.toHaveBeenCalled();
    // Unknown yet: cleanup is postponed rather than guessing.
    expect(drafts!.getDraft("helm-session")).toEqual({ text: "ask Helm later" });
    expect(drafts!.getDraft("gone-session")).toEqual({ text: "stale" });

    await harness.act(async () => { drafts!.setDraft("archived-session", "hello"); });
    preserved = ["helm-session"];
    await harness.render(createElement(HelmDraftProbe));
    expect(drafts!.getDraft("helm-session")).toEqual({ text: "ask Helm later" });
    expect(drafts!.getDraft("gone-session")).toBeNull();
    expect(drafts!.getDraft("archived-session")).toEqual({ text: "hello" });

    active = null;
    await harness.render(createElement(HelmDraftProbe));
    expect(drafts!.getDraft("archived-session")).toBeNull();
    expect(drafts!.getDraft("helm-session")).toEqual({ text: "ask Helm later" });
  });

  it("hands a first message off without touching what the next new chat writes", async () => {
    await renderProbe();
    await harness!.act(async () => {
      drafts!.setDraftLaunchOptions("draft:quickchat", { model: "gpt-5.6" });
      drafts!.setDraft("draft:quickchat", "first message");
    });
    const sent = drafts!.readDraft("draft:quickchat");

    await harness!.act(async () => {
      drafts!.releaseDraft("draft:quickchat", sent);
    });
    expect(drafts!.getDraft("draft:quickchat")).toBeNull();

    await harness!.act(async () => {
      drafts!.setDraftLaunchOptions("draft:quickchat", { model: "claude-sonnet-5" });
      drafts!.setDraft("draft:quickchat", "next chat");
      // A release that arrives after newer typing removes nothing.
      drafts!.releaseDraft("draft:quickchat", sent);
    });
    expect(drafts!.getDraft("draft:quickchat")?.text).toBe("next chat");

    // A refused send comes back ahead of the newer text, which keeps its own model.
    await harness!.act(async () => {
      drafts!.restoreDraft("draft:quickchat", sent!);
    });
    const restored = {
      text: "first message\n\nnext chat",
      launch: { model: "claude-sonnet-5" },
    };
    expect(drafts!.getDraft("draft:quickchat")).toEqual(restored);
    expect(JSON.parse(localStorage.getItem("copilot-bridge:session-drafts") ?? "")).toEqual({
      "draft:quickchat": restored,
    });
  });
});
