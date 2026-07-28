import { describe, it, expect } from "vitest";
import { createEventBusRegistry, getOrCreateBus, getBus, hasBus } from "../event-bus.js";
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
      expect(snap.streamingContent).toBe("Hello world");
    });

    it("notifies subscribers to resync when a bus is deleted", () => {
      const registry = createEventBusRegistry();
      const bus = registry.getOrCreateBus("deleted-session");
      const events: StreamEvent[] = [];
      bus.subscribe((event) => events.push(event));

      registry.deleteBus("deleted-session");

      expect(events.at(-1)).toEqual({ type: "resync_required" });
      expect(registry.getBus("deleted-session")).toBeUndefined();
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

    it("finalizes pending user messages on terminal events", () => {
      const terminalEvents: StreamEvent[] = [
        { type: "done", content: "Done" },
        { type: "error", message: "Boom" },
        { type: "aborted", content: "Stopped" },
        { type: "shutdown", content: "Interrupted" },
      ];

      terminalEvents.forEach((event, index) => {
        const bus = getOrCreateBus(`test-terminal-pending-message-${index}`);
        bus.setPendingPrompt("in flight");

        bus.emit(event);

        expect(bus.getSnapshot().pendingUserMessages).toEqual([
          expect.objectContaining({ content: "in flight", pending: false }),
        ]);
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
        // The completion card itself is replayed from events.jsonl, never re-projected here.
        expect(snap).not.toHaveProperty("terminalCompletion");
        expect(snap).not.toHaveProperty("finalAssistantEntry");
        expect(bus.getTerminalState().terminalCompletion).toMatchObject({
          content: "Wrapped up before the interruption",
          sourceEventType: "tool.execution_complete",
        });

        const broadcastTerminal = received.find((event) => event.type === terminalType);
        expect(broadcastTerminal?.terminalCompletion).toMatchObject({
          content: "Wrapped up before the interruption",
          sourceEventType: "tool.execution_complete",
        });
        expect(broadcastTerminal?.finalAssistantEntry).toBeUndefined();
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

    it("only commits the matching projected user message", () => {
      const bus = getOrCreateBus("test-pending-prompt-match-1");
      bus.setPendingPrompt("steer me");

      bus.commitPendingPrompt("original prompt", "wrong-event");

      expect(bus.getSnapshot().pendingUserMessages[0]).toMatchObject({
        content: "steer me",
        pending: true,
      });

      bus.commitPendingPrompt("steer me", "steer-event");

      expect(bus.getSnapshot().pendingUserMessages[0]).toMatchObject({
        pending: false,
        sourceEventId: "steer-event",
      });
    });

    it("commits identical projected prompts in FIFO order", () => {
      const bus = getOrCreateBus("test-pending-prompt-fifo-1");
      const firstId = bus.setPendingPrompt("yes");
      const secondId = bus.setPendingPrompt("yes");

      bus.commitPendingPrompt("yes", "event-1");

      expect(bus.getSnapshot().pendingUserMessages).toMatchObject([
        { id: firstId, pending: false, sourceEventId: "event-1" },
        { id: secondId, pending: true },
      ]);
    });

    it("broadcasts steering user message updates and discards failed delivery", () => {
      const bus = getOrCreateBus("test-user-message-broadcast-1");
      const events: StreamEvent[] = [];
      bus.subscribe((event) => events.push(event));

      const id = bus.setPendingPrompt("original", [{
        type: "uploaded",
        displayName: "evidence.png",
        mimeType: "image/png",
      }]);
      bus.replacePendingPrompt("updated");

      expect(bus.getSnapshot().pendingUserMessages).toMatchObject([{
        id,
        content: "updated",
        pending: true,
        attachments: [{ displayName: "evidence.png" }],
      }]);

      bus.discardPendingPrompt("updated");

      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: "user_message",
          userMessage: expect.objectContaining({ id, content: "original" }),
        }),
        expect.objectContaining({
          type: "user_message_updated",
          userMessage: expect.objectContaining({
            id,
            content: "updated",
            attachments: [expect.objectContaining({ displayName: "evidence.png" })],
          }),
        }),
        { type: "user_message_discarded", id },
      ]));
      expect(bus.getSnapshot().pendingUserMessages).toEqual([]);
    });

    it("does not retain pending interaction lifecycle state", () => {
      const bus = getOrCreateBus("test-interactions-not-retained");
      const events: StreamEvent[] = [];
      bus.subscribe((event) => events.push(event));

      bus.emitUserInputRequested({
        requestId: "request-1",
        question: "Pick one",
        allowFreeform: true,
      });
      bus.emitElicitationRequested({
        requestId: "el-1",
        message: "Configure deployment",
        mode: "form",
        requestedSchema: { type: "object", properties: {} },
      });

      expect(bus.getSnapshot()).toMatchObject({
        pendingUserInputs: [],
        pendingElicitations: [],
      });
      expect(events.map((event) => event.type)).toEqual([
        "snapshot",
        "user_input_requested",
        "elicitation_requested",
      ]);
    });

    it("hydrates snapshots from an authoritative pending interaction snapshot", () => {
      const bus = getOrCreateBus("test-interaction-hydration");
      const snapshot = bus.getSnapshot({
        pendingUserInputs: [{
          requestId: "request-1",
          question: "Pick one",
          choices: ["yes", "no"],
          allowFreeform: false,
        }],
        pendingElicitations: [{
          requestId: "el-1",
          message: "Configure deployment",
          mode: "form",
          requestedSchema: { type: "object", properties: {} },
        }],
      });

      expect(snapshot.pendingUserInputs.map((request) => request.requestId)).toEqual(["request-1"]);
      expect(snapshot.pendingElicitations.map((request) => request.requestId)).toEqual(["el-1"]);
    });

    it("atomically subscribes before capturing the base snapshot", () => {
      const bus = getOrCreateBus("test-interaction-subscribe-snapshot");
      const events: StreamEvent[] = [];
      const subscription = bus.subscribeWithSnapshot((event) => events.push(event));

      bus.emitUserInputAnswered(
        "request-1",
        { answer: "yes", wasFreeform: false },
        "2026-04-25T00:00:02.000Z",
      );

      expect(subscription.snapshot.type).toBe("snapshot");
      expect(events).toEqual([{
        type: "user_input_answered",
        requestId: "request-1",
        answer: "yes",
        wasFreeform: false,
        timestamp: "2026-04-25T00:00:02.000Z",
      }]);
      subscription.unsubscribe();
    });

    it("tracks tool lifecycle", () => {
      const bus = getOrCreateBus("test-tool-1");
      bus.emit({ type: "tool_start", toolCallId: "tc1", name: "grep", timestamp: "2026-04-22T20:00:00.000Z" });
      bus.emit({ type: "tool_start", toolCallId: "tc2", name: "view" });
      bus.emit({ type: "tool_progress", toolCallId: "tc1", message: "Searching..." });
      expect(bus.getSnapshot().liveTools).toHaveLength(2);
      expect(bus.getSnapshot().liveTools[0]).toMatchObject({
        toolCallId: "tc1",
        startedAt: "2026-04-22T20:00:00.000Z",
        progressText: "Searching...",
      });

      // A finished tool keeps its result on the stream so the view can render it before the next
      // disk read; it is marked complete rather than dropped.
      bus.emit({ type: "tool_done", toolCallId: "tc1", success: true, result: "found it" });
      const afterDone = bus.getSnapshot().liveTools;
      expect(afterDone).toHaveLength(2);
      expect(afterDone.find((tool) => tool.toolCallId === "tc1")).toMatchObject({
        success: true,
        result: "found it",
      });
      expect(afterDone.find((tool) => tool.toolCallId === "tc1")?.completedAt).toBeDefined();
      expect(afterDone.find((tool) => tool.toolCallId === "tc2")?.completedAt).toBeUndefined();
    });

    it("stamps live turn and instance ids on turn-scoped stream events", () => {
      const bus = getOrCreateBus("test-turn-id-1");
      const events: StreamEvent[] = [];
      bus.subscribe((event) => {
        if (event.type !== "snapshot" && event.type !== "history_advanced") events.push(event);
      });

      bus.emit({ type: "thinking" });
      bus.emit({ type: "tool_start", toolCallId: "tc1", name: "grep" });
      bus.emit({ type: "assistant_partial", content: "Interim" });
      bus.emit({ type: "tool_done", toolCallId: "tc1" });
      bus.emit({ type: "done", content: "Done" });

      const turnId = events[0]?.turnId;
      const turnInstanceId = events[0]?.turnInstanceId;
      expect(turnId).toMatch(/^turn-[0-9a-f-]{36}$/);
      expect(turnInstanceId).toMatch(/^turn-instance-[0-9a-f-]{36}$/);
      expect(events).toMatchObject([
        { type: "thinking", turnId, turnInstanceId },
        { type: "tool_start", toolCallId: "tc1", turnId, turnInstanceId },
        { type: "assistant_partial", content: "Interim", turnId, turnInstanceId },
        { type: "tool_done", toolCallId: "tc1", turnId, turnInstanceId },
        { type: "done", content: "Done", turnId, turnInstanceId },
      ]);
      expect(bus.getSnapshot()).toMatchObject({
        complete: true,
        turnId,
        turnInstanceId,
      });
    });

    it("generates distinct synthetic turn ids across resets", () => {
      const bus = getOrCreateBus("test-turn-id-reset-1");
      bus.emit({ type: "thinking" });
      const firstTurnId = bus.getSnapshot().turnId;
      const firstTurnInstanceId = bus.getSnapshot().turnInstanceId;

      bus.reset();
      bus.emit({ type: "thinking" });
      const secondTurnId = bus.getSnapshot().turnId;
      const secondTurnInstanceId = bus.getSnapshot().turnInstanceId;

      expect(firstTurnId).toMatch(/^turn-[0-9a-f-]{36}$/);
      expect(secondTurnId).toMatch(/^turn-[0-9a-f-]{36}$/);
      expect(secondTurnId).not.toBe(firstTurnId);
      expect(firstTurnInstanceId).toMatch(/^turn-instance-[0-9a-f-]{36}$/);
      expect(secondTurnInstanceId).toMatch(/^turn-instance-[0-9a-f-]{36}$/);
      expect(secondTurnInstanceId).not.toBe(firstTurnInstanceId);
    });

    it("assistant_partial finalizes accumulated content when the message carries text", () => {
      const bus = getOrCreateBus("test-partial-1");
      bus.emit({ type: "delta", content: "first message" });
      bus.emit({ type: "assistant_partial", content: "first message", sourceEventId: "a-1" });
      expect(bus.getSnapshot().streamingContent).toBe("");
      expect(bus.getSnapshot().liveAssistantSegments).toMatchObject([
        { content: "first message", sourceEventId: "a-1" },
      ]);
    });

    it("keeps streamed text live when an assistant message carries no content", () => {
      const bus = getOrCreateBus("test-partial-empty");
      bus.emit({ type: "delta", content: "first message" });
      bus.emit({ type: "assistant_partial" });
      // Discarding here would lose text the user is already reading, and stamping it would
      // claim a disk identity that never materializes.
      expect(bus.getSnapshot().streamingContent).toBe("first message");
      expect(bus.getSnapshot().liveAssistantSegments).toEqual([]);
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
      expect(bus.getTerminalState().finalContent).toBe("Final answer");
      expect(snap.streamingContent).toBe("");
      expect(snap.pendingUserInputs).toEqual([]);
      expect(bus.complete).toBe(true);
    });

    it("error marks complete with error message", () => {
      const bus = getOrCreateBus("test-error-1");
      bus.emit({ type: "error", message: "Something broke" });

      const snap = bus.getSnapshot();
      expect(snap.complete).toBe(true);
      expect(snap.terminalType).toBe("error");
      expect(bus.getTerminalState().errorMessage).toBe("Something broke");
    });

    it("aborted marks complete with terminal type", () => {
      const bus = getOrCreateBus("test-aborted-1");
      bus.emit({ type: "aborted", content: "Partial answer", timestamp: "2026-04-24T00:00:01.000Z" });

      const snap = bus.getSnapshot();
      expect(snap.complete).toBe(true);
      expect(snap.terminalType).toBe("aborted");
      expect(snap.terminalTimestamp).toBe("2026-04-24T00:00:01.000Z");
      expect(bus.getTerminalState().finalContent).toBe("Partial answer");
    });

    it("shutdown marks complete with terminal type", () => {
      const bus = getOrCreateBus("test-shutdown-1");
      bus.emit({ type: "intent", intent: "Exploring codebase" });
      bus.emit({ type: "shutdown", content: "Partial answer", timestamp: "2026-04-24T00:00:02.000Z" });

      const snap = bus.getSnapshot();
      expect(snap.complete).toBe(true);
      expect(snap.terminalType).toBe("shutdown");
      expect(snap.terminalTimestamp).toBe("2026-04-24T00:00:02.000Z");
      expect(bus.getTerminalState().finalContent).toBe("Partial answer");
      expect(snap.intentText).toBe("");
    });

    it("never stamps streamed text with an event id that disk history will not contain", () => {
      const bus = getOrCreateBus("test-empty-assistant-message");
      bus.emit({ type: "thinking", turnId: "turn-1" });
      bus.emit({ type: "delta", content: "Let me check that" });
      // A tool-only assistant message carries no content, so events.jsonl records no entry for it.
      bus.emit({ type: "assistant_partial", content: "", sourceEventId: "empty-message-1" });

      // The streamed text must stay live rather than claiming an id it can never retire against.
      expect(bus.getSnapshot().liveAssistantSegments).toEqual([]);
      expect(bus.getSnapshot().streamingContent).toBe("Let me check that");

      // The next real assistant message finalizes it against an id disk will actually carry.
      bus.emit({ type: "assistant_partial", content: "Checked.", sourceEventId: "real-message-1" });
      expect(bus.getSnapshot().liveAssistantSegments).toMatchObject([
        { content: "Checked.", sourceEventId: "real-message-1" },
      ]);
    });

    it("holds published visuals on the stream until disk history can carry them", () => {
      const bus = getOrCreateBus("test-live-visuals");
      bus.emit({ type: "thinking", turnId: "turn-1" });
      bus.emit({
        type: "visual_published",
        artifactId: "artifact-1",
        kind: "mermaid",
        title: "Diagram",
        url: "/api/x",
      });

      expect(bus.getSnapshot().liveVisuals).toMatchObject([
        { artifactId: "artifact-1", kind: "mermaid", title: "Diagram" },
      ]);

      // A new turn proves the previous turn's visual reached events.jsonl.
      bus.emit({ type: "thinking", turnId: "turn-2" });
      expect(bus.getSnapshot().liveVisuals).toEqual([]);
    });

    it("surfaces a completion card immediately and retires it on the next turn", () => {
      const bus = getOrCreateBus("test-live-completion");
      const received: StreamEvent[] = [];
      bus.subscribe((event) => received.push(event));
      bus.emit({ type: "thinking", turnId: "turn-1" });
      bus.emit({
        type: "tool_start",
        toolCallId: "tc-complete",
        name: "task_complete",
        args: { summary: "All done" },
      });
      bus.emit({ type: "done", content: "All done", sourceEventId: "terminal-1" });

      expect(bus.getSnapshot().liveCompletion).toMatchObject({
        sourceEventId: "terminal-1",
        completion: { content: "All done" },
      });
      expect(received.find((event) => event.type === "done")?.liveCompletion).toMatchObject({
        completion: { content: "All done" },
      });

      bus.emit({ type: "thinking", turnId: "turn-2" });
      expect(bus.getSnapshot().liveCompletion).toBeUndefined();
    });

    it("finalizes tools still open at a terminal instead of leaving them running", () => {
      const bus = getOrCreateBus("test-terminal-open-tools");
      bus.emit({ type: "thinking", turnId: "turn-1" });
      bus.emit({ type: "tool_start", toolCallId: "tc-open", name: "bash" });
      bus.emit({ type: "aborted", content: "stopped", timestamp: "2026-07-26T10:00:00.000Z" });

      expect(bus.getSnapshot().liveTools).toMatchObject([
        { toolCallId: "tc-open", completedAt: "2026-07-26T10:00:00.000Z", success: false },
      ]);
    });

    it("emits a bridge-native run notice only when disk history cannot represent the outcome", () => {
      const cases = [
        {
          id: "notice-error",
          event: { type: "error", message: "boom", timestamp: "2026-07-23T16:00:00.000Z" },
          expected: { kind: "error", message: "boom" },
        },
        {
          id: "notice-aborted",
          event: { type: "aborted", content: "partial", timestamp: "2026-07-23T16:00:01.000Z" },
          expected: { kind: "stopped" },
        },
        {
          id: "notice-shutdown",
          event: { type: "shutdown", content: "partial", timestamp: "2026-07-23T16:00:02.000Z" },
          expected: { kind: "interrupted" },
        },
        {
          // A done run the SDK never saw (local slash command) has no disk entry to replay.
          id: "notice-command",
          event: { type: "done", content: "/context output", timestamp: "2026-07-23T16:00:03.000Z" },
          expected: { kind: "command", content: "/context output" },
        },
      ] as const;

      for (const { id, event, expected } of cases) {
        const bus = getOrCreateBus(`test-run-notice-${id}`);
        const received: StreamEvent[] = [];
        bus.subscribe((entry) => received.push(entry));
        bus.emit({ type: "thinking", turnId: "provider-turn-1" });
        bus.emit(event as StreamEvent);

        expect(bus.getSnapshot().runNotice).toMatchObject(expected);
        expect(received.find((entry) => entry.type === event.type)?.runNotice)
          .toMatchObject(expected);
      }
    });

    it("emits no run notice when the terminal event is replayable from disk history", () => {
      const bus = getOrCreateBus("test-run-notice-none");
      bus.emit({ type: "thinking", turnId: "provider-turn-1" });
      bus.emit({
        type: "done",
        content: "All set",
        sourceEventId: "terminal-event-1",
        assistantSourceEventId: "assistant-event-1",
      });
      expect(bus.getSnapshot().runNotice).toBeUndefined();
    });

    it("announces history advances for events the SDK also persists", () => {
      const bus = getOrCreateBus("test-history-advanced");
      const received: StreamEvent[] = [];
      bus.subscribe((event) => received.push(event));

      bus.emit({ type: "thinking", turnId: "turn-1" });
      bus.emit({ type: "delta", content: "typing" });
      expect(received.filter((event) => event.type === "history_advanced")).toHaveLength(0);

      bus.emit({ type: "tool_start", toolCallId: "tc-1", name: "grep" });
      bus.emit({ type: "tool_done", toolCallId: "tc-1", success: true });
      bus.emit({ type: "assistant_partial", content: "answer", sourceEventId: "assistant-1" });
      bus.emit({ type: "done", content: "answer", sourceEventId: "terminal-1" });

      const advances = received.filter((event) => event.type === "history_advanced");
      expect(advances).toHaveLength(4);
      // The signal is payload-free; the client owns its own refresh epoch.
      expect(advances).toEqual(Array.from({ length: 4 }, () => ({ type: "history_advanced" })));
    });

    it("does not announce a history advance for bridge-native assistant output", () => {
      const bus = getOrCreateBus("test-history-advanced-native");
      const received: StreamEvent[] = [];
      bus.subscribe((event) => received.push(event));

      bus.emit({ type: "assistant_partial", content: "/context output", bridgeNative: true });

      expect(received.filter((event) => event.type === "history_advanced")).toHaveLength(0);
      const segments = bus.getSnapshot().liveAssistantSegments;
      expect(segments).toHaveLength(1);
      expect(segments[0]?.content).toBe("/context output");
      expect(segments[0]?.sourceEventId).toBeUndefined();
    });

    it("drops disk-backed assistant segments at a turn boundary but keeps bridge-native ones", () => {
      const bus = getOrCreateBus("test-segment-turn-boundary");
      bus.emit({ type: "thinking", turnId: "turn-1" });
      bus.emit({ type: "assistant_partial", content: "persisted", sourceEventId: "assistant-1" });
      bus.emit({ type: "assistant_partial", content: "local only", bridgeNative: true });
      expect(bus.getSnapshot().liveAssistantSegments).toHaveLength(2);

      bus.emit({ type: "thinking", turnId: "turn-2" });

      expect(bus.getSnapshot().liveAssistantSegments).toMatchObject([{ content: "local only" }]);
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
      expect(bus.getSnapshot().liveTools).toHaveLength(2);

      bus.reset();
      const snap = bus.getSnapshot();
      expect(snap.streamingContent).toBe("");
      expect(snap.intentText).toBe("");
      expect(snap.liveTools).toEqual([]);
      expect(snap.liveVisuals).toEqual([]);
      expect(snap.complete).toBe(false);
      expect(snap.terminalType).toBeUndefined();
      expect(snap.runNotice).toBeUndefined();
      // History ordering belongs to events.jsonl; the snapshot carries no server-side counter.
      expect(snap).not.toHaveProperty("historySeq");
      expect(snap).not.toHaveProperty("pendingPrompt");
      expect(snap.pendingUserMessages).toEqual([]);
      expect(snap.pendingUserInputs).toEqual([]);
    });
  });
});
