import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_PERSISTED_RECORDING_BYTES,
  __resetVoiceRecordingStoreForTests,
  deletePendingVoiceRecording,
  getPendingVoiceRecording,
  listPendingVoiceRecordingKeys,
  migratePendingVoiceRecording,
  patchPendingVoiceRecording,
  pendingVoiceRecordingToBlob,
  savePendingVoiceRecording,
} from "./voice-recording-store";

function audioBuffer(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

describe("voice recording store", () => {
  beforeEach(() => {
    __resetVoiceRecordingStoreForTests();
  });

  afterEach(() => {
    __resetVoiceRecordingStoreForTests();
  });

  it("keeps the pending draft recording through handoff and accepts updates and deletion only from its owner", async () => {
    const result = await savePendingVoiceRecording({
      composerKey: "draft:task:task-1",
      recordingId: "rec-1",
      submitMode: "autosend",
      audio: audioBuffer("hello"),
      mimeType: "audio/wav",
      sessionOptions: {
        model: "gpt-5.6-sol",
        reasoningEffort: "xhigh",
        contextTier: "long_context",
      },
    });

    // No IndexedDB in the test environment, so the store falls back to memory and says so.
    expect(result.durable).toBe(false);
    expect(result.reason).toBe("unavailable");

    const stored = await getPendingVoiceRecording("draft:task:task-1");
    expect(stored).toMatchObject({
      composerKey: "draft:task:task-1",
      recordingId: "rec-1",
      submitMode: "autosend",
      mimeType: "audio/wav",
      sizeBytes: 5,
      sessionOptions: {
        model: "gpt-5.6-sol",
        reasoningEffort: "xhigh",
        contextTier: "long_context",
      },
    });
    expect(pendingVoiceRecordingToBlob(stored!).size).toBe(5);

    const moved = await migratePendingVoiceRecording("draft:task:task-1", "session-9");

    expect(moved?.composerKey).toBe("session-9");
    expect(await getPendingVoiceRecording("draft:task:task-1")).toBeNull();
    expect(await listPendingVoiceRecordingKeys()).toEqual(["session-9"]);

    await patchPendingVoiceRecording("session-9", "stale-rec", { serverJobId: "job-x" });
    expect((await getPendingVoiceRecording("session-9"))?.serverJobId).toBeUndefined();

    await patchPendingVoiceRecording("session-9", "rec-1", { serverJobId: "job-1" });
    expect((await getPendingVoiceRecording("session-9"))?.serverJobId).toBe("job-1");

    await deletePendingVoiceRecording("session-9", "stale-rec");
    expect(await getPendingVoiceRecording("session-9")).not.toBeNull();

    await deletePendingVoiceRecording("session-9", "rec-1");
    expect(await getPendingVoiceRecording("session-9")).toBeNull();
  });

  it("refuses to overwrite a different pending recording for the same composer", async () => {
    await savePendingVoiceRecording({
      composerKey: "session-1",
      recordingId: "rec-1",
      submitMode: "insert",
      audio: audioBuffer("first"),
      mimeType: "audio/wav",
    });

    const conflict = await savePendingVoiceRecording({
      composerKey: "session-1",
      recordingId: "rec-2",
      submitMode: "insert",
      audio: audioBuffer("second"),
      mimeType: "audio/wav",
    });

    expect(conflict).toEqual({ durable: false, reason: "conflict" });
    expect((await getPendingVoiceRecording("session-1"))?.recordingId).toBe("rec-1");
  });

  it("reports oversized recordings instead of dropping them silently", async () => {
    const result = await savePendingVoiceRecording({
      composerKey: "session-1",
      recordingId: "rec-1",
      submitMode: "autosend",
      audio: new ArrayBuffer(MAX_PERSISTED_RECORDING_BYTES + 1),
      mimeType: "audio/wav",
    });

    expect(result).toEqual({ durable: false, reason: "too-large" });
    expect(await getPendingVoiceRecording("session-1")).not.toBeNull();
  });

  it("rejects a conflicting oversized recording instead of replacing the pending one", async () => {
    await savePendingVoiceRecording({
      composerKey: "session-1",
      recordingId: "rec-1",
      submitMode: "autosend",
      audio: audioBuffer("keep me"),
      mimeType: "audio/wav",
    });

    const conflict = await savePendingVoiceRecording({
      composerKey: "session-1",
      recordingId: "rec-2",
      submitMode: "autosend",
      audio: new ArrayBuffer(MAX_PERSISTED_RECORDING_BYTES + 1),
      mimeType: "audio/wav",
    });

    expect(conflict).toEqual({ durable: false, reason: "conflict" });
    expect((await getPendingVoiceRecording("session-1"))?.recordingId).toBe("rec-1");
  });
});
