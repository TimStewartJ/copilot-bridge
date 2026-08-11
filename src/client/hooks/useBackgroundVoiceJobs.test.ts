import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createReactDomHarness,
  waitUntilAct,
  type ReactDomHarness,
} from "../test-react-harness";
import {
  __resetVoiceRecordingStoreForTests,
  getPendingVoiceRecording,
  patchPendingVoiceRecording,
  savePendingVoiceRecording,
} from "../lib/voice-recording-store";
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
    __resetVoiceRecordingStoreForTests();
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
    // Transcripts are persisted immediately so a reload cannot lose both the audio and the text.
    expect(options.setDraftImmediate).toHaveBeenCalledWith("session-1", "Retried transcript", undefined);
  });

  it("keeps unsent audio retryable when the voice job error is cleared", async () => {
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
    createVoiceJobMock.mockResolvedValueOnce(voiceJobSnapshot());
    await getHarness().act(async () => {
      result?.clearVoiceJobError("session-1");
    });

    expect(result?.getJobForComposer("session-1")).toMatchObject({ status: "error", retryable: true });

    await getHarness().act(async () => {
      result?.retryVoiceJobUpload("session-1");
    });

    await waitUntilAct(getHarness().act, () => result?.getJobForComposer("session-1")?.status === "accepted");
    expect(createVoiceJobMock).toHaveBeenCalledTimes(2);
  });

  it("discards the persisted recording only on an explicit discard", async () => {
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
    expect(await getPendingVoiceRecording("session-1")).not.toBeNull();

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

  it("persists the recording before uploading so a failed send survives a reload", async () => {
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
    await harness?.cleanup();
    harness = null;
    result = null;
    __resetVoiceRecordingStoreForTests();
  });

  async function renderWithActiveComposer(activeComposerKey: string) {
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
        isSessionBusy: () => false,
        navigateToSession: vi.fn(),
        refreshSessions: vi.fn(),
        refreshTasks: vi.fn(),
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

  it("does not re-upload when the server job status cannot be checked", async () => {
    await savePendingVoiceRecording({
      composerKey: "session-1",
      recordingId: "rec-4",
      submitMode: "autosend",
      audio: new TextEncoder().encode("voice").buffer as ArrayBuffer,
      mimeType: "audio/wav",
    });
    await patchPendingVoiceRecording("session-1", "rec-4", { serverJobId: "voice-job-1" });
    fetchVoiceJobMock.mockResolvedValueOnce(voiceJobSnapshot({ status: "error" }));

    await renderWithActiveComposer("session-1");
    await waitUntilAct(getHarness().act, () => result?.getJobForComposer("session-1")?.retryable === true);

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
  });

  it("keeps a locally stored recording retryable when its server job failed without a transcript", async () => {
    await savePendingVoiceRecording({
      composerKey: "session-1",
      recordingId: "rec-3",
      submitMode: "autosend",
      audio: new TextEncoder().encode("voice").buffer as ArrayBuffer,
      mimeType: "audio/wav",
    });
    await patchPendingVoiceRecording("session-1", "rec-3", { serverJobId: "voice-job-1" });
    fetchVoiceJobMock.mockResolvedValue(voiceJobSnapshot({ status: "error" }));

    await renderWithActiveComposer("session-1");

    await waitUntilAct(getHarness().act, () => result?.getJobForComposer("session-1")?.status === "error");
    expect(result?.getJobForComposer("session-1")?.retryable).toBe(true);
    expect(await getPendingVoiceRecording("session-1")).not.toBeNull();
  });
});
