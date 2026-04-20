import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../session-manager.js";
import { createEventBusRegistry } from "../event-bus.js";
import { createSessionTitlesStore } from "../session-titles.js";
import { setupTestDb, createTestBus } from "./helpers.js";

describe("SessionManager run state", () => {
  function createManager(opts: { copilotHome?: string } = {}) {
    const db = setupTestDb();
    const globalBus = createTestBus();
    const eventBusRegistry = createEventBusRegistry();
    const manager = new SessionManager({
      tools: [],
      globalBus,
      eventBusRegistry,
      sessionTitles: createSessionTitlesStore(db),
      taskStore: {
        findTaskBySessionId: vi.fn().mockReturnValue(null),
      } as any,
      settingsStore: {
        getMcpServers: () => ({}),
        getSettings: () => ({ mcpServers: {} }),
      } as any,
      config: { sessionMcpServers: {} },
      copilotHome: opts.copilotHome,
    }) as any;

    return { manager, globalBus };
  }

  function makeSession() {
    let handler: ((event: any) => void) | undefined;
    let releaseSend: (() => void) | undefined;
    const session = {
      on: vi.fn((cb: (event: any) => void) => {
        handler = cb;
        return vi.fn(() => {
          if (handler === cb) handler = undefined;
        });
      }),
      send: vi.fn(async () => {
        await new Promise<void>((resolve) => {
          releaseSend = resolve;
        });
      }),
    };
    const getHandler = () => handler;
    const getReleaseSend = () => releaseSend;
    return { session, getHandler, getReleaseSend };
  }

  async function flushMicrotasks() {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("transitions busy → stalled → busy → idle from the server run-state model", async () => {
    const { manager, globalBus } = createManager();
    const events: string[] = [];
    globalBus.subscribe((event) => {
      if (event.sessionId === "session-1" && ["session:busy", "session:stalled", "session:idle"].includes(event.type)) {
        events.push(event.type);
      }
    });

    const { session, getHandler, getReleaseSend } = makeSession();
    manager.client = {
      resumeSession: vi.fn().mockResolvedValue(session),
    };

    manager.startWork("session-1", "hello");
    await flushMicrotasks();

    expect(manager.getSessionRunState("session-1")).toBe("busy");
    expect(manager.isSessionBusy("session-1")).toBe(true);

    // Watchdog fires every 60s; stall threshold is 300s — first trigger at exactly 300s
    await vi.advanceTimersByTimeAsync(300_000);
    await flushMicrotasks();

    expect(manager.getSessionRunState("session-1")).toBe("stalled");
    expect(manager.isSessionStalled("session-1")).toBe(true);
    expect(manager.getActiveSessions()).toEqual(["session-1"]);
    expect(manager.getSessionActivity()).toEqual([
      expect.objectContaining({
        id: "session-1",
        state: "stalled",
        stalledAt: expect.any(Number),
      }),
    ]);

    getHandler()?.({
      type: "assistant.turn_start",
      data: {},
      timestamp: "2026-04-20T00:00:00.000Z",
    });
    await flushMicrotasks();

    expect(manager.getSessionRunState("session-1")).toBe("busy");
    expect(manager.isSessionStalled("session-1")).toBe(false);

    getReleaseSend()?.();
    await flushMicrotasks();
    getHandler()?.({
      type: "session.idle",
      data: {},
      timestamp: "2026-04-20T00:00:01.000Z",
    });
    await flushMicrotasks();

    expect(manager.getSessionRunState("session-1")).toBe("idle");
    expect(manager.isSessionBusy("session-1")).toBe(false);
    expect(events).toEqual(["session:busy", "session:stalled", "session:busy", "session:idle"]);
  });

  it("attempts recovery (re-resume + re-subscribe) when a session first becomes stalled", async () => {
    const { manager } = createManager();
    const { session } = makeSession();
    const resumeSession = vi.fn().mockResolvedValue(session);
    manager.client = { resumeSession };

    manager.startWork("session-1", "hello");
    await flushMicrotasks();
    expect(resumeSession).toHaveBeenCalledTimes(1);

    // Advance to exactly the stall threshold
    await vi.advanceTimersByTimeAsync(300_000);
    await flushMicrotasks();

    expect(manager.getSessionRunState("session-1")).toBe("stalled");
    // Recovery should have triggered a second resume
    expect(resumeSession).toHaveBeenCalledTimes(2);
  });

  it("retries recovery every 5 minutes while the session remains stalled", async () => {
    const { manager } = createManager();
    const { session } = makeSession();
    const resumeSession = vi.fn().mockResolvedValue(session);
    manager.client = { resumeSession };

    manager.startWork("session-1", "hello");
    await flushMicrotasks();

    // First stall + first recovery at 300s (first eligible watchdog tick)
    await vi.advanceTimersByTimeAsync(300_000);
    await flushMicrotasks();
    expect(resumeSession).toHaveBeenCalledTimes(2);

    // Second recovery after exactly RECOVERY_INTERVAL (300s) while still stalled
    await vi.advanceTimersByTimeAsync(300_000);
    await flushMicrotasks();
    expect(resumeSession).toHaveBeenCalledTimes(3);
  });

  it("re-attaches listeners to the recovered session so later events clear stalled state", async () => {
    const { manager, globalBus } = createManager();
    const events: string[] = [];
    globalBus.subscribe((event) => {
      if (event.sessionId === "session-1" && ["session:busy", "session:stalled", "session:idle"].includes(event.type)) {
        events.push(event.type);
      }
    });
    const initial = makeSession();
    const recovered = makeSession();
    manager.client = {
      resumeSession: vi.fn()
        .mockResolvedValueOnce(initial.session)
        .mockResolvedValueOnce(recovered.session),
    };

    manager.startWork("session-1", "hello");
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(300_000);
    await flushMicrotasks();
    expect(manager.getSessionRunState("session-1")).toBe("stalled");

    initial.getReleaseSend()?.();
    await flushMicrotasks();

    recovered.getHandler()?.({
      type: "assistant.turn_start",
      data: {},
      timestamp: "2026-04-20T00:00:00.000Z",
    });
    await flushMicrotasks();
    expect(manager.getSessionRunState("session-1")).toBe("busy");

    recovered.getHandler()?.({
      type: "session.idle",
      data: {},
      timestamp: "2026-04-20T00:00:01.000Z",
    });
    await flushMicrotasks();

    expect(manager.getSessionRunState("session-1")).toBe("idle");
    expect(events).toEqual(["session:busy", "session:stalled", "session:busy", "session:idle"]);
  });

  it("does not attempt a second recovery while one is already in progress", async () => {
    const { manager } = createManager();
    let resolveRecovery!: () => void;
    const recoveryPromise = new Promise<void>((res) => { resolveRecovery = res; });
    const { session } = makeSession();
    // First call returns immediately; second call hangs (simulates slow recovery)
    const resumeSession = vi.fn()
      .mockResolvedValueOnce(session)
      .mockReturnValueOnce(recoveryPromise.then(() => session));
    manager.client = { resumeSession };

    manager.startWork("session-1", "hello");
    await flushMicrotasks();

    // Trigger first stall + recovery
    await vi.advanceTimersByTimeAsync(300_000);
    await flushMicrotasks();
    expect(resumeSession).toHaveBeenCalledTimes(2);
    // Recovery is still in progress — advance another watchdog interval
    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicrotasks();
    // Should NOT have triggered a third resume while recovery is pending
    expect(resumeSession).toHaveBeenCalledTimes(2);

    resolveRecovery();
  });

  it("updates lastEventAt from events.jsonl mtime to prevent false stale reports", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "bridge-stall-test-"));
    try {
      const sessionId = "session-file-test";
      const sessionStateDir = join(tmpDir, "session-state", sessionId);
      mkdirSync(sessionStateDir, { recursive: true });

      const { manager } = createManager({ copilotHome: tmpDir });
      const { session } = makeSession();
      manager.client = { resumeSession: vi.fn().mockResolvedValue(session) };

      manager.startWork(sessionId, "hello");
      await flushMicrotasks();

      // Write an events.jsonl with the current fake time as the mtime proxy —
      // we'll check that the run record's lastEventAt is pushed forward by file
      // mtime probing once we write a file and advance the watchdog.
      const eventsPath = join(sessionStateDir, "events.jsonl");
      writeFileSync(eventsPath, '{"type":"user.message"}\n');

      // Advance past the stall threshold so the watchdog fires
      await vi.advanceTimersByTimeAsync(300_000);
      await flushMicrotasks();

      // The file's real mtime is close to wall-clock time so it will be
      // greater than the fake-timer lastEventTime; the run record should have
      // lastEventAt updated to the file's mtime.
      const activity = manager.getSessionActivity();
      expect(activity).toHaveLength(1);
      // lastEventAt must be >= the file's mtime (set near test start) which is
      // well after the fake-time start, so staleMs should not be ~300s
      expect(activity[0].staleMs).toBeLessThan(300_000);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("disk-mtime progress does not suppress stall detection or recovery retries", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "bridge-stall-test-disk-"));
    try {
      const sessionId = "session-disk-stall";
      const sessionStateDir = join(tmpDir, "session-state", sessionId);
      mkdirSync(sessionStateDir, { recursive: true });

      const { manager } = createManager({ copilotHome: tmpDir });
      const { session } = makeSession();
      const resumeSession = vi.fn().mockResolvedValue(session);
      manager.client = { resumeSession };

      // Create events.jsonl before starting so its mtime is close to the fake-timer epoch.
      // The live listener stays silent throughout, which is the condition under test.
      const eventsPath = join(sessionStateDir, "events.jsonl");
      writeFileSync(eventsPath, '{"type":"user.message"}\n');

      manager.startWork(sessionId, "hello");
      await flushMicrotasks();
      expect(resumeSession).toHaveBeenCalledTimes(1);

      // Advance to exactly the stall threshold.
      // Even though events.jsonl mtime is fresh relative to real wall-clock time, it must
      // NOT suppress stall detection — lastEventTime is only updated by live SDK events.
      await vi.advanceTimersByTimeAsync(300_000);
      await flushMicrotasks();

      expect(manager.getSessionRunState(sessionId)).toBe("stalled");
      expect(resumeSession).toHaveBeenCalledTimes(2);

      // Recovery retries must still fire on schedule while stalled, regardless of disk activity.
      await vi.advanceTimersByTimeAsync(300_000);
      await flushMicrotasks();

      expect(manager.getSessionRunState(sessionId)).toBe("stalled");
      expect(resumeSession).toHaveBeenCalledTimes(3);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
