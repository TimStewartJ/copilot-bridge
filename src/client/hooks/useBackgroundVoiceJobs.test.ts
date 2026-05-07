import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installDomShim } from "../test-dom-shim";
import { useBackgroundVoiceJobs, type UseBackgroundVoiceJobsResult } from "./useBackgroundVoiceJobs";

const createVoiceJobMock = vi.hoisted(() => vi.fn());
const fetchLatestVoiceJobMock = vi.hoisted(() => vi.fn());
const fetchVoiceJobMock = vi.hoisted(() => vi.fn());
const markVoiceJobRecoveredMock = vi.hoisted(() => vi.fn());
const transcribeAudioMock = vi.hoisted(() => vi.fn());

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    createVoiceJob: (...args: unknown[]) => createVoiceJobMock(...args),
    fetchLatestVoiceJob: (...args: unknown[]) => fetchLatestVoiceJobMock(...args),
    fetchVoiceJob: (...args: unknown[]) => fetchVoiceJobMock(...args),
    markVoiceJobRecovered: (...args: unknown[]) => markVoiceJobRecoveredMock(...args),
    transcribeAudio: (...args: unknown[]) => transcribeAudioMock(...args),
  };
});

type HookOptions = Parameters<typeof useBackgroundVoiceJobs>[0];

function waitTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await act(async () => {
      await waitTick();
    });
  }
  throw new Error("Timed out waiting for condition");
}

function voiceJobSnapshot(status: "accepted" | "done" = "accepted") {
  return {
    id: "voice-job-1",
    composerKey: "session-1",
    targetSessionId: "session-1",
    status,
    safeToLeave: true,
    createdAt: "2026-05-06T00:00:00.000Z",
    updatedAt: "2026-05-06T00:00:00.000Z",
  };
}

describe("useBackgroundVoiceJobs retry uploads", () => {
  let dom: ReturnType<typeof installDomShim> | null = null;
  let root: Root | null = null;
  let result: UseBackgroundVoiceJobsResult | null = null;
  let getDraftMock: ReturnType<typeof vi.fn>;
  let setDraftMock: ReturnType<typeof vi.fn>;
  let options: HookOptions;
  let previousActEnvironment: boolean | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    previousActEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    dom = installDomShim();
    result = null;
    getDraftMock = vi.fn(() => null);
    setDraftMock = vi.fn();
    options = {
      activeComposerKey: null,
      getDraft: getDraftMock,
      setDraft: setDraftMock,
      setDraftImmediate: vi.fn(),
      clearDraft: vi.fn(),
      rememberDraftSession: vi.fn(),
      clearDraftSession: vi.fn(),
      materializeSession: vi.fn().mockResolvedValue("session-1"),
      isSessionBusy: vi.fn(() => false),
      navigateToSession: vi.fn(),
      refreshSessions: vi.fn(),
      refreshTasks: vi.fn(),
    };

    function Harness() {
      result = useBackgroundVoiceJobs(options);
      return null;
    }

    root = createRoot(dom.container as unknown as Element);
    await act(async () => {
      root?.render(createElement(Harness));
    });
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
    }
    dom?.cleanup();
    if (previousActEnvironment === undefined) {
      delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    } else {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    }
    root = null;
    dom = null;
    result = null;
  });

  it("offers a retryable autosend error and retries with the original mode and audio blob", async () => {
    const audio = new Blob(["voice"], { type: "audio/wav" });
    createVoiceJobMock.mockRejectedValueOnce(new Error("Network timeout"));

    await act(async () => {
      await result?.startBackgroundVoiceJob({
        composerKey: "session-1",
        audio,
        submitMode: "autosend",
      });
    });

    await waitUntil(() => result?.getJobForComposer("session-1")?.status === "error");
    expect(result?.getJobForComposer("session-1")).toMatchObject({
      status: "error",
      submitMode: "autosend",
      error: "Network timeout",
      retryable: true,
      serverOwned: true,
    });

    createVoiceJobMock.mockResolvedValueOnce(voiceJobSnapshot());
    getDraftMock.mockReturnValue({ text: "Typed while offline" });
    await act(async () => {
      result?.retryVoiceJobUpload("session-1");
      result?.retryVoiceJobUpload("session-1");
    });

    await waitUntil(() => result?.getJobForComposer("session-1")?.status === "accepted");
    expect(createVoiceJobMock).toHaveBeenCalledTimes(2);
    expect(createVoiceJobMock.mock.calls[1][1]).toBe(audio);
    expect(transcribeAudioMock).not.toHaveBeenCalled();
  });

  it("retries local transcription upload failures and inserts the retried transcript", async () => {
    const audio = new Blob(["voice"], { type: "audio/wav" });
    transcribeAudioMock.mockRejectedValueOnce(new Error("Failed to fetch"));

    await act(async () => {
      await result?.startBackgroundVoiceJob({
        composerKey: "session-1",
        audio,
        submitMode: "insert",
      });
    });

    await waitUntil(() => result?.getJobForComposer("session-1")?.status === "error");
    expect(result?.getJobForComposer("session-1")).toMatchObject({
      status: "error",
      submitMode: "insert",
      error: "Failed to fetch",
      retryable: true,
    });

    transcribeAudioMock.mockResolvedValueOnce({ text: "Retried transcript", provider: "whisper.cpp" });
    await act(async () => {
      result?.retryVoiceJobUpload("session-1");
    });

    await waitUntil(() => result?.getJobForComposer("session-1") === null);
    expect(transcribeAudioMock).toHaveBeenCalledTimes(2);
    expect(transcribeAudioMock.mock.calls[1][0]).toBe(audio);
    expect(setDraftMock).toHaveBeenCalledWith("session-1", "Retried transcript", undefined);
  });

  it("drops retained retry audio when the voice job error is cleared", async () => {
    const audio = new Blob(["voice"], { type: "audio/wav" });
    createVoiceJobMock.mockRejectedValueOnce(new Error("Network timeout"));

    await act(async () => {
      await result?.startBackgroundVoiceJob({
        composerKey: "session-1",
        audio,
        submitMode: "autosend",
      });
    });

    await waitUntil(() => result?.getJobForComposer("session-1")?.status === "error");
    await act(async () => {
      result?.clearVoiceJobError("session-1");
      result?.retryVoiceJobUpload("session-1");
    });

    expect(result?.getJobForComposer("session-1")).toBeNull();
    expect(createVoiceJobMock).toHaveBeenCalledTimes(1);
  });
});
