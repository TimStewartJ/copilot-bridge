import { createElement } from "react";
import { join } from "node:path";
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

  it("does not rewrite valid persisted drafts during hydration or reload", async () => {
    seedStorage({
      "draft:quickchat": {
        text: "hello",
        attachments: [{
          type: "file",
          path: join("test-files", "notes.txt"),
          displayName: "notes.txt",
        }],
        launch: {
          model: "gpt-5.6",
          reasoningEffort: { modelId: "gpt-5.6", value: "high" },
          contextTier: { modelId: "gpt-5.6", value: "default" },
        },
      },
    });

    await renderProbe();
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(drafts!.getDraft("draft:quickchat")?.text).toBe("hello");

    await harness!.cleanup();
    harness = null;
    drafts = null;
    storage.setItem.mockClear();
    await renderProbe();

    expect(storage.setItem).not.toHaveBeenCalled();
    expect(drafts!.getDraft("draft:quickchat")?.launch?.reasoningEffort?.value).toBe("high");
  });

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
