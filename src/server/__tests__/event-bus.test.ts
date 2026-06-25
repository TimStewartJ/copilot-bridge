import { describe, it, expect } from "vitest";
import { getOrCreateBus, getBus, hasBus } from "../event-bus.js";
import type { StreamEvent } from "../event-bus.js";

describe("event-bus", () => {
  describe("getOrCreateBus / getBus / hasBus", () => {
    it("creates a bus for a new session", () => {
      const bus = getOrCreateBus("test-create-1");
      expect(bus).toBeDefined();
      expect(hasBus("test-create-1")).toBe(true);
    });

    it("getBus returns undefined for unknown session", () => {
      expect(getBus("nonexistent-bus-id")).toBeUndefined();
    });

    it("getOrCreateBus returns same bus for same session", () => {
      const bus1 = getOrCreateBus("test-same-1");
      const bus2 = getOrCreateBus("test-same-1");
      expect(bus1).toBe(bus2);
    });

    it("getOrCreateBus replaces completed bus", () => {
      const bus1 = getOrCreateBus("test-replace-1");
      bus1.emit({ type: "done", content: "finished" });
      const bus2 = getOrCreateBus("test-replace-1");
      expect(bus2).not.toBe(bus1);
      expect(bus2.complete).toBe(false);
    });
  });

  describe("emit + snapshot", () => {
    it("accumulates delta content", () => {
      const bus = getOrCreateBus("test-delta-1");
      bus.emit({ type: "delta", content: "Hello " });
      bus.emit({ type: "delta", content: "world" });
      const snap = bus.getSnapshot();
      expect(snap.accumulatedContent).toBe("Hello world");
    });

    it("tracks intent", () => {
      const bus = getOrCreateBus("test-intent-1");
      bus.emit({ type: "intent", intent: "Exploring codebase" });
      expect(bus.getSnapshot().intentText).toBe("Exploring codebase");
      expect(bus.getIntentText()).toBe("Exploring codebase");
    });

    it("clears intent on terminal events", () => {
      const terminalEvents: StreamEvent[] = [
        { type: "done", content: "Done" },
        { type: "aborted", content: "Stopped" },
        { type: "error", message: "Boom" },
      ];

      terminalEvents.forEach((event, index) => {
        const bus = getOrCreateBus(`test-terminal-intent-${index}`);
        bus.emit({ type: "intent", intent: "Exploring codebase" });
        bus.emit(event);
        expect(bus.getSnapshot().intentText).toBe("");
        expect(bus.getIntentText()).toBe("");
      });
    });

    it("carries a pending terminal completion into abnormal terminal snapshots and broadcasts", () => {
      const terminalTypes = ["aborted", "shutdown", "error"] as const;

      terminalTypes.forEach((terminalType, index) => {
        const bus = getOrCreateBus(`test-pending-terminal-${terminalType}-${index}`);
        const received: StreamEvent[] = [];
        bus.subscribe((event) => received.push(event));

        bus.emit({ type: "thinking", turnId: "turn-1" });
        bus.emit({
          type: "tool_start",
          toolCallId: "tc-complete",
          name: "task_complete",
          args: { summary: "Wrapped up before the interruption" },
        });

        const terminalEvent: StreamEvent = terminalType === "error"
          ? { type: "error", message: "boom" }
          : { type: terminalType, content: "partial" };
        bus.emit(terminalEvent);

        const snap = bus.getSnapshot();
        expect(snap.terminalType).toBe(terminalType);
        expect(snap.terminalCompletion).toMatchObject({
          content: "Wrapped up before the interruption",
          sourceEventType: "tool.execution_complete",
        });

        const broadcastTerminal = received.find((event) => event.type === terminalType);
        expect(broadcastTerminal?.terminalCompletion).toMatchObject({
          content: "Wrapped up before the interruption",
          sourceEventType: "tool.execution_complete",
        });
      });
    });

    it("does not leak a pending terminal completion into the next turn", () => {
      const bus = getOrCreateBus("test-pending-terminal-reset-1");
      bus.emit({ type: "thinking", turnId: "turn-1" });
      bus.emit({
        type: "tool_start",
        toolCallId: "tc-complete",
        name: "task_complete",
        args: { summary: "First turn summary" },
      });
      // New turn starts before any terminal event fires.
      bus.emit({ type: "thinking", turnId: "turn-2" });
      bus.emit({ type: "aborted", content: "partial" });

      expect(bus.getSnapshot().terminalCompletion).toBeUndefined();
    });

    it("can clear pendingPrompt after the user message is persisted", () => {
      const bus = getOrCreateBus("test-pending-prompt-1");
      bus.setPendingPrompt("recover me");

      expect(bus.getSnapshot().pendingPrompt).toBe("recover me");

      bus.clearPendingPrompt();

      expect(bus.getSnapshot().pendingPrompt).toBeUndefined();
    });

    it("only clears pendingPrompt for the matching persisted user message", () => {
      const bus = getOrCreateBus("test-pending-prompt-match-1");
      bus.setPendingPrompt("steer me");

      bus.clearPendingPrompt("original prompt");

      expect(bus.getSnapshot().pendingPrompt).toBe("steer me");

      bus.clearPendingPrompt("steer me");

      expect(bus.getSnapshot().pendingPrompt).toBeUndefined();
    });

    it("starts a fresh live turn snapshot on thinking events", () => {
      const bus = getOrCreateBus("test-thinking-reset-1");
      bus.setPendingPrompt("steer me");
      bus.emit({ type: "thinking", turnId: "turn-1" });
      bus.emit({ type: "delta", content: "old text" });
      bus.emit({ type: "tool_start", toolCallId: "tc-old", name: "bash" });
      bus.emit({ type: "intent", intent: "Old turn" });

      bus.emit({ type: "thinking", turnId: "turn-2" });

      expect(bus.getSnapshot()).toMatchObject({
        accumulatedContent: "",
        activeTools: [],
        currentTurnTools: [],
        intentText: "",
        pendingPrompt: "steer me",
        turnId: "turn-2",
      });
    });

    it("tracks pending native user input requests in snapshots", () => {
      const bus = getOrCreateBus("test-user-input-pending-1");

      bus.emitUserInputRequested({
        requestId: "request-1",
        question: "Pick one",
        choices: ["yes", "no"],
        allowFreeform: false,
        requestedAt: "2026-04-25T00:00:00.000Z",
        toolCallId: "tool-1",
      }, "2026-04-25T00:00:00.100Z");

      let snap = bus.getSnapshot();
      expect(snap.pendingUserInputs).toHaveLength(1);
      expect(snap.pendingUserInputs[0]).toMatchObject({
        requestId: "request-1",
        question: "Pick one",
        choices: ["yes", "no"],
        allowFreeform: false,
        requestedAt: "2026-04-25T00:00:00.000Z",
        toolCallId: "tool-1",
      });

      bus.emitUserInputRequested({
        requestId: "request-1",
        question: "Pick one again",
        allowFreeform: true,
        requestedAt: "2026-04-25T00:00:01.000Z",
      });

      snap = bus.getSnapshot();
      expect(snap.pendingUserInputs).toHaveLength(1);
      expect(snap.pendingUserInputs[0]).toMatchObject({
        requestId: "request-1",
        question: "Pick one again",
        allowFreeform: true,
        requestedAt: "2026-04-25T00:00:01.000Z",
      });
    });

    it("removes pending user input requests when answered or canceled", () => {
      const bus = getOrCreateBus("test-user-input-complete-1");
      const events: StreamEvent[] = [];
      bus.subscribe((event) => events.push(event));

      bus.emitUserInputRequested({
        requestId: "request-1",
        question: "First?",
        allowFreeform: true,
      });
      bus.emitUserInputRequested({
        requestId: "request-2",
        question: "Second?",
        allowFreeform: true,
      });

      bus.emitUserInputAnswered("request-1", { answer: "yes", wasFreeform: false }, "2026-04-25T00:00:02.000Z");

      expect(bus.getSnapshot().pendingUserInputs.map((request) => request.requestId)).toEqual(["request-2"]);

      bus.emitUserInputCanceled("request-2", {
        reason: "session_ended",
        message: "Session ended",
        timestamp: "2026-04-25T00:00:03.000Z",
      });

      expect(bus.getSnapshot().pendingUserInputs).toEqual([]);
      expect(events.map((event) => event.type)).toEqual([
        "snapshot",
        "user_input_requested",
        "user_input_requested",
        "user_input_answered",
        "user_input_canceled",
      ]);
      expect(events[3]).toMatchObject({
        requestId: "request-1",
        answer: "yes",
        wasFreeform: false,
      });
      expect(events[4]).toMatchObject({
        requestId: "request-2",
        reason: "session_ended",
        message: "Session ended",
      });
    });

    it("normalizes direct user input stream events for snapshots", () => {
      const bus = getOrCreateBus("test-user-input-direct-1");

      bus.emit({
        type: "user_input_requested",
        requestId: "request-direct",
        question: "Direct?",
        timestamp: "2026-04-25T00:00:04.000Z",
      });

      expect(bus.getSnapshot().pendingUserInputs[0]).toMatchObject({
        requestId: "request-direct",
        question: "Direct?",
        allowFreeform: true,
        requestedAt: "2026-04-25T00:00:04.000Z",
      });

      bus.emit({ type: "user_input_canceled", requestId: "request-direct" });

      expect(bus.getSnapshot().pendingUserInputs).toEqual([]);
    });

    it("tracks tool lifecycle", () => {
      const bus = getOrCreateBus("test-tool-1");
      bus.emit({ type: "tool_start", toolCallId: "tc1", name: "grep", timestamp: "2026-04-22T20:00:00.000Z" });
      bus.emit({ type: "tool_start", toolCallId: "tc2", name: "view" });
      bus.emit({ type: "tool_progress", toolCallId: "tc1", message: "Searching..." });
      expect(bus.getSnapshot().activeTools).toHaveLength(2);
      expect(bus.getSnapshot().activeTools[0]).toMatchObject({
        toolCallId: "tc1",
        startedAt: "2026-04-22T20:00:00.000Z",
        progressText: "Searching...",
      });

      bus.emit({ type: "tool_done", toolCallId: "tc1" });
      expect(bus.getSnapshot().activeTools).toHaveLength(1);
      expect(bus.getSnapshot().activeTools[0].name).toBe("view");
    });

    it("keeps completed current-turn tools in snapshots after tool_done", () => {
      const bus = getOrCreateBus("test-current-turn-tools-complete-1");
      bus.emit({ type: "thinking", turnId: "turn-1" });
      bus.emit({
        type: "tool_start",
        toolCallId: "tc1",
        name: "bash",
        args: { command: "npm test" },
        timestamp: "2026-04-22T20:00:00.000Z",
        parentToolCallId: "parent-1",
      });
      bus.emit({ type: "tool_progress", toolCallId: "tc1", message: "Running tests" });
      bus.emit({ type: "tool_output", toolCallId: "tc1", content: "Tests passed" });
      bus.emit({ type: "tool_update", toolCallId: "tc1", name: "npm test", isSubAgent: true });
      bus.emit({
        type: "tool_done",
        toolCallId: "tc1",
        success: true,
        result: "ok",
        timestamp: "2026-04-22T20:00:05.000Z",
      });

      const snap = bus.getSnapshot();
      expect(snap.activeTools).toEqual([]);
      expect(snap.currentTurnTools).toMatchObject([
        {
          toolCallId: "tc1",
          name: "npm test",
          turnId: "turn-1",
          args: { command: "npm test" },
          startedAt: "2026-04-22T20:00:00.000Z",
          progressText: "Tests passed",
          parentToolCallId: "parent-1",
          isSubAgent: true,
          completedAt: "2026-04-22T20:00:05.000Z",
          success: true,
          result: "ok",
        },
      ]);
    });

    it("clears current-turn tools on terminal events", () => {
      const terminalEvents: StreamEvent[] = [
        { type: "done", content: "Done" },
        { type: "aborted", content: "Stopped" },
        { type: "shutdown", content: "Interrupted" },
        { type: "error", message: "Boom" },
      ];

      terminalEvents.forEach((event, index) => {
        const bus = getOrCreateBus(`test-terminal-current-turn-tools-${index}`);
        bus.emit({ type: "tool_start", toolCallId: "tc1", name: "grep" });
        bus.emit({ type: "tool_done", toolCallId: "tc1", success: true });
        expect(bus.getSnapshot().currentTurnTools).toHaveLength(1);

        bus.emit(event);

        expect(bus.getSnapshot().currentTurnTools).toEqual([]);
      });
    });

    it("stamps live turn ids on turn-scoped stream events", () => {
      const bus = getOrCreateBus("test-turn-id-1");
      const events: StreamEvent[] = [];
      bus.subscribe((event) => {
        if (event.type !== "snapshot") events.push(event);
      });

      bus.emit({ type: "thinking" });
      bus.emit({ type: "tool_start", toolCallId: "tc1", name: "grep" });
      bus.emit({ type: "assistant_partial", content: "Interim" });
      bus.emit({ type: "tool_done", toolCallId: "tc1" });
      bus.emit({ type: "done", content: "Done" });

      const turnId = events[0]?.turnId;
      expect(turnId).toMatch(/^turn-[0-9a-f-]{36}$/);
      expect(events).toMatchObject([
        { type: "thinking", turnId },
        { type: "tool_start", toolCallId: "tc1", turnId },
        { type: "assistant_partial", content: "Interim", turnId },
        { type: "tool_done", toolCallId: "tc1", turnId },
        { type: "done", content: "Done", turnId },
      ]);
      expect(bus.getSnapshot()).toMatchObject({
        complete: true,
        turnId,
      });
    });

    it("generates distinct synthetic turn ids across resets", () => {
      const bus = getOrCreateBus("test-turn-id-reset-1");
      bus.emit({ type: "thinking" });
      const firstTurnId = bus.getSnapshot().turnId;

      bus.reset();
      bus.emit({ type: "thinking" });
      const secondTurnId = bus.getSnapshot().turnId;

      expect(firstTurnId).toMatch(/^turn-[0-9a-f-]{36}$/);
      expect(secondTurnId).toMatch(/^turn-[0-9a-f-]{36}$/);
      expect(secondTurnId).not.toBe(firstTurnId);
    });

    it("assistant_partial resets accumulated content", () => {
      const bus = getOrCreateBus("test-partial-1");
      bus.emit({ type: "delta", content: "first message" });
      bus.emit({ type: "assistant_partial" });
      expect(bus.getSnapshot().accumulatedContent).toBe("");
    });

    it("done marks complete and clears state", () => {
      const bus = getOrCreateBus("test-done-1");
      bus.emit({ type: "delta", content: "some text" });
      bus.emit({ type: "tool_start", toolCallId: "tc1", name: "grep" });
      bus.emitUserInputRequested({ requestId: "request-1", question: "Continue?", allowFreeform: true });
      bus.emit({ type: "done", content: "Final answer", timestamp: "2026-04-24T00:00:00.000Z" });

      const snap = bus.getSnapshot();
      expect(snap.complete).toBe(true);
      expect(snap.terminalType).toBe("done");
      expect(snap.terminalTimestamp).toBe("2026-04-24T00:00:00.000Z");
      expect(snap.finalContent).toBe("Final answer");
      expect(snap.accumulatedContent).toBe("");
      expect(snap.activeTools).toEqual([]);
      expect(snap.pendingUserInputs).toEqual([]);
      expect(bus.complete).toBe(true);
    });

    it("error marks complete with error message", () => {
      const bus = getOrCreateBus("test-error-1");
      bus.emit({ type: "error", message: "Something broke" });

      const snap = bus.getSnapshot();
      expect(snap.complete).toBe(true);
      expect(snap.terminalType).toBe("error");
      expect(snap.errorMessage).toBe("Something broke");
    });

    it("aborted marks complete with terminal type", () => {
      const bus = getOrCreateBus("test-aborted-1");
      bus.emit({ type: "aborted", content: "Partial answer", timestamp: "2026-04-24T00:00:01.000Z" });

      const snap = bus.getSnapshot();
      expect(snap.complete).toBe(true);
      expect(snap.terminalType).toBe("aborted");
      expect(snap.terminalTimestamp).toBe("2026-04-24T00:00:01.000Z");
      expect(snap.finalContent).toBe("Partial answer");
    });

    it("shutdown marks complete with terminal type", () => {
      const bus = getOrCreateBus("test-shutdown-1");
      bus.emit({ type: "intent", intent: "Exploring codebase" });
      bus.emit({ type: "shutdown", content: "Partial answer", timestamp: "2026-04-24T00:00:02.000Z" });

      const snap = bus.getSnapshot();
      expect(snap.complete).toBe(true);
      expect(snap.terminalType).toBe("shutdown");
      expect(snap.terminalTimestamp).toBe("2026-04-24T00:00:02.000Z");
      expect(snap.finalContent).toBe("Partial answer");
      expect(snap.intentText).toBe("");
    });
  });

  describe("subscribe", () => {
    it("sends snapshot to new subscriber immediately", () => {
      const bus = getOrCreateBus("test-sub-1");
      bus.emit({ type: "delta", content: "prior content" });

      const events: StreamEvent[] = [];
      bus.subscribe((e) => events.push(e));

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("snapshot");
    });

    it("delivers live events after subscription", () => {
      const bus = getOrCreateBus("test-sub-live-1");
      const events: StreamEvent[] = [];
      bus.subscribe((e) => events.push(e));

      bus.emit({ type: "delta", content: "live" });
      // snapshot + delta
      expect(events).toHaveLength(2);
      expect(events[1].type).toBe("delta");
    });

    it("unsubscribe stops delivery", () => {
      const bus = getOrCreateBus("test-unsub-1");
      const events: StreamEvent[] = [];
      const unsub = bus.subscribe((e) => events.push(e));

      unsub();
      bus.emit({ type: "delta", content: "missed" });
      // Only the initial snapshot
      expect(events).toHaveLength(1);
    });

    it("completed bus sends snapshot but does not subscribe", () => {
      const bus = getOrCreateBus("test-complete-sub-1");
      bus.emit({ type: "done", content: "done" });

      const events: StreamEvent[] = [];
      const unsub = bus.subscribe((e) => events.push(e));

      // Should get snapshot only
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("snapshot");

      // Further emits should not reach listener (it wasn't added)
      bus.emit({ type: "delta", content: "after" });
      expect(events).toHaveLength(1);
    });

    it("listener errors do not break other listeners", () => {
      const bus = getOrCreateBus("test-error-listener-1");
      const events: StreamEvent[] = [];

      bus.subscribe(() => { throw new Error("boom"); });
      bus.subscribe((e) => events.push(e));

      bus.emit({ type: "delta", content: "survives" });
      // Second listener got snapshot + delta despite first throwing
      expect(events).toHaveLength(2);
    });
  });

  describe("reset", () => {
    it("clears all snapshot state", () => {
      const bus = getOrCreateBus("test-reset-1");
      bus.emit({ type: "delta", content: "text" });
      bus.emit({ type: "intent", intent: "doing stuff" });
      bus.emit({ type: "tool_start", toolCallId: "tc1", name: "grep" });
      bus.emit({ type: "tool_done", toolCallId: "tc1", success: true });
      bus.emit({ type: "tool_start", toolCallId: "tc2", name: "view" });
      bus.setPendingPrompt("prompt");
      bus.emitUserInputRequested({ requestId: "request-1", question: "Continue?", allowFreeform: true });
      expect(bus.getSnapshot().currentTurnTools).toHaveLength(2);

      bus.reset();
      const snap = bus.getSnapshot();
      expect(snap.accumulatedContent).toBe("");
      expect(snap.intentText).toBe("");
      expect(snap.activeTools).toEqual([]);
      expect(snap.currentTurnTools).toEqual([]);
      expect(snap.complete).toBe(false);
      expect(snap.terminalType).toBeUndefined();
      expect(snap.finalContent).toBeUndefined();
      expect(snap.errorMessage).toBeUndefined();
      expect(snap.pendingPrompt).toBeUndefined();
      expect(snap.pendingUserInputs).toEqual([]);
    });
  });
});
