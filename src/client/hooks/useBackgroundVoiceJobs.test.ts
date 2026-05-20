import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createReactDomHarness,
  waitUntilAct,
  type ReactDomHarness,
} from "../test-react-harness";
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
type GetDraft = HookOptions["getDraft"];
type SetDraft = HookOptions["setDraft"];

type VoiceJobSnapshotStatus = "accepted" | "transcribing" | "sending" | "done" | "error" | "recovered";

function voiceJobSnapshot(overrides: Partial<{
  id: string;
  composerKey: string;
  taskId: string;
  targetSessionId: string;
  status: VoiceJobSnapshotStatus;
  safeToLeave: true;
  createdAt: string;
  updatedAt: string;
}> = {}) {
  return {
    id: "voice-job-1",
    composerKey: "session-1",
    targetSessionId: "session-1",
    status: "accepted" as const,
    safeToLeave: true,
    createdAt: "2026-05-06T00:00:00.000Z",
    updatedAt: "2026-05-06T00:00:00.000Z",
    ...overrides,
  };
}

describe("useBackgroundVoiceJobs retry uploads", () => {
  let harness: ReactDomHarness | null = null;
  let result: UseBackgroundVoiceJobsResult | null = null;
  let getDraftMock: ReturnType<typeof vi.fn<GetDraft>>;
  let setDraftMock: ReturnType<typeof vi.fn<SetDraft>>;
  let options: HookOptions;

  function getHarness() {
    if (!harness) throw new Error("Hook harness has not been initialized");
    return harness;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    harness = await createReactDomHarness();
    result = null;
    getDraftMock = vi.fn<GetDraft>(() => null);
    setDraftMock = vi.fn<SetDraft>();
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
      onVoiceSessionActivity: vi.fn(),
      onVoiceSessionSettled: vi.fn(),
    };

    function Harness() {
      result = useBackgroundVoiceJobs(options);
      return null;
    }

    await harness.render(createElement(Harness));
  });

  afterEach(async () => {
    await harness?.cleanup();
    harness = null;
    result = null;
  });

  it("offers a retryable autosend error and retries with the original mode and audio blob", async () => {
    const audio = new Blob(["voice"], { type: "audio/wav" });
    createVoiceJobMock.mockRejectedValueOnce(new Error("Network timeout"));

    await getHarness().act(async () => {
      await result?.startBackgroundVoiceJob({
        composerKey: "session-1",
        audio,
        submitMode: "autosend",
      });
    });

    await waitUntilAct(getHarness().act, () => result?.getJobForComposer("session-1")?.status === "error");
    expect(result?.getJobForComposer("session-1")).toMatchObject({
      status: "error",
      submitMode: "autosend",
      error: "Network timeout",
      retryable: true,
      serverOwned: true,
    });
    expect(options.onVoiceSessionActivity).toHaveBeenCalledWith({
      sessionId: "session-1",
      status: "uploading",
      statusChanged: true,
    });
    expect(options.onVoiceSessionSettled).toHaveBeenCalledWith({
      sessionId: "session-1",
      status: "error",
    });

    createVoiceJobMock.mockResolvedValueOnce(voiceJobSnapshot());
    getDraftMock.mockReturnValue({ text: "Typed while offline" });
    await getHarness().act(async () => {
      result?.retryVoiceJobUpload("session-1");
      result?.retryVoiceJobUpload("session-1");
    });

    await waitUntilAct(getHarness().act, () => result?.getJobForComposer("session-1")?.status === "accepted");
    expect(createVoiceJobMock).toHaveBeenCalledTimes(2);
    expect(createVoiceJobMock.mock.calls[1][1]).toBe(audio);
    expect(transcribeAudioMock).not.toHaveBeenCalled();
  });

  it("notifies existing target session activity immediately when autosend upload starts", async () => {
    const audio = new Blob(["voice"], { type: "audio/wav" });
    createVoiceJobMock.mockResolvedValueOnce(voiceJobSnapshot());

    await getHarness().act(async () => {
      await result?.startBackgroundVoiceJob({
        composerKey: "session-1",
        audio,
        submitMode: "autosend",
      });
    });

    expect(options.onVoiceSessionActivity).toHaveBeenCalledWith({
      sessionId: "session-1",
      status: "uploading",
      statusChanged: true,
    });
    await waitUntilAct(getHarness().act, () => result?.getJobForComposer("session-1")?.status === "accepted");
    expect(options.onVoiceSessionActivity).toHaveBeenCalledWith({
      sessionId: "session-1",
      status: "accepted",
      statusChanged: true,
    });
  });

  it("notifies draft target session activity when the server accepts an autosend", async () => {
    const audio = new Blob(["voice"], { type: "audio/wav" });
    createVoiceJobMock.mockResolvedValueOnce(voiceJobSnapshot({
      composerKey: "draft:task:task-1",
      taskId: "task-1",
      targetSessionId: "new-session",
    }));

    await getHarness().act(async () => {
      await result?.startBackgroundVoiceJob({
        composerKey: "draft:task:task-1",
        audio,
        submitMode: "autosend",
      });
    });

    await waitUntilAct(getHarness().act, () => result?.getJobForComposer("new-session")?.status === "accepted");
    expect(options.onVoiceSessionActivity).toHaveBeenCalledWith({
      sessionId: "new-session",
      taskId: "task-1",
      status: "accepted",
      statusChanged: true,
    });
    expect(options.rememberDraftSession).toHaveBeenCalledWith("draft:task:task-1", "new-session");
  });

  it("notifies session activity when autosend completes before the client observes sending", async () => {
    const audio = new Blob(["voice"], { type: "audio/wav" });
    createVoiceJobMock.mockResolvedValueOnce(voiceJobSnapshot({
      status: "done",
    }));

    await getHarness().act(async () => {
      await result?.startBackgroundVoiceJob({
        composerKey: "session-1",
        audio,
        submitMode: "autosend",
      });
    });

    await waitUntilAct(getHarness().act, () => result?.getJobForComposer("session-1") === null);
    expect(options.onVoiceSessionActivity).toHaveBeenCalledWith({
      sessionId: "session-1",
      status: "sending",
      statusChanged: true,
    });
    expect(options.onVoiceSessionSettled).toHaveBeenCalledWith({
      sessionId: "session-1",
      status: "done",
    });
  });

  it("retries local transcription upload failures and inserts the retried transcript", async () => {
    const audio = new Blob(["voice"], { type: "audio/wav" });
    transcribeAudioMock.mockRejectedValueOnce(new Error("Failed to fetch"));

    await getHarness().act(async () => {
      await result?.startBackgroundVoiceJob({
        composerKey: "session-1",
        audio,
        submitMode: "insert",
      });
    });

    await waitUntilAct(getHarness().act, () => result?.getJobForComposer("session-1")?.status === "error");
    expect(result?.getJobForComposer("session-1")).toMatchObject({
      status: "error",
      submitMode: "insert",
      error: "Failed to fetch",
      retryable: true,
    });

    transcribeAudioMock.mockResolvedValueOnce({ text: "Retried transcript", provider: "whisper.cpp" });
    await getHarness().act(async () => {
      result?.retryVoiceJobUpload("session-1");
    });

    await waitUntilAct(getHarness().act, () => result?.getJobForComposer("session-1") === null);
    expect(transcribeAudioMock).toHaveBeenCalledTimes(2);
    expect(transcribeAudioMock.mock.calls[1][0]).toBe(audio);
    expect(setDraftMock).toHaveBeenCalledWith("session-1", "Retried transcript", undefined);
  });

  it("drops retained retry audio when the voice job error is cleared", async () => {
    const audio = new Blob(["voice"], { type: "audio/wav" });
    createVoiceJobMock.mockRejectedValueOnce(new Error("Network timeout"));

    await getHarness().act(async () => {
      await result?.startBackgroundVoiceJob({
        composerKey: "session-1",
        audio,
        submitMode: "autosend",
      });
    });

    await waitUntilAct(getHarness().act, () => result?.getJobForComposer("session-1")?.status === "error");
    await getHarness().act(async () => {
      result?.clearVoiceJobError("session-1");
      result?.retryVoiceJobUpload("session-1");
    });

    expect(result?.getJobForComposer("session-1")).toBeNull();
    expect(createVoiceJobMock).toHaveBeenCalledTimes(1);
  });
});
