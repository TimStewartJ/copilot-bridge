import { beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { openMemoryDatabase } from "../db.js";
import type { DatabaseSync } from "../db.js";
import { createTaskStore } from "../task-store.js";
import { createVoiceJobStore } from "../voice-job-store.js";
import { createTestBus, makeTestDir } from "./helpers.js";

let db: DatabaseSync;
let audioDir: string;

beforeEach(() => {
  db = openMemoryDatabase();
  audioDir = makeTestDir("voice-job-store");
});

describe("voice-job-store task foreign key", () => {
  it("clears a voice job taskId when its task is deleted instead of orphaning the row", () => {
    const taskStore = createTaskStore(db, createTestBus());
    const voiceJobs = createVoiceJobStore(db);
    const task = taskStore.createTask("Voice task");

    voiceJobs.createVoiceJob({
      id: "voice-1",
      composerKey: `draft:task:${task.id}`,
      taskId: task.id,
      audioPath: join(audioDir, "voice-1.wav"),
    });

    expect(() => taskStore.deleteTask(task.id)).not.toThrow();

    const job = voiceJobs.getVoiceJob("voice-1");
    expect(job).toBeDefined();
    expect(job?.taskId).toBeUndefined();

    const raw = db.prepare("SELECT taskId FROM voice_jobs WHERE id = ?").get("voice-1") as {
      taskId: string | null;
    };
    expect(raw.taskId).toBeNull();
  });

  it("rejects creating a voice job that references a non-existent task", () => {
    const voiceJobs = createVoiceJobStore(db);

    expect(() =>
      voiceJobs.createVoiceJob({
        id: "voice-2",
        composerKey: "draft:task:missing",
        taskId: "missing-task",
        audioPath: join(audioDir, "voice-2.wav"),
      }),
    ).toThrow();
  });
});

describe("voice-job-store retention", () => {
  it("prunes only terminal rows older than the updatedAt cutoff", () => {
    const voiceJobs = createVoiceJobStore(db);
    const oldTimestamp = "2026-05-01T00:00:00.000Z";
    const recentTimestamp = "2026-07-20T00:00:00.000Z";
    const cutoff = "2026-06-23T00:00:00.000Z";
    const createJob = (id: string) => voiceJobs.createVoiceJob({
      id,
      composerKey: "existing-session",
      targetSessionId: "existing-session",
      audioPath: join(audioDir, id, "recording.wav"),
    });

    createJob("old-done");
    voiceJobs.updateVoiceJob("old-done", { status: "done", transcript: "done" });
    createJob("old-error");
    voiceJobs.markError("old-error", "failed");
    createJob("old-recovered");
    voiceJobs.markError("old-recovered", "failed");
    voiceJobs.markRecovered("old-recovered");
    createJob("old-active");
    createJob("recent-error");
    voiceJobs.markError("recent-error", "still visible");
    db.prepare(`
      UPDATE voice_jobs
      SET createdAt = ?, updatedAt = ?
      WHERE id IN ('old-done', 'old-error', 'old-recovered', 'old-active')
    `).run(oldTimestamp, oldTimestamp);
    db.prepare(`
      UPDATE voice_jobs
      SET createdAt = ?, updatedAt = ?
      WHERE id = 'recent-error'
    `).run(oldTimestamp, recentTimestamp);

    expect(voiceJobs.pruneTerminalVoiceJobs(cutoff)).toBe(3);
    expect(voiceJobs.getVoiceJob("old-done")).toBeUndefined();
    expect(voiceJobs.getVoiceJob("old-error")).toBeUndefined();
    expect(voiceJobs.getVoiceJob("old-recovered")).toBeUndefined();
    expect(voiceJobs.getVoiceJob("old-active")?.status).toBe("accepted");
    expect(voiceJobs.getVoiceJob("recent-error")).toMatchObject({
      status: "error",
      error: "still visible",
    });
  });
});

describe("voice-job-store composer recovery", () => {
  function createJob(voiceJobs: ReturnType<typeof createVoiceJobStore>, id: string, createdAt: string, composerKey = "session-1") {
    voiceJobs.createVoiceJob({
      id,
      composerKey,
      targetSessionId: "session-1",
      audioPath: join(audioDir, id, "recording.wav"),
    });
    db.prepare("UPDATE voice_jobs SET createdAt = ?, updatedAt = ? WHERE id = ?").run(createdAt, createdAt, id);
  }

  it("stops surfacing a failed job without a transcript once a newer job exists", () => {
    const voiceJobs = createVoiceJobStore(db);
    createJob(voiceJobs, "silent", "2026-09-27T19:03:00.000Z");
    voiceJobs.markError("silent", "No speech was detected in the recording.");
    expect(voiceJobs.findLatestRelevantForComposer("session-1")?.id).toBe("silent");

    createJob(voiceJobs, "later", "2026-09-27T19:13:00.000Z");
    voiceJobs.updateVoiceJob("later", { status: "done", transcript: "hello" });
    db.prepare("UPDATE voice_jobs SET updatedAt = ? WHERE id = 'silent'").run("2026-09-27T20:00:00.000Z");

    expect(voiceJobs.findLatestRelevantForComposer("session-1")).toBeUndefined();
  });

  it("breaks a createdAt tie by insertion order", () => {
    const voiceJobs = createVoiceJobStore(db);
    createJob(voiceJobs, "first", "2026-09-27T19:03:00.000Z");
    createJob(voiceJobs, "second", "2026-09-27T19:03:00.000Z");
    voiceJobs.markError("first", "No speech was detected in the recording.");
    voiceJobs.updateVoiceJob("second", { status: "done", transcript: "hello" });

    expect(voiceJobs.findLatestRelevantForComposer("session-1")).toBeUndefined();
  });

  it("keeps surfacing a failed job whose transcript has not been recovered, even after a newer job", () => {
    const voiceJobs = createVoiceJobStore(db);
    createJob(voiceJobs, "unsent", "2026-09-27T19:03:00.000Z", "draft:quickchat");
    voiceJobs.markError("unsent", "Auto-send failed.", "dictated words");
    createJob(voiceJobs, "later", "2026-09-27T19:13:00.000Z");
    voiceJobs.updateVoiceJob("later", { status: "done", transcript: "hello" });

    expect(voiceJobs.findLatestRelevantForComposer("session-1")).toMatchObject({
      id: "unsent",
      transcript: "dictated words",
    });
  });

  it("still reports an in-flight job regardless of newer jobs", () => {
    const voiceJobs = createVoiceJobStore(db);
    createJob(voiceJobs, "active", "2026-09-27T19:03:00.000Z");
    voiceJobs.updateVoiceJob("active", { status: "sending", transcript: "hi" });

    expect(voiceJobs.findLatestRelevantForComposer("session-1")?.id).toBe("active");
  });

  it("recovers only failed jobs so an in-flight job stays resumable", () => {
    const voiceJobs = createVoiceJobStore(db);
    createJob(voiceJobs, "active", "2026-09-27T19:03:00.000Z");
    createJob(voiceJobs, "failed", "2026-09-27T19:04:00.000Z", "session-2");
    voiceJobs.markError("failed", "No speech was detected in the recording.");

    expect(voiceJobs.markRecovered("active")?.status).toBe("accepted");
    expect(voiceJobs.listPendingVoiceJobs().map((job) => job.id)).toEqual(["active"]);
    expect(voiceJobs.markRecovered("failed")).toMatchObject({ status: "recovered", error: undefined });
    expect(voiceJobs.markRecovered("missing")).toBeUndefined();
  });
});
