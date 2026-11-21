import { afterEach, describe, expect, it } from "vitest";
import { openMemoryDatabase, type DatabaseSync } from "../db.js";
import { createDeferredPromptStore } from "../deferred-prompt-store.js";
import { createTriggerStore } from "../triggers/store.js";
import { createVoiceJobStore } from "../voice-job-store.js";
import { isolateStagingRuntimeState } from "../staging-seed-state.js";
import { createChatTrigger } from "./helpers.js";
import { testPath } from "./test-paths.js";

describe("fresh preview copy automation isolation", () => {
  let db: DatabaseSync;
  afterEach(() => db?.close());
  it("cancels copied pending/running work and recovery without changing completed history", () => {
    db = openMemoryDatabase();
    const at = new Date().toISOString();
    db.prepare("INSERT INTO deferred_prompts(id,sessionId,prompt,runAt,status,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?)").run("pending", "production", "Must not run", at, "pending", at, at);
    db.prepare("INSERT INTO deferred_prompts(id,sessionId,prompt,runAt,status,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?)").run("done", "production", "Already done", at, "completed", at, at);
    const triggers = createTriggerStore(db);
    const chatTrigger = createChatTrigger(triggers, "production", { prompt: "Must not run", nextRunAt: at });
    db.prepare("UPDATE triggers SET status='running',claimToken='copied-token',leaseExpiresAt=? WHERE id=?").run(at, chatTrigger.id);
    const taskTrigger = triggers.create({
      taskId: "production-task", prompt: "Must not start chats", when: { kind: "cron", cron: "0 9 * * *", timezone: "UTC" },
      action: { kind: "new_chat" }, nextRunAt: at,
    });
    db.prepare("INSERT INTO interrupted_run_markers(sessionId,attentionMode,acceptedAt) VALUES(?,?,?)").run("production", "interactive", at);
    const voice = createVoiceJobStore(db);
    voice.createVoiceJob({ id: "voice", composerKey: "production", audioPath: testPath("voice", "audio.wav") });
    const comparison = db.prepare(`INSERT INTO model_comparisons(id,testStartedAt,mainSessionId,mainArm,setupsJson,status,createdAt,updatedAt,twinRepo,twinWorktree)
      VALUES(?,?,?,?,?,?,?,?,?,?)`);
    comparison.run("running-pair", at, "production", "a", "{}", "running", at, at, testPath("repo"), testPath("repo", "twin"));
    comparison.run("judged-pair", at, "production-2", "a", "{}", "judged", at, at, testPath("repo"), testPath("repo", "twin-2"));
    db.exec("BEGIN");
    const counts = isolateStagingRuntimeState(db);
    db.exec("COMMIT");
    expect(counts).toMatchObject({ deferred_prompts: 1, chatTriggers: 1, taskTriggers: 1, interruptedRuns: 1, voiceJobs: 1, modelComparisons: 1 });
    // The preview must never stop a production twin or remove its worktree.
    expect(db.prepare("SELECT id,status,twinWorktree FROM model_comparisons ORDER BY id").all()).toEqual([
      { id: "judged-pair", status: "judged", twinWorktree: null },
      { id: "running-pair", status: "incomplete", twinWorktree: null },
    ]);
    expect(createDeferredPromptStore(db).get("pending")).toMatchObject({ status: "cancelled", lastError: expect.stringContaining("staging copy") });
    expect(createDeferredPromptStore(db).get("done")).toMatchObject({ status: "completed", updatedAt: at });
    expect(triggers.get(chatTrigger.id)).toMatchObject({ status: "cancelled" });
    expect(triggers.get(chatTrigger.id)?.claimToken).toBeUndefined();
    // A task trigger stays visible in the preview, paused.
    expect(triggers.get(taskTrigger.id)?.status).toBe("paused");
    expect(voice.listPendingVoiceJobs()).toEqual([]);
    expect(voice.getVoiceJob("voice")?.error).toContain("staging copy");
    const preview = createChatTrigger(triggers, "preview", { prompt: "New explicitly requested work", nextRunAt: at });
    expect(triggers.get(preview.id)?.status).toBe("active");
  });
  it("requires a transaction and fails closed if any isolation statement fails", () => {
    db = openMemoryDatabase();
    expect(() => isolateStagingRuntimeState(db)).toThrow("seed transaction");
    const at = new Date().toISOString();
    db.prepare("INSERT INTO interrupted_run_markers(sessionId,attentionMode,acceptedAt) VALUES(?,?,?)").run("keep-on-failure", "interactive", at);
    db.exec("CREATE TRIGGER reject_recovery_isolation BEFORE DELETE ON interrupted_run_markers BEGIN SELECT RAISE(ABORT,'fixture isolation failure'); END;");
    db.exec("BEGIN");
    expect(() => isolateStagingRuntimeState(db)).toThrow("fixture isolation failure");
    db.exec("ROLLBACK");
    expect(db.prepare("SELECT COUNT(*) AS n FROM interrupted_run_markers").get()?.n).toBe(1);
  });
});
