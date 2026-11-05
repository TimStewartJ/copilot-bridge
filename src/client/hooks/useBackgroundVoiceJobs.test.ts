import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createReactDomHarness,
  waitUntilAct,
  type ReactDomHarness,
} from "../test-react-harness";
import { whenPageReloadSafe } from "../lib/voice-capture-guard";
import {
  __resetVoiceRecordingStoreForTests,
  getPendingVoiceRecording,
  patchPendingVoiceRecording,
  savePendingVoiceRecording,
} from "../lib/voice-recording-store";
import { useBackgroundVoiceJobs, type UseBackgroundVoiceJobsResult } from "./useBackgroundVoiceJobs";

const createVoiceJobMock = vi.hoisted(() => vi.fn());
const fetchLatestVoiceJobMock = vi.hoisted(() => vi.fn());
const fetchOpenVoiceJobsMock = vi.hoisted(() => vi.fn(async (): Promise<unknown[]> => []));
const fetchVoiceJobMock = vi.hoisted(() => vi.fn());
const markVoiceJobRecoveredMock = vi.hoisted(() => vi.fn());
const transcribeAudioMock = vi.hoisted(() => vi.fn());

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    createVoiceJob: (...args: unknown[]) => createVoiceJobMock(...args),
    fetchLatestVoiceJob: (...args: unknown[]) => fetchLatestVoiceJobMock(...args),
    fetchOpenVoiceJobs: () => fetchOpenVoiceJobsMock(),
    fetchVoiceJob: (...args: unknown[]) => fetchVoiceJobMock(...args),
    markVoiceJobRecovered: (...args: unknown[]) => markVoiceJobRecoveredMock(...args),
    transcribeAudio: (...args: unknown[]) => transcribeAudioMock(...args),
  };
});

type HookOptions = Parameters<typeof useBackgroundVoiceJobs>[0];
type GetDraft = HookOptions["getDraft"];
type SetDraft = HookOptions["setDraft"];

const CLEAN_COVERAGE = { largestGapSeconds: 0.4, gapStartSeconds: 0 };

type VoiceJobSnapshotStatus = "accepted" | "transcribing" | "sending" | "done" | "error" | "held" | "recovered";

function voiceJobSnapshot(overrides: Partial<{
  id: string;
  composerKey: string;
  taskId: string;
  targetSessionId: string;
  status: VoiceJobSnapshotStatus;
  safeToLeave: true;
  createdAt: string;
  updatedAt: string;
  error: string;
  transcript: string;
  reviewReason: "coverage" | "unchecked";
  speechGapStart: number;
  mode: "interactive" | "autopilot";
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
    __resetVoiceRecordingStoreForTests();
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
    __resetVoiceRecordingStoreForTests();
  });

  it("keeps the original recording and mode retryable after its network error is dismissed", async () => {
    const audio = new Blob(["voice"], { type: "audio/wav" });
    createVoiceJobMock.mockRejectedValueOnce(new Error("Network timeout"));

    await getHarness().act(async () => {
      expect(await result?.startBackgroundVoiceJob({
        composerKey: "session-1",
        audio,
        submitMode: "autosend",
        sendMode: "autopilot",
      })).toBe("autosend");
    });
    expect(createVoiceJobMock.mock.calls[0][0]).toMatchObject({ composerKey: "session-1", mode: "autopilot" });
    expect(await getPendingVoiceRecording("session-1")).toMatchObject({ sendMode: "autopilot" });

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

    await getHarness().act(async () => { result?.clearVoiceJobError("session-1"); });
    expect(result?.getJobForComposer("session-1")).toMatchObject({ status: "error", retryable: true });
    createVoiceJobMock.mockResolvedValueOnce(voiceJobSnapshot());
    await getHarness().act(async () => {
      result?.retryVoiceJobUpload("session-1");
      result?.retryVoiceJobUpload("session-1");
    });

    await waitUntilAct(getHarness().act, () => result?.getJobForComposer("session-1")?.status === "accepted");
    expect(createVoiceJobMock).toHaveBeenCalledTimes(2);
    expect(createVoiceJobMock.mock.calls[1][1]).toBe(audio);
    expect(createVoiceJobMock.mock.calls[1][0]).toMatchObject({ composerKey: "session-1", mode: "autopilot" });
    expect(transcribeAudioMock).not.toHaveBeenCalled();
  });

  it("drops the send mode when a recording is put in the composer", async () => {
    transcribeAudioMock.mockResolvedValueOnce({ text: "more words", provider: "speech-engine" });

    let delivered: Awaited<ReturnType<UseBackgroundVoiceJobsResult["startBackgroundVoiceJob"]>> | undefined;
    await getHarness().act(async () => {
      delivered = await result?.startBackgroundVoiceJob({
        composerKey: "session-1",
        audio: new Blob(["voice"], { type: "audio/wav" }),
        submitMode: "insert",
        sendMode: "autopilot",
      });
    });

    expect(delivered).toBe("insert");
    expect(createVoiceJobMock).not.toHaveBeenCalled();
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

  it("retries a draft autosend with its persisted launch configuration", async () => {
    const audio = new Blob(["voice"], { type: "audio/wav" });
    const sessionOptions = {
      model: "gpt-5.6-sol",
      reasoningEffort: "xhigh",
      contextTier: "long_context" as const,
    };
    createVoiceJobMock.mockRejectedValueOnce(new Error("Network timeout"));

    await getHarness().act(async () => {
      await result?.startBackgroundVoiceJob({
        composerKey: "draft:task:task-1",
        audio,
        submitMode: "autosend",
        sessionOptions,
      });
    });
    await waitUntilAct(
      getHarness().act,
      () => result?.getJobForComposer("draft:task:task-1")?.status === "error",
    );

    expect(await getPendingVoiceRecording("draft:task:task-1")).toMatchObject({
      sessionOptions,
    });
    expect(createVoiceJobMock.mock.calls[0][0]).toMatchObject({ sessionOptions });

    createVoiceJobMock.mockResolvedValueOnce(voiceJobSnapshot({
      composerKey: "draft:task:task-1",
      taskId: "task-1",
      targetSessionId: "new-session",
    }));
    await getHarness().act(async () => {
      result?.retryVoiceJobUpload("draft:task:task-1");
    });
    await waitUntilAct(getHarness().act, () => createVoiceJobMock.mock.calls.length === 2);

    expect(createVoiceJobMock.mock.calls[1][0]).toMatchObject({ sessionOptions });
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
      jobId: "voice-job-1",
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

    transcribeAudioMock.mockResolvedValueOnce({ text: "Retried transcript", provider: "speech-engine", coverage: CLEAN_COVERAGE });
    await getHarness().act(async () => {
      result?.retryVoiceJobUpload("session-1");
    });

    await waitUntilAct(getHarness().act, () => result?.getJobForComposer("session-1") === null);
    expect(transcribeAudioMock).toHaveBeenCalledTimes(2);
    expect(transcribeAudioMock.mock.calls[1][0]).toBe(audio);
    // Transcripts are persisted immediately so a reload cannot lose both the audio and the text.
    expect(options.setDraftImmediate).toHaveBeenCalledWith("session-1", "Retried transcript", undefined);
  });

  it("holds the page while a recording uploads, reports how much has been sent, then moves an insert on to transcribing", async () => {
    type UploadOptions = { onUploadProgress: (fraction: number) => void };
    const audio = new Blob(["voice"], { type: "audio/wav" });
    let autosendUpload: UploadOptions | undefined;
    let finishAutosend = (_snapshot: ReturnType<typeof voiceJobSnapshot>) => {};
    createVoiceJobMock.mockImplementationOnce((_request: unknown, _audio: Blob, uploadOptions: UploadOptions) => {
      autosendUpload = uploadOptions;
      return new Promise((resolve) => {
        finishAutosend = resolve;
      });
    });

    await getHarness().act(async () => {
      await result?.startBackgroundVoiceJob({ composerKey: "session-1", audio, submitMode: "autosend" });
    });
    expect(options.onVoiceSessionActivity).toHaveBeenCalledWith({
      sessionId: "session-1",
      status: "uploading",
      statusChanged: true,
    });
    const reloadAfterAutosend = vi.fn();
    whenPageReloadSafe(reloadAfterAutosend);
    await getHarness().act(async () => {
      autosendUpload?.onUploadProgress(0.429);
    });
    expect(result?.getJobForComposer("session-1")).toMatchObject({ status: "uploading", uploadPercent: 42 });
    await getHarness().act(async () => {
      autosendUpload?.onUploadProgress(1);
    });
    expect(result?.getJobForComposer("session-1")).toMatchObject({ status: "uploading", uploadPercent: 100 });
    expect(reloadAfterAutosend).not.toHaveBeenCalled();
    finishAutosend(voiceJobSnapshot());
    await waitUntilAct(getHarness().act, () => result?.getJobForComposer("session-1")?.status === "accepted");
    expect(reloadAfterAutosend).toHaveBeenCalledOnce();
    expect(options.onVoiceSessionActivity).toHaveBeenCalledWith({
      sessionId: "session-1",
      status: "accepted",
      statusChanged: true,
    });

    let insertUpload: UploadOptions | undefined;
    let finishInsert = (_result: { text: string; provider: string; coverage?: unknown }) => {};
    transcribeAudioMock.mockImplementationOnce((_audio: Blob, uploadOptions: UploadOptions) => {
      insertUpload = uploadOptions;
      return new Promise((resolve) => {
        finishInsert = resolve;
      });
    });

    await getHarness().act(async () => {
      await result?.startBackgroundVoiceJob({ composerKey: "session-2", audio, submitMode: "insert" });
    });
    const reloadAfterInsert = vi.fn();
    whenPageReloadSafe(reloadAfterInsert);
    await getHarness().act(async () => {
      insertUpload?.onUploadProgress(0.5);
    });
    expect(result?.getJobForComposer("session-2")).toMatchObject({ status: "uploading", uploadPercent: 50 });
    await getHarness().act(async () => {
      insertUpload?.onUploadProgress(1);
    });
    expect(result?.getJobForComposer("session-2")).toMatchObject({ status: "transcribing", submitMode: "insert" });
    expect(reloadAfterInsert).not.toHaveBeenCalled();
    finishInsert({ text: "Done", provider: "speech-engine", coverage: CLEAN_COVERAGE });
    await waitUntilAct(getHarness().act, () => result?.getJobForComposer("session-2") === null);
    expect(reloadAfterInsert).toHaveBeenCalledOnce();
  });

  it("retains the failed upload and its reason until the reader explicitly discards the audio", async () => {
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
    const stored = await getPendingVoiceRecording("session-1");
    expect(stored).toMatchObject({ composerKey: "session-1", submitMode: "autosend" });
    expect(stored?.audio.byteLength).toBe(5);
    expect(stored?.lastError).toBe("Network timeout");

    await getHarness().act(async () => {
      result?.discardVoiceRecording("session-1");
    });

    await waitUntilAct(getHarness().act, () => result?.getJobForComposer("session-1") === null);
    expect(await getPendingVoiceRecording("session-1")).toBeNull();

    await getHarness().act(async () => {
      result?.retryVoiceJobUpload("session-1");
    });
    expect(createVoiceJobMock).toHaveBeenCalledTimes(1);
  });

  it("retires a failed server job without a transcript when its recording is discarded", async () => {
    createVoiceJobMock.mockResolvedValueOnce(voiceJobSnapshot({
      status: "error",
      error: "No speech was detected in the recording.",
    }));
    markVoiceJobRecoveredMock.mockResolvedValue(null);

    await getHarness().act(async () => {
      await result?.startBackgroundVoiceJob({
        composerKey: "session-1",
        audio: new Blob(["voice"], { type: "audio/ogg" }),
        submitMode: "autosend",
      });
    });

    await waitUntilAct(getHarness().act, () => result?.getJobForComposer("session-1")?.retryable === true);
    await getHarness().act(async () => {
      result?.discardVoiceRecording("session-1");
    });

    await waitUntilAct(getHarness().act, () => result?.getJobForComposer("session-1") === null);
    expect(markVoiceJobRecoveredMock).toHaveBeenCalledExactlyOnceWith("voice-job-1");
  });

  it("keeps a failed server job that still holds an unrecovered transcript when its recording is discarded", async () => {
    createVoiceJobMock.mockResolvedValueOnce(voiceJobSnapshot({
      status: "error",
      error: "Auto-send failed.",
      transcript: "dictated words",
    }));

    await getHarness().act(async () => {
      await result?.startBackgroundVoiceJob({
        composerKey: "session-1",
        audio: new Blob(["voice"], { type: "audio/ogg" }),
        submitMode: "autosend",
      });
    });

    await waitUntilAct(getHarness().act, () => result?.getJobForComposer("session-1")?.retryable === true);
    await getHarness().act(async () => {
      result?.discardVoiceRecording("session-1");
    });

    await waitUntilAct(getHarness().act, () => result?.getJobForComposer("session-1") === null);
    expect(markVoiceJobRecoveredMock).not.toHaveBeenCalled();
  });

  it("refuses to overwrite an unsent recording that is still pending for the same composer", async () => {
    const first = new Blob(["voice"], { type: "audio/wav" });
    createVoiceJobMock.mockRejectedValueOnce(new Error("Network timeout"));

    await getHarness().act(async () => {
      await result?.startBackgroundVoiceJob({
        composerKey: "session-1",
        audio: first,
        submitMode: "autosend",
      });
    });
    await waitUntilAct(getHarness().act, () => result?.getJobForComposer("session-1")?.status === "error");
    const storedId = (await getPendingVoiceRecording("session-1"))?.recordingId;

    await getHarness().act(async () => {
      await result?.startBackgroundVoiceJob({
        composerKey: "session-1",
        audio: new Blob(["second recording"], { type: "audio/wav" }),
        submitMode: "autosend",
      });
    });

    expect(result?.getJobForComposer("session-1")?.error).toBe(
      "Kept the earlier unsent recording — retry or discard it before recording again.",
    );
    expect((await getPendingVoiceRecording("session-1"))?.recordingId).toBe(storedId);
    expect(createVoiceJobMock).toHaveBeenCalledTimes(1);
  });

  it("moves an unsent recording to the session a draft materialized into", async () => {
    const audio = new Blob(["voice"], { type: "audio/wav" });
    createVoiceJobMock.mockRejectedValueOnce(new Error("Network timeout"));

    await getHarness().act(async () => {
      await result?.startBackgroundVoiceJob({
        composerKey: "draft:task:task-1",
        audio,
        submitMode: "autosend",
      });
    });
    await waitUntilAct(getHarness().act, () => result?.getJobForComposer("draft:task:task-1")?.status === "error");

    await getHarness().act(async () => {
      result?.migrateVoiceRecording("draft:task:task-1", "session-9");
    });

    await waitUntilAct(getHarness().act, () => result?.getJobForComposer("session-9")?.retryable === true);
    expect(result?.getJobForComposer("draft:task:task-1")).toBeNull();
    expect(await getPendingVoiceRecording("draft:task:task-1")).toBeNull();
    expect(await getPendingVoiceRecording("session-9")).toMatchObject({ composerKey: "session-9" });
  });
});

describe("useBackgroundVoiceJobs restart recovery", () => {
  let harness: ReactDomHarness | null = null;
  let result: UseBackgroundVoiceJobsResult | null = null;

  function getHarness() {
    if (!harness) throw new Error("Hook harness has not been initialized");
    return harness;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    __resetVoiceRecordingStoreForTests();
    fetchLatestVoiceJobMock.mockResolvedValue(null);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await harness?.cleanup();
    harness = null;
    result = null;
    __resetVoiceRecordingStoreForTests();
  });

  // A job found at start is followed by a poll on a timer, which a test runs itself instead of waiting for it.
  async function runNextPoll() {
    await waitUntilAct(getHarness().act, () => vi.getTimerCount() > 0);
    await getHarness().act(async () => {
      await vi.advanceTimersToNextTimerAsync();
    });
  }

  async function renderWithActiveComposer(activeComposerKey: string, overrides: Partial<HookOptions> = {}) {
    harness = await createReactDomHarness();
    function Harness() {
      result = useBackgroundVoiceJobs({
        activeComposerKey,
        getDraft: () => null,
        setDraft: vi.fn(),
        setDraftImmediate: vi.fn(),
        clearDraft: vi.fn(),
        rememberDraftSession: vi.fn(),
        clearDraftSession: vi.fn(),
        materializeSession: vi.fn().mockResolvedValue("session-1"),
        navigateToSession: vi.fn(),
        refreshSessions: vi.fn(),
        refreshTasks: vi.fn(),
        ...overrides,
      });
      return null;
    }
    await harness.render(createElement(Harness));
  }

  it("restores a recording persisted by a previous app run as a retryable job", async () => {
    await savePendingVoiceRecording({
      composerKey: "session-1",
      recordingId: "rec-1",
      submitMode: "autosend",
      audio: new TextEncoder().encode("voice").buffer as ArrayBuffer,
      mimeType: "audio/wav",
    });

    await renderWithActiveComposer("session-1");

    await waitUntilAct(getHarness().act, () => result?.getJobForComposer("session-1")?.retryable === true);
    expect(result?.getJobForComposer("session-1")).toMatchObject({
      status: "error",
      submitMode: "autosend",
      restored: true,
      retryable: true,
    });

    createVoiceJobMock.mockResolvedValueOnce(voiceJobSnapshot());
    await getHarness().act(async () => {
      result?.retryVoiceJobUpload("session-1");
    });

    await waitUntilAct(getHarness().act, () => result?.getJobForComposer("session-1")?.status === "accepted");
    expect(createVoiceJobMock).toHaveBeenCalledTimes(1);
  });

  it("resumes an already accepted server job instead of re-uploading the recording", async () => {
    await savePendingVoiceRecording({
      composerKey: "session-1",
      recordingId: "rec-2",
      submitMode: "autosend",
      audio: new TextEncoder().encode("voice").buffer as ArrayBuffer,
      mimeType: "audio/wav",
    });
    await patchPendingVoiceRecording("session-1", "rec-2", { serverJobId: "voice-job-1" });
    fetchVoiceJobMock.mockResolvedValue(voiceJobSnapshot({ status: "transcribing" }));

    await renderWithActiveComposer("session-1");

    await waitUntilAct(getHarness().act, () => result?.getJobForComposer("session-1")?.status === "transcribing");
    expect(createVoiceJobMock).not.toHaveBeenCalled();
    expect(fetchLatestVoiceJobMock).not.toHaveBeenCalled();
  });

  it("never reuploads after an inconclusive retry check and retires that failed job only on discard", async () => {
    await savePendingVoiceRecording({
      composerKey: "session-1",
      recordingId: "rec-5",
      submitMode: "autosend",
      audio: new TextEncoder().encode("voice").buffer as ArrayBuffer,
      mimeType: "audio/ogg",
    });
    await patchPendingVoiceRecording("session-1", "rec-5", { serverJobId: "voice-job-1" });
    fetchVoiceJobMock.mockResolvedValueOnce(voiceJobSnapshot({
      status: "error",
    }));
    markVoiceJobRecoveredMock.mockResolvedValue(null);

    await renderWithActiveComposer("session-1");
    await waitUntilAct(getHarness().act, () => result?.getJobForComposer("session-1")?.retryable === true);

    expect(result?.getJobForComposer("session-1")).toMatchObject({ status: "error", error: "Auto-send failed." });
    expect(await getPendingVoiceRecording("session-1")).not.toBeNull();
    fetchVoiceJobMock.mockRejectedValue(new Error("Failed to fetch"));
    await getHarness().act(async () => {
      result?.retryVoiceJobUpload("session-1");
    });
    await waitUntilAct(
      getHarness().act,
      () => result?.getJobForComposer("session-1")?.error
        === "Could not reach the server to check the earlier send. Try again.",
    );

    // The recording is kept and no duplicate message is sent.
    expect(createVoiceJobMock).not.toHaveBeenCalled();
    expect(result?.getJobForComposer("session-1")?.retryable).toBe(true);
    expect(await getPendingVoiceRecording("session-1")).not.toBeNull();

    await getHarness().act(async () => {
      result?.discardVoiceRecording("session-1");
    });

    expect(result?.getJobForComposer("session-1")).toBeNull();
    expect(markVoiceJobRecoveredMock).toHaveBeenCalledExactlyOnceWith("voice-job-1");
  });

  it("puts a held dictation in the open draft once and says why it was held", async () => {
    fetchLatestVoiceJobMock.mockResolvedValue(voiceJobSnapshot({
      status: "held",
      transcript: "words to check",
      reviewReason: "coverage",
      speechGapStart: 7,
      mode: "autopilot",
    }));
    markVoiceJobRecoveredMock.mockResolvedValue(null);
    const setDraftImmediate = vi.fn();
    const onVoiceSessionSettled = vi.fn();

    await renderWithActiveComposer("session-1", { setDraftImmediate, onVoiceSessionSettled });
    await waitUntilAct(getHarness().act, () => result?.getJobForComposer("session-1")?.status === "review");

    expect(result?.getJobForComposer("session-1")?.sendMode).toBe("autopilot");
    expect(onVoiceSessionSettled).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sessionId: "session-1", status: "recovered" }));
    expect(setDraftImmediate).toHaveBeenCalledExactlyOnceWith("session-1", "words to check", undefined);
    expect(markVoiceJobRecoveredMock).toHaveBeenCalledExactlyOnceWith("voice-job-1");
    expect(result?.getJobForComposer("session-1")?.review).toEqual({
      reason: "coverage",
      recordingJobId: "voice-job-1",
      gapStartSeconds: 7,
    });

    await getHarness().act(async () => {
      result?.clearVoiceJobError("session-1");
    });
    expect(result?.getJobForComposer("session-1")).toBeNull();
    expect(markVoiceJobRecoveredMock).toHaveBeenCalledOnce();
  });

  it("leaves a held dictation on the server until its conversation is open", async () => {
    fetchLatestVoiceJobMock.mockResolvedValue(voiceJobSnapshot({
      composerKey: "session-2",
      targetSessionId: "session-2",
      status: "held",
      transcript: "words to check",
      reviewReason: "coverage",
    }));
    const setDraftImmediate = vi.fn();
    const onVoiceSessionSettled = vi.fn();

    await renderWithActiveComposer("session-1", { setDraftImmediate, onVoiceSessionSettled });
    await waitUntilAct(getHarness().act, () => onVoiceSessionSettled.mock.calls.length > 0);

    expect(onVoiceSessionSettled).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sessionId: "session-2", status: "held" }));
    expect(setDraftImmediate).not.toHaveBeenCalled();
    expect(markVoiceJobRecoveredMock).not.toHaveBeenCalled();
    expect(result?.getJobForComposer("session-2")).toBeNull();
  });

  it("tells about a dictation held while the app was not running, even after following it to the end", async () => {
    const heldElsewhere = { composerKey: "session-2", targetSessionId: "session-2", transcript: "words to check", reviewReason: "coverage" as const };
    fetchOpenVoiceJobsMock.mockResolvedValueOnce([
      voiceJobSnapshot({ ...heldElsewhere, id: "already-held", status: "held" }),
      voiceJobSnapshot({ ...heldElsewhere, id: "still-running", status: "transcribing" }),
    ]);
    fetchVoiceJobMock.mockResolvedValue(voiceJobSnapshot({ ...heldElsewhere, id: "still-running", status: "held" }));
    const setDraftImmediate = vi.fn();
    const onVoiceSessionSettled = vi.fn();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    await renderWithActiveComposer("session-1", { setDraftImmediate, onVoiceSessionSettled });
    await runNextPoll();
    await waitUntilAct(getHarness().act, () => onVoiceSessionSettled.mock.calls.length === 2);

    expect(onVoiceSessionSettled.mock.calls.map(([settled]) => [settled.jobId, settled.status])).toEqual([
      ["already-held", "held"],
      ["still-running", "held"],
    ]);
    expect(setDraftImmediate).not.toHaveBeenCalled();
    expect(markVoiceJobRecoveredMock).not.toHaveBeenCalled();
  });

  it("keeps this device's failed upload when a job found at start finishes in the same chat", async () => {
    await savePendingVoiceRecording({
      composerKey: "session-2",
      recordingId: "failed-upload",
      submitMode: "autosend",
      audio: new TextEncoder().encode("voice").buffer as ArrayBuffer,
      mimeType: "audio/ogg",
    });
    const job = { composerKey: "session-2", targetSessionId: "session-2", id: "found-at-start" };
    fetchOpenVoiceJobsMock.mockResolvedValueOnce([voiceJobSnapshot({ ...job, status: "transcribing" })]);
    fetchVoiceJobMock.mockResolvedValue(voiceJobSnapshot({ ...job, status: "done", transcript: "words" }));
    const onVoiceSessionSettled = vi.fn();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    await renderWithActiveComposer("session-1", { onVoiceSessionSettled });
    await runNextPoll();
    await waitUntilAct(getHarness().act, () => onVoiceSessionSettled.mock.calls.length > 0);

    expect(await getPendingVoiceRecording("session-2")).toMatchObject({ recordingId: "failed-upload" });
  });

  it("does not put a held dictation in another chat's draft when a new draft is open", async () => {
    fetchLatestVoiceJobMock.mockResolvedValue(voiceJobSnapshot({
      composerKey: "draft:task:task-1",
      targetSessionId: "session-9",
      status: "held",
      transcript: "words to check",
      reviewReason: "coverage",
    }));
    const setDraftImmediate = vi.fn();
    const onVoiceSessionSettled = vi.fn();

    // The person has started typing something new in the draft the dictation came from.
    await renderWithActiveComposer("draft:task:task-1", {
      getDraft: () => ({ text: "something else", attachments: [] }) as ReturnType<GetDraft>,
      setDraftImmediate,
      onVoiceSessionSettled,
    });
    await waitUntilAct(getHarness().act, () => onVoiceSessionSettled.mock.calls.length > 0);

    expect(onVoiceSessionSettled).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sessionId: "session-9", status: "held" }));
    expect(setDraftImmediate).not.toHaveBeenCalled();
    expect(markVoiceJobRecoveredMock).not.toHaveBeenCalled();
  });

  it("inserts a held dictation once when the server could not be told and the chat is opened again", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchLatestVoiceJobMock.mockImplementation(async (composerKey: string) => composerKey === "session-1"
      ? voiceJobSnapshot({ status: "held", transcript: "words to check", reviewReason: "coverage" })
      : null);
    markVoiceJobRecoveredMock.mockRejectedValue(new Error("offline"));
    const setDraftImmediate = vi.fn();
    let activeComposerKey = "session-1";
    harness = await createReactDomHarness();
    function Harness() {
      result = useBackgroundVoiceJobs({
        activeComposerKey,
        getDraft: () => null,
        setDraft: vi.fn(),
        setDraftImmediate,
        clearDraft: vi.fn(),
        rememberDraftSession: vi.fn(),
        clearDraftSession: vi.fn(),
        materializeSession: vi.fn().mockResolvedValue("session-1"),
        navigateToSession: vi.fn(),
        refreshSessions: vi.fn(),
        refreshTasks: vi.fn(),
      });
      return null;
    }
    try {
      await harness.render(createElement(Harness));
      await waitUntilAct(getHarness().act, () => markVoiceJobRecoveredMock.mock.calls.length === 1);
      activeComposerKey = "session-2";
      await harness.render(createElement(Harness));
      activeComposerKey = "session-1";
      await harness.render(createElement(Harness));
      await waitUntilAct(getHarness().act, () => markVoiceJobRecoveredMock.mock.calls.length === 2);

      expect(setDraftImmediate).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });

  it("warns when a dictation that went straight to the draft may be missing speech", async () => {
    transcribeAudioMock.mockResolvedValueOnce({
      text: "partial words",
      provider: "speech-engine",
      coverage: { largestGapSeconds: 4.2, gapStartSeconds: 5 },
    });
    fetchLatestVoiceJobMock.mockResolvedValue(null);
    await renderWithActiveComposer("session-1");

    await getHarness().act(async () => {
      await result?.startBackgroundVoiceJob({ composerKey: "session-1", audio: new Blob(["voice"], { type: "audio/wav" }), submitMode: "insert" });
    });
    await waitUntilAct(getHarness().act, () => result?.getJobForComposer("session-1")?.status === "review");

    expect(result?.getJobForComposer("session-1")?.review).toEqual({ reason: "coverage", gapStartSeconds: 5 });
  });

  it("retires a failed server job without a transcript when its error is dismissed", async () => {
    fetchLatestVoiceJobMock.mockResolvedValue(voiceJobSnapshot({
      status: "error",
      error: "No speech was detected in the recording.",
    }));
    markVoiceJobRecoveredMock.mockResolvedValue(null);

    await renderWithActiveComposer("session-1");
    await waitUntilAct(getHarness().act, () => result?.getJobForComposer("session-1")?.status === "error");
    expect(result?.getJobForComposer("session-1")?.retryable).toBeUndefined();

    await getHarness().act(async () => {
      result?.clearVoiceJobError("session-1");
    });

    expect(result?.getJobForComposer("session-1")).toBeNull();
    expect(markVoiceJobRecoveredMock).toHaveBeenCalledExactlyOnceWith("voice-job-1");
  });

  it("still dismisses the error locally when the server cannot be told", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      fetchLatestVoiceJobMock.mockResolvedValue(voiceJobSnapshot({
        status: "error",
        error: "No speech was detected in the recording.",
      }));
      markVoiceJobRecoveredMock.mockRejectedValue(new Error("Failed to fetch"));

      await renderWithActiveComposer("session-1");
      await waitUntilAct(getHarness().act, () => result?.getJobForComposer("session-1")?.status === "error");

      await getHarness().act(async () => {
        result?.clearVoiceJobError("session-1");
      });

      expect(result?.getJobForComposer("session-1")).toBeNull();
      await waitUntilAct(getHarness().act, () => warn.mock.calls.length > 0);
      expect(warn.mock.calls[0]?.[0]).toContain("Could not clear the failed voice job");
    } finally {
      warn.mockRestore();
    }
  });
});
