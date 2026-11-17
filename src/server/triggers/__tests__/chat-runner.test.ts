import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setupTestDb } from "../../__tests__/helpers.js";
import { makeMockDeferSessionManager } from "../../__tests__/defer-test-helpers.js";
import { CHAT_WORK_WATCHDOG_INTERVAL_MS, LEASE_EXPIRED_ERROR, LEASE_MS, MAX_ATTEMPTS } from "../../chat-work-runner.js";
import { createDeferredPromptStore } from "../../deferred-prompt-store.js";
import type { DatabaseSync } from "../../db.js";
import { createGlobalBus } from "../../global-bus.js";
import { getProcessHost, HostExecError } from "../../process-host.js";
import { createTriggerChatRunner } from "../chat-runner.js";
import { parseTriggerResultPrompt } from "../messages.js";
import { createTriggerStore } from "../store.js";
import type { TriggerCreate } from "../types.js";

let db: DatabaseSync;

beforeEach(() => {
  db = setupTestDb();
  vi.useFakeTimers();
  // Windows may have both Path and PATH; blank both so no real file lookup runs under fake timers.
  for (const key of Object.keys(process.env)) {
    if (key.toUpperCase() === "PATH") vi.stubEnv(key, "");
  }
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const command = ["fixture-status-cli", "pr", "checks", "7"];
const exited = (code: number, stdout: string) =>
  new HostExecError({ message: `Command failed with exit code ${code}`, code }, stdout, "");

function setup(input: Partial<TriggerCreate> = {}) {
  const store = createTriggerStore(db);
  const outbox = createDeferredPromptStore(db);
  const trigger = store.create({
    prompt: "Check the build",
    sessionId: "session-1",
    when: { kind: "every", seconds: 300 },
    action: { kind: "chat", via: "worker" },
    nextRunAt: new Date(Date.now() - 1_000).toISOString(),
    ...input,
  });
  const sm = makeMockDeferSessionManager({ sessions: ["session-1"], defaultAction: "continue" }) as any;
  const execFile = vi.spyOn(getProcessHost(), "execFile");
  const runner = createTriggerChatRunner(store, sm, createGlobalBus());
  return { store, outbox, trigger, sm, execFile, runner };
}

describe("trigger chat runner", () => {
  it("runs a recurring worker trigger, carries its checkpoint forward and completes at its run limit", async () => {
    const { store, trigger, sm, runner } = setup({ maxRuns: 2 });
    sm.runDeferWorker = vi.fn()
      .mockResolvedValueOnce({ action: "continue", checkpoint: { buildId: 42 } })
      .mockResolvedValueOnce({ action: "continue" });

    runner.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(sm.runDeferWorker).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      triggerId: trigger.id,
      recurring: true,
      parentSessionId: "session-1",
      runCount: 1,
      maxRuns: 2,
      isFinalRun: false,
      schedule: "every 5 min",
    }));
    expect(store.get(trigger.id)).toMatchObject({ status: "active", runCount: 1, fireCount: 1, checkpoint: { buildId: 42 } });

    await vi.advanceTimersByTimeAsync(300_000);
    expect(sm.runDeferWorker).toHaveBeenNthCalledWith(2, expect.objectContaining({ checkpoint: { buildId: 42 }, isFinalRun: true }));
    expect(store.get(trigger.id)).toMatchObject({ status: "completed", runCount: 2 });
    runner.shutdown();
  });

  it("keeps the first check as a baseline, then wakes the worker with old and new output only when it changes", async () => {
    const { store, trigger, sm, execFile, runner } = setup({
      check: { command, timeoutSeconds: 60, fireOn: "change" },
    });
    const workspace = join(tmpdir(), "chat-workspace");
    sm.getEffectiveSessionCwd = () => workspace;
    sm.runDeferWorker = vi.fn(async () => ({ action: "continue" }));
    execFile
      .mockRejectedValueOnce(exited(8, "pending\r\n"))
      .mockRejectedValueOnce(exited(8, "pending\n"))
      .mockResolvedValueOnce({ stdout: "pass\n", stderr: "" });

    runner.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(execFile).toHaveBeenCalledWith("fixture-status-cli", ["pr", "checks", "7"], expect.objectContaining({ cwd: workspace }));
    expect(store.get(trigger.id)).toMatchObject({ runCount: 1, fireCount: 0, lastCheck: { outcome: "baseline" } });

    await vi.advanceTimersByTimeAsync(300_000);
    expect(store.get(trigger.id)).toMatchObject({ runCount: 2, fireCount: 0, lastCheck: { outcome: "unchanged" } });
    expect(sm.runDeferWorker).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(300_000);
    expect(sm.runDeferWorker).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      check: {
        command,
        fireOn: "change",
        previous: { exitCode: 8, stdout: "pending", stderr: "" },
        current: { exitCode: 0, stdout: "pass", stderr: "" },
      },
    }));
    const settled = store.get(trigger.id)!;
    expect(settled).toMatchObject({ runCount: 3, fireCount: 1, lastCheck: { outcome: "changed", output: { exitCode: 0 } } });
    expect(settled.checkPending).toBeUndefined();
    runner.shutdown();
  });

  it("lets an exit_code check send its output straight into the chat and stop the trigger, without a worker", async () => {
    const { store, outbox, trigger, sm, execFile, runner } = setup({
      check: { command, timeoutSeconds: 60, fireOn: "exit_code" },
      action: { kind: "chat", via: "message" },
      prompt: "The PR merged; continue the release.",
    });
    sm.runDeferWorker = vi.fn();
    const acquire = vi.spyOn(sm, "tryAcquireDeferWorker");
    execFile
      .mockResolvedValueOnce({ stdout: "open\n", stderr: "" })
      .mockRejectedValueOnce(exited(11, "merged\n"));

    runner.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.get(trigger.id)).toMatchObject({ status: "active", lastCheck: { outcome: "quiet" } });
    expect(outbox.listDeliveriesForSession("session-1")).toEqual([]);

    await vi.advanceTimersByTimeAsync(300_000);
    expect(acquire).not.toHaveBeenCalled();
    expect(store.get(trigger.id)).toMatchObject({ status: "completed", fireCount: 1, lastCheck: { outcome: "fired" } });
    const [delivery] = outbox.listDeliveriesForSession("session-1");
    expect(delivery).toMatchObject({ purpose: "delivery", sourceId: `trigger:${trigger.id}`, status: "pending" });
    expect(delivery!.prompt).toContain('"stdout": "merged"');
    expect(delivery!.prompt.endsWith("The PR merged; continue the release.")).toBe(true);
    runner.shutdown();
  });

  it("fails a check with an exit code outside the contract, keeping the trigger active", async () => {
    const { store, trigger, execFile, runner } = setup({ check: { command, timeoutSeconds: 60, fireOn: "exit_code" } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    execFile.mockRejectedValueOnce(exited(2, "boom\n"));

    runner.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.get(trigger.id)).toMatchObject({ status: "active", runCount: 1, attempts: 1, lastError: expect.stringContaining("exited with 2") });
    expect(warn).toHaveBeenCalled();
    runner.shutdown();
  });

  it("retries a failing one-time worker trigger and tells the chat when its tries run out", async () => {
    const { store, outbox, trigger, sm, runner } = setup({ when: { kind: "at", at: new Date().toISOString() } });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    sm.runDeferWorker = vi.fn(async () => { throw new Error("worker crashed"); });

    runner.start();
    for (let i = 0; i < MAX_ATTEMPTS + 1; i += 1) await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(sm.runDeferWorker).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    expect(store.get(trigger.id)).toMatchObject({ status: "failed", lastError: "worker crashed" });
    const [notice] = outbox.listDeliveriesForSession("session-1");
    expect(parseTriggerResultPrompt(notice!.prompt)).toMatchObject({ triggerId: trigger.id, continues: false });
    runner.shutdown();
  });

  it("counts a run whose lease expired while the Bridge was down as failed and keeps the schedule", async () => {
    const { store, trigger, runner } = setup();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const claimed = store.claimDue(trigger.id, LEASE_MS)!;
    expect(claimed).toBeDefined();
    await vi.advanceTimersByTimeAsync(LEASE_MS + CHAT_WORK_WATCHDOG_INTERVAL_MS);

    runner.start();
    await vi.advanceTimersByTimeAsync(0);
    const after = store.get(trigger.id)!;
    expect(after).toMatchObject({ status: "active", runCount: 1, lastError: LEASE_EXPIRED_ERROR });
    expect(Date.parse(after.nextRunAt!)).toBeGreaterThan(Date.now());
    runner.shutdown();
  });

  it("runs a trigger asked to run now ahead of its time, skipping its check, and keeps a cron trigger's next slot", async () => {
    const nextSlot = new Date(Date.now() + 3 * 60 * 60_000).toISOString();
    const { store, trigger, sm, execFile, runner } = setup({
      when: { kind: "cron", cron: "0 * * * *", timezone: "UTC" },
      check: { command, timeoutSeconds: 60, fireOn: "change" },
      nextRunAt: nextSlot,
    });
    sm.runDeferWorker = vi.fn(async () => ({ action: "continue" }));
    expect(store.requestRunNow(trigger.id)).toBe(true);

    runner.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(execFile).not.toHaveBeenCalled();
    expect(sm.runDeferWorker).toHaveBeenCalledOnce();
    expect(store.get(trigger.id)).toMatchObject({ status: "active", runNow: false, nextRunAt: nextSlot, fireCount: 1 });
    runner.shutdown();
  });
});
