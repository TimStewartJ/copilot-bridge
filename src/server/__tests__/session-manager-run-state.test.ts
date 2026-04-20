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

    return { manager, globalBus, eventBusRegistry };
  }

  function makeSession(opts: { replayOnSubscribe?: any | (() => any) } = {}) {
    const handlers: Array<(event: any) => void> = [];
    let releaseSend: (() => void) | undefined;
    const session = {
      on: vi.fn((cb: (event: any) => void) => {
        handlers.push(cb);
        if (opts.replayOnSubscribe) {
          const replayed = typeof opts.replayOnSubscribe === "function"
            ? opts.replayOnSubscribe()
            : opts.replayOnSubscribe;
          cb(replayed);
        }
        return vi.fn(() => {
          const idx = handlers.indexOf(cb);
          if (idx !== -1) handlers.splice(idx, 1);
        });
      }),
      send: vi.fn(async () => {
        await new Promise<void>((resolve) => {
          releaseSend = resolve;
        });
      }),
      abort: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
    };
    const getHandler = () => {
      if (handlers.length === 0) return undefined;
      return (event: any) => {
        for (const handler of [...handlers]) {
          handler(event);
        }
      };
    };
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
    const recoveryEventBase = Date.now();

    getHandler()?.({
      type: "assistant.turn_start",
      data: {},
      timestamp: new Date(recoveryEventBase + 1_000).toISOString(),
    });
    await flushMicrotasks();

    expect(manager.getSessionRunState("session-1")).toBe("busy");
    expect(manager.isSessionStalled("session-1")).toBe(false);

    getReleaseSend()?.();
    await flushMicrotasks();
    getHandler()?.({
      type: "session.idle",
      data: {},
      timestamp: new Date(recoveryEventBase + 2_000).toISOString(),
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
    expect(initial.session.disconnect).toHaveBeenCalledTimes(1);
    const recoveryEventBase = Date.now();

    initial.getReleaseSend()?.();
    await flushMicrotasks();

    recovered.getHandler()?.({
      type: "assistant.turn_start",
      data: {},
      timestamp: new Date(recoveryEventBase + 1_000).toISOString(),
    });
    await flushMicrotasks();
    expect(manager.getSessionRunState("session-1")).toBe("busy");

    recovered.getHandler()?.({
      type: "session.idle",
      data: {},
      timestamp: new Date(recoveryEventBase + 2_000).toISOString(),
    });
    await flushMicrotasks();

    expect(manager.getSessionRunState("session-1")).toBe("idle");
    expect(events).toEqual(["session:busy", "session:stalled", "session:busy", "session:idle"]);
  });

  it("resolves a stalled turn from persisted terminal events without waiting for a new live event", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "bridge-stall-terminal-"));
    try {
      const sessionId = "session-terminal";
      const sessionStateDir = join(tmpDir, "session-state", sessionId);
      mkdirSync(sessionStateDir, { recursive: true });

      const { manager, globalBus } = createManager({ copilotHome: tmpDir });
      const events: string[] = [];
      globalBus.subscribe((event) => {
        if (event.sessionId === sessionId && ["session:busy", "session:stalled", "session:idle"].includes(event.type)) {
          events.push(event.type);
        }
      });

      const initial = makeSession();
      const resumeSession = vi.fn().mockResolvedValue(initial.session);
      manager.client = { resumeSession };

      manager.startWork(sessionId, "hello");
      await flushMicrotasks();
      initial.getReleaseSend()?.();
      await flushMicrotasks();
      const baseTime = Date.now();

      writeFileSync(join(sessionStateDir, "events.jsonl"), [
        JSON.stringify({ type: "user.message", timestamp: new Date(baseTime + 1_000).toISOString(), data: { content: "hello" } }),
        JSON.stringify({ type: "assistant.message", timestamp: new Date(baseTime + 2_000).toISOString(), data: { content: "done" } }),
        JSON.stringify({ type: "session.idle", timestamp: new Date(baseTime + 3_000).toISOString(), data: {} }),
      ].join("\n") + "\n");

      await vi.advanceTimersByTimeAsync(300_000);
      await flushMicrotasks();

      expect(manager.getSessionRunState(sessionId)).toBe("idle");
      expect(events).toEqual(["session:busy", "session:stalled", "session:idle"]);
      expect(resumeSession).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
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

  it("keeps the existing session listener and abort path if recovery resume fails", async () => {
    const { manager } = createManager();
    const initial = makeSession();
    const resumeSession = vi.fn()
      .mockResolvedValueOnce(initial.session)
      .mockRejectedValueOnce(new Error("resume failed"));
    manager.client = { resumeSession };

    manager.startWork("session-1", "hello");
    await flushMicrotasks();
    initial.getReleaseSend()?.();
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(300_000);
    await flushMicrotasks();

    expect(manager.getSessionRunState("session-1")).toBe("stalled");
    expect(initial.session.disconnect).not.toHaveBeenCalled();
    expect(resumeSession).toHaveBeenCalledTimes(2);

    await expect(manager.abortSession("session-1")).resolves.toBe(true);
    expect(initial.session.abort).toHaveBeenCalledTimes(1);

    initial.getHandler()?.({
      type: "abort",
      data: { reason: "user initiated" },
      timestamp: "2026-04-20T00:00:02.000Z",
    });
    await flushMicrotasks();

    expect(manager.getSessionRunState("session-1")).toBe("idle");
  });

  it("does not attach a recovered listener after the original stalled turn already finished", async () => {
    const { manager } = createManager();
    const initial = makeSession();
    const recovered = makeSession();
    let resolveRecovery!: (session: any) => void;
    const recoveryPromise = new Promise<any>((resolve) => {
      resolveRecovery = resolve;
    });
    const resumeSession = vi.fn()
      .mockResolvedValueOnce(initial.session)
      .mockReturnValueOnce(recoveryPromise);
    manager.client = { resumeSession };

    manager.startWork("session-1", "hello");
    await flushMicrotasks();
    initial.getReleaseSend()?.();
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(300_000);
    await flushMicrotasks();

    initial.getHandler()?.({
      type: "session.idle",
      data: {},
      timestamp: "2026-04-20T00:00:02.000Z",
    });
    await flushMicrotasks();
    expect(manager.getSessionRunState("session-1")).toBe("idle");

    resolveRecovery(recovered.session);
    await flushMicrotasks();

    expect(recovered.session.on).not.toHaveBeenCalled();
    expect(recovered.session.disconnect).toHaveBeenCalledTimes(1);
  });

  it("keeps the original listener when stalled recovery wakes up after live events have resumed", async () => {
    const { manager } = createManager();
    const initial = makeSession();
    const recovered = makeSession();
    let resolveRecovery!: (session: any) => void;
    const recoveryPromise = new Promise<any>((resolve) => {
      resolveRecovery = resolve;
    });
    manager.client = {
      resumeSession: vi.fn()
        .mockResolvedValueOnce(initial.session)
        .mockReturnValueOnce(recoveryPromise),
    };

    manager.startWork("session-1", "hello");
    await flushMicrotasks();
    initial.getReleaseSend()?.();
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(300_000);
    await flushMicrotasks();

    initial.getHandler()?.({
      type: "assistant.turn_start",
      data: {},
      timestamp: new Date(Date.now() + 1_000).toISOString(),
    });
    await flushMicrotasks();
    expect(manager.getSessionRunState("session-1")).toBe("busy");

    resolveRecovery(recovered.session);
    await flushMicrotasks();

    expect(recovered.session.on).not.toHaveBeenCalled();
    expect(recovered.session.disconnect).toHaveBeenCalledTimes(1);
    expect(initial.session.disconnect).not.toHaveBeenCalled();
  });

  it("ignores replayed historical events when attaching a recovered listener", async () => {
    const { manager } = createManager();
    const initial = makeSession();
    const staleTimestamp = new Date(Date.now() - 1_000).toISOString();
    const recovered = makeSession({
      replayOnSubscribe: {
        type: "session.idle",
        data: {},
        timestamp: staleTimestamp,
      },
    });
    manager.client = {
      resumeSession: vi.fn()
        .mockResolvedValueOnce(initial.session)
        .mockResolvedValueOnce(recovered.session),
    };

    manager.startWork("session-1", "hello");
    await flushMicrotasks();
    initial.getReleaseSend()?.();
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(300_000);
    await flushMicrotasks();
    expect(manager.getSessionRunState("session-1")).toBe("stalled");

    recovered.getHandler()?.({
      type: "assistant.turn_start",
      data: {},
      timestamp: new Date(Date.now() + 1_000).toISOString(),
    });
    await flushMicrotasks();
    expect(manager.getSessionRunState("session-1")).toBe("busy");

    recovered.getHandler()?.({
      type: "session.idle",
      data: {},
      timestamp: new Date(Date.now() + 2_000).toISOString(),
    });
    await flushMicrotasks();
    expect(manager.getSessionRunState("session-1")).toBe("idle");
  });

  it("processes fresh replayed terminal events from the recovered listener", async () => {
    const { manager } = createManager();
    const initial = makeSession();
    const recovered = makeSession({
      replayOnSubscribe: () => ({
        type: "session.idle",
        data: {},
        timestamp: new Date(Date.now() + 1_000).toISOString(),
      }),
    });
    manager.client = {
      resumeSession: vi.fn()
        .mockResolvedValueOnce(initial.session)
        .mockResolvedValueOnce(recovered.session),
    };

    manager.startWork("session-1", "hello");
    await flushMicrotasks();
    initial.getReleaseSend()?.();
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(300_000);
    await flushMicrotasks();

    expect(manager.getSessionRunState("session-1")).toBe("idle");
  });

  it("ignores replayed same-turn events that were already processed before the stall", async () => {
    const { manager } = createManager();
    const replayedTurnStart = new Date(Date.now() + 1_000).toISOString();
    const initial = makeSession();
    const recovered = makeSession({
      replayOnSubscribe: {
        type: "assistant.turn_start",
        data: {},
        timestamp: replayedTurnStart,
      },
    });
    manager.client = {
      resumeSession: vi.fn()
        .mockResolvedValueOnce(initial.session)
        .mockResolvedValueOnce(recovered.session),
    };

    manager.startWork("session-1", "hello");
    await flushMicrotasks();
    initial.getReleaseSend()?.();
    await flushMicrotasks();

    initial.getHandler()?.({
      type: "assistant.turn_start",
      data: {},
      timestamp: replayedTurnStart,
    });
    await flushMicrotasks();
    expect(manager.getSessionRunState("session-1")).toBe("busy");

    await vi.advanceTimersByTimeAsync(300_000);
    await flushMicrotasks();
    expect(manager.getSessionRunState("session-1")).toBe("stalled");

    recovered.getHandler()?.({
      type: "assistant.turn_start",
      data: {},
      timestamp: new Date(Date.now() + 1_000).toISOString(),
    });
    await flushMicrotasks();
    expect(manager.getSessionRunState("session-1")).toBe("busy");
  });

  it("does not duplicate replayed same-turn delta content during recovery", async () => {
    const { manager, eventBusRegistry } = createManager();
    const replayedDeltaTimestamp = new Date(Date.now() + 1_000).toISOString();
    const initial = makeSession();
    const recovered = makeSession({
      replayOnSubscribe: {
        type: "assistant.message_delta",
        data: { deltaContent: "dup" },
        timestamp: replayedDeltaTimestamp,
      },
    });
    manager.client = {
      resumeSession: vi.fn()
        .mockResolvedValueOnce(initial.session)
        .mockResolvedValueOnce(recovered.session),
    };

    manager.startWork("session-1", "hello");
    await flushMicrotasks();
    initial.getReleaseSend()?.();
    await flushMicrotasks();

    initial.getHandler()?.({
      type: "assistant.message_delta",
      data: { deltaContent: "dup" },
      timestamp: replayedDeltaTimestamp,
    });
    await flushMicrotasks();
    expect(eventBusRegistry.getBus("session-1")?.getSnapshot().accumulatedContent).toBe("dup");

    await vi.advanceTimersByTimeAsync(300_000);
    await flushMicrotasks();
    expect(manager.getSessionRunState("session-1")).toBe("stalled");
    expect(eventBusRegistry.getBus("session-1")?.getSnapshot().accumulatedContent).toBe("dup");

    recovered.getHandler()?.({
      type: "assistant.message_delta",
      data: { deltaContent: "new" },
      timestamp: new Date(Date.now() + 1_000).toISOString(),
    });
    await flushMicrotasks();
    expect(eventBusRegistry.getBus("session-1")?.getSnapshot().accumulatedContent).toBe("dupnew");
  });

  it("processes distinct recovered events that share a timestamp with the last handled event", async () => {
    const { manager } = createManager();
    const sharedTimestamp = new Date(Date.now() + 1_000).toISOString();
    const initial = makeSession();
    const recovered = makeSession({
      replayOnSubscribe: {
        type: "session.idle",
        data: {},
        timestamp: sharedTimestamp,
      },
    });
    manager.client = {
      resumeSession: vi.fn()
        .mockResolvedValueOnce(initial.session)
        .mockResolvedValueOnce(recovered.session),
    };

    manager.startWork("session-1", "hello");
    await flushMicrotasks();
    initial.getReleaseSend()?.();
    await flushMicrotasks();

    initial.getHandler()?.({
      type: "assistant.turn_start",
      data: {},
      timestamp: sharedTimestamp,
    });
    await flushMicrotasks();
    expect(manager.getSessionRunState("session-1")).toBe("busy");

    await vi.advanceTimersByTimeAsync(300_000);
    await flushMicrotasks();

    expect(manager.getSessionRunState("session-1")).toBe("idle");
  });

  it("ignores historical recovered events emitted after subscription becomes active", async () => {
    const { manager } = createManager();
    const initialTurnBase = Date.now();
    const initial = makeSession();
    const recovered = makeSession();
    manager.client = {
      resumeSession: vi.fn()
        .mockResolvedValueOnce(initial.session)
        .mockResolvedValueOnce(recovered.session),
    };

    manager.startWork("session-1", "hello");
    await flushMicrotasks();
    initial.getReleaseSend()?.();
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(300_000);
    await flushMicrotasks();
    expect(manager.getSessionRunState("session-1")).toBe("stalled");

    recovered.getHandler()?.({
      type: "session.idle",
      data: {},
      timestamp: new Date(initialTurnBase - 1_000).toISOString(),
    });
    await flushMicrotasks();
    expect(manager.getSessionRunState("session-1")).toBe("stalled");

    recovered.getHandler()?.({
      type: "assistant.turn_start",
      data: {},
      timestamp: new Date(Date.now() + 1_000).toISOString(),
    });
    await flushMicrotasks();
    expect(manager.getSessionRunState("session-1")).toBe("busy");
  });

  it("resolves from persisted terminal events that land while recovery resume is still in flight", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "bridge-stall-terminal-after-resume-"));
    try {
      const sessionId = "session-terminal-after-resume";
      const sessionStateDir = join(tmpDir, "session-state", sessionId);
      mkdirSync(sessionStateDir, { recursive: true });

      const { manager } = createManager({ copilotHome: tmpDir });
      const initial = makeSession();
      const recovered = makeSession();
      let resolveRecovery!: (session: any) => void;
      const recoveryPromise = new Promise<any>((resolve) => {
        resolveRecovery = resolve;
      });
      manager.client = {
        resumeSession: vi.fn()
          .mockResolvedValueOnce(initial.session)
          .mockReturnValueOnce(recoveryPromise),
      };

      manager.startWork(sessionId, "hello");
      await flushMicrotasks();
      initial.getReleaseSend()?.();
      await flushMicrotasks();

      await vi.advanceTimersByTimeAsync(300_000);
      await flushMicrotasks();

      const baseTime = Date.now();
      writeFileSync(join(sessionStateDir, "events.jsonl"), [
        JSON.stringify({ type: "user.message", timestamp: new Date(baseTime + 1_000).toISOString(), data: { content: "hello" } }),
        JSON.stringify({ type: "assistant.message", timestamp: new Date(baseTime + 2_000).toISOString(), data: { content: "done" } }),
        JSON.stringify({ type: "session.idle", timestamp: new Date(baseTime + 3_000).toISOString(), data: {} }),
      ].join("\n") + "\n");

      resolveRecovery(recovered.session);
      await flushMicrotasks();

      expect(manager.getSessionRunState(sessionId)).toBe("idle");
      expect(recovered.session.on).not.toHaveBeenCalled();
      expect(recovered.session.disconnect).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("resolves from persisted terminal events if recovery resume fails after the turn already finished on disk", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "bridge-stall-terminal-after-failure-"));
    try {
      const sessionId = "session-terminal-after-failure";
      const sessionStateDir = join(tmpDir, "session-state", sessionId);
      mkdirSync(sessionStateDir, { recursive: true });

      const { manager } = createManager({ copilotHome: tmpDir });
      const initial = makeSession();
      let rejectRecovery!: (error: Error) => void;
      const recoveryPromise = new Promise<any>((_, reject) => {
        rejectRecovery = reject;
      });
      manager.client = {
        resumeSession: vi.fn()
          .mockResolvedValueOnce(initial.session)
          .mockReturnValueOnce(recoveryPromise),
      };

      manager.startWork(sessionId, "hello");
      await flushMicrotasks();
      initial.getReleaseSend()?.();
      await flushMicrotasks();

      await vi.advanceTimersByTimeAsync(300_000);
      await flushMicrotasks();

      const baseTime = Date.now();
      writeFileSync(join(sessionStateDir, "events.jsonl"), [
        JSON.stringify({ type: "user.message", timestamp: new Date(baseTime + 1_000).toISOString(), data: { content: "hello" } }),
        JSON.stringify({ type: "assistant.message", timestamp: new Date(baseTime + 2_000).toISOString(), data: { content: "done" } }),
        JSON.stringify({ type: "session.idle", timestamp: new Date(baseTime + 3_000).toISOString(), data: {} }),
      ].join("\n") + "\n");

      rejectRecovery(new Error("resume failed"));
      await flushMicrotasks();

      expect(manager.getSessionRunState(sessionId)).toBe("idle");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
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
