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
