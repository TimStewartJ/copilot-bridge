import { afterEach, describe, expect, it } from "vitest";
import { openMemoryDatabase, type DatabaseSync } from "../db.js";
import { createDeferredPromptStore } from "../deferred-prompt-store.js";
import { createDeferLoopStore } from "../defer-loop-store.js";
import { createVoiceJobStore } from "../voice-job-store.js";
import { isolateStagingRuntimeState } from "../staging-seed-state.js";
import { testPath } from "./test-paths.js";

describe("fresh preview copy automation isolation", () => {
  let db: DatabaseSync;
  afterEach(() => db?.close());
  it("cancels copied pending/running work and recovery without changing completed history", () => {
    db = openMemoryDatabase();
    const at = new Date().toISOString();
    db.prepare("INSERT INTO deferred_prompts(id,sessionId,prompt,runAt,status,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?)").run("pending", "production", "Must not run", at, "pending", at, at);
    db.prepare("INSERT INTO deferred_prompts(id,sessionId,prompt,runAt,status,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?)").run("done", "production", "Already done", at, "completed", at, at);
    const loops = createDeferLoopStore(db);
    const loop = loops.create({ sessionId: "production", prompt: "Must not loop", intervalSeconds: 300, nextRunAt: at });
    db.prepare("UPDATE defer_loops SET status='running',claimToken='copied-token',leaseExpiresAt=? WHERE id=?").run(at, loop.id);
    db.prepare("INSERT INTO interrupted_run_markers(sessionId,attentionMode,acceptedAt) VALUES(?,?,?)").run("production", "interactive", at);
    const voice = createVoiceJobStore(db);
    voice.createVoiceJob({ id: "voice", composerKey: "production", audioPath: testPath("voice", "audio.wav") });
    db.exec("BEGIN");
    const counts = isolateStagingRuntimeState(db);
    db.exec("COMMIT");
    expect(counts).toMatchObject({ deferred_prompts: 1, defer_loops: 1, interruptedRuns: 1, voiceJobs: 1 });
    expect(createDeferredPromptStore(db).get("pending")).toMatchObject({ status: "cancelled", lastError: expect.stringContaining("staging copy") });
    expect(createDeferredPromptStore(db).get("done")).toMatchObject({ status: "completed", updatedAt: at });
    expect(loops.get(loop.id)).toMatchObject({ status: "cancelled" });
    expect(db.prepare("SELECT claimToken,leaseExpiresAt FROM defer_loops WHERE id=?").get(loop.id)).toMatchObject({ claimToken: null, leaseExpiresAt: null });
    expect(voice.listPendingVoiceJobs()).toEqual([]);
    expect(voice.getVoiceJob("voice")?.error).toContain("staging copy");
    const preview = loops.create({ sessionId: "preview", prompt: "New explicitly requested work", intervalSeconds: 300, nextRunAt: at });
    expect(loops.get(preview.id)?.status).toBe("active");
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
