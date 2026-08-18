import { describe, expect, it, vi } from "vitest";
import { createSessionForkJobManager } from "../session-fork-job-manager.js";

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("session fork job manager", () => {
  it("returns a queued job before the fork starts", async () => {
    let scheduledRun: (() => void) | undefined;
    let resolveFork: ((sessionId: string) => void) | undefined;
    const runFork = vi.fn(() => new Promise<string>((resolve) => {
      resolveFork = resolve;
    }));
    const manager = createSessionForkJobManager({
      runFork,
      createId: () => "fork-job-1",
      now: () => Date.parse("2026-08-18T16:00:00.000Z"),
      schedule: (run) => { scheduledRun = run; },
    });

    const accepted = manager.start({ sourceSessionId: "source-1" });

    expect(accepted).toMatchObject({
      reused: false,
      job: {
        id: "fork-job-1",
        sourceSessionId: "source-1",
        status: "queued",
        bounded: false,
      },
    });
    expect(runFork).not.toHaveBeenCalled();

    scheduledRun?.();
    await flushMicrotasks();
    expect(manager.get("fork-job-1")?.status).toBe("running");

    resolveFork?.("forked-session");
    await flushMicrotasks();
    expect(manager.get("fork-job-1")).toMatchObject({
      status: "succeeded",
      sessionId: "forked-session",
    });
  });

  it("reuses an active job for the same source and boundary", () => {
    const manager = createSessionForkJobManager({
      runFork: async () => "forked-session",
      createId: () => "fork-job-1",
      schedule: () => {},
    });

    const first = manager.start({ sourceSessionId: "source-1", toEventId: "event-2" });
    const duplicate = manager.start({ sourceSessionId: "source-1", toEventId: "event-2" });

    expect(first.reused).toBe(false);
    expect(duplicate).toEqual({ job: first.job, reused: true });
  });

  it("records background failures without rejecting the acceptance request", async () => {
    let scheduledRun: (() => void) | undefined;
    const manager = createSessionForkJobManager({
      runFork: async () => { throw new Error("fork copy failed"); },
      createId: () => "fork-job-1",
      schedule: (run) => { scheduledRun = run; },
    });

    const accepted = manager.start({ sourceSessionId: "source-1" });
    scheduledRun?.();
    await flushMicrotasks();

    expect(accepted.job.status).toBe("queued");
    expect(manager.get("fork-job-1")).toMatchObject({
      status: "failed",
      error: "fork copy failed",
    });
  });
});
