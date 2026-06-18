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
