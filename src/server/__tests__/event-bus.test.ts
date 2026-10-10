import { describe, it, expect, vi } from "vitest";
import { createEventBusRegistry } from "../event-bus.js";
import type { StreamEvent } from "../event-bus.js";

const { getOrCreateBus, hasBus } = createEventBusRegistry();

describe("event-bus", () => {
  describe("getOrCreateBus / getBus / hasBus", () => {
    it("creates a bus for a new session and getOrCreateBus returns the same bus", () => {
      const bus = getOrCreateBus("test-create-1");
      expect(bus).toBeDefined();
      expect(hasBus("test-create-1")).toBe(true);
      // same call returns the same bus
      const bus2 = getOrCreateBus("test-create-1");
      expect(bus2).toBe(bus);
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

    it("preserves a client message id in the projected prompt", () => {
      const bus = getOrCreateBus("test-client-message-id-1");

      const id = bus.setPendingPrompt("hello", undefined, "client-message-1");

      expect(id).toBe("client-message-1");
      expect(bus.getSnapshot().pendingUserMessages).toMatchObject([{
        id: "client-message-1",
        content: "hello",
        pending: true,
      }]);
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

    it("indexes pending interactions for reconnect hydration and clears them per request", () => {
      const bus = getOrCreateBus("test-interactions-indexed");
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

      // Copilot CLI >= 1.0.74 has no wire method that lists pending requests, so
      // a reconnecting browser can only re-render an in-flight prompt from here.
      expect(bus.getSnapshot()).toMatchObject({
        pendingUserInputs: [{ requestId: "request-1", allowFreeform: true }],
        pendingElicitations: [{ requestId: "el-1", message: "Configure deployment" }],
      });
      expect(events.map((event) => event.type)).toEqual([
        "snapshot",
        "user_input_requested",
        "elicitation_requested",
      ]);

      bus.emitUserInputAnswered("request-1", { answer: "yes", wasFreeform: true });
      expect(bus.getSnapshot().pendingUserInputs).toEqual([]);
      expect(bus.getSnapshot().pendingElicitations).toHaveLength(1);

      bus.emitElicitationResolved("el-1", "accept");
      expect(bus.getSnapshot().pendingElicitations).toEqual([]);
    });

    it("drops indexed elicitations that are canceled rather than resolved", () => {
      const bus = getOrCreateBus("test-interactions-canceled");
      bus.emitElicitationRequested({
        requestId: "el-cancel",
        message: "Configure deployment",
        mode: "form",
        requestedSchema: { type: "object", properties: {} },
      });
      bus.emitUserInputRequested({
        requestId: "ui-cancel",
        question: "Pick one",
        allowFreeform: true,
      });

      bus.emitElicitationCanceled("el-cancel", { reason: "session_ended" });
      bus.emitUserInputCanceled("ui-cancel", { reason: "session_ended" });

      expect(bus.getPendingInteractionIndex()).toEqual({
        pendingUserInputs: [],
        pendingElicitations: [],
      });
    });

    it("keeps indexed pending interactions across turn boundaries", () => {
      const bus = getOrCreateBus("test-interactions-turn-boundary");
      bus.emitElicitationRequested({
        requestId: "el-live",
        message: "Configure deployment",
        mode: "form",
        requestedSchema: { type: "object", properties: {} },
      });

      // `thinking` starts a turn, which resets ephemeral run state. An `ask_user`
      // prompt blocks inside its tool call while the run keeps streaming, so the
      // request must survive.
      bus.emit({ type: "thinking" });

      expect(bus.getSnapshot().pendingElicitations.map((request) => request.requestId))
        .toEqual(["el-live"]);
    });

    it("stops replaying indexed pending interactions once the run is terminal", () => {
      const bus = getOrCreateBus("test-interactions-terminal");
      bus.emitElicitationRequested({
        requestId: "el-terminal",
        message: "Configure deployment",
        mode: "form",
        requestedSchema: { type: "object", properties: {} },
      });

      bus.emit({ type: "done", content: "" });

      expect(bus.getSnapshot().pendingElicitations).toEqual([]);
      // Terminal cleanup still needs the ids so it can cancel them upstream.
      expect(bus.getPendingInteractionIndex().pendingElicitations.map((r) => r.requestId))
        .toEqual(["el-terminal"]);

      bus.clearPendingInteractionIndex();
      expect(bus.getPendingInteractionIndex().pendingElicitations).toEqual([]);
    });

    it("hydrates snapshots from an authoritative pending interaction snapshot", () => {
      const bus = getOrCreateBus("test-interaction-hydration");
      bus.emitElicitationRequested({
        requestId: "el-cached",
        message: "Stale cached entry",
        mode: "form",
        requestedSchema: { type: "object", properties: {} },
      });
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

      // An explicit runtime snapshot always wins over the listing cache.
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

    it("error, aborted, and shutdown each mark complete with the matching terminal type", () => {
      // error carries an error message
      const errBus = getOrCreateBus("test-error-1");
      errBus.emit({ type: "error", message: "Something broke" });
      expect(errBus.getSnapshot().complete, "error complete").toBe(true);
      expect(errBus.getSnapshot().terminalType, "error terminalType").toBe("error");
      expect(errBus.getTerminalState().errorMessage, "error message").toBe("Something broke");

      // aborted carries final content and timestamp
      const abortBus = getOrCreateBus("test-aborted-1");
      abortBus.emit({ type: "aborted", content: "Partial answer", timestamp: "2026-04-24T00:00:01.000Z" });
      expect(abortBus.getSnapshot().complete, "aborted complete").toBe(true);
      expect(abortBus.getSnapshot().terminalType, "aborted terminalType").toBe("aborted");
      expect(abortBus.getSnapshot().terminalTimestamp, "aborted timestamp").toBe("2026-04-24T00:00:01.000Z");
      expect(abortBus.getTerminalState().finalContent, "aborted finalContent").toBe("Partial answer");

      // shutdown clears intent
      const shutBus = getOrCreateBus("test-shutdown-1");
      shutBus.emit({ type: "intent", intent: "Exploring codebase" });
      shutBus.emit({ type: "shutdown", content: "Partial answer", timestamp: "2026-04-24T00:00:02.000Z" });
      expect(shutBus.getSnapshot().complete, "shutdown complete").toBe(true);
      expect(shutBus.getSnapshot().terminalType, "shutdown terminalType").toBe("shutdown");
      expect(shutBus.getSnapshot().terminalTimestamp, "shutdown timestamp").toBe("2026-04-24T00:00:02.000Z");
      expect(shutBus.getTerminalState().finalContent, "shutdown finalContent").toBe("Partial answer");
      expect(shutBus.getSnapshot().intentText, "shutdown clears intent").toBe("");
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

      // The client's read of that turn may still be in flight when the next one starts, so the
      // visual stays for one more turn; the client hides it by artifact id once disk carries it.
      bus.emit({ type: "thinking", turnId: "turn-2" });
      expect(bus.getSnapshot().liveVisuals).toMatchObject([{ artifactId: "artifact-1" }]);

      bus.emit({ type: "thinking", turnId: "turn-3" });
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
          event: { type: "error", message: "boom", sourceEventId: "saved-error", timestamp: "2026-07-23T16:00:00.000Z" },
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
        if (event.type === "error") {
          expect(bus.getSnapshot().runNotice?.retryRunId).toBe(bus.getSnapshot().runId);
        }
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

    it("keeps the ending turn's disk-backed segments for one more turn and native ones always", () => {
      const bus = getOrCreateBus("test-segment-turn-boundary");
      bus.emit({ type: "thinking", turnId: "turn-1" });
      bus.emit({ type: "assistant_partial", content: "persisted", sourceEventId: "assistant-1" });
      bus.emit({ type: "assistant_partial", content: "local only", bridgeNative: true });
      expect(bus.getSnapshot().liveAssistantSegments).toHaveLength(2);

      // The client's read of turn 1 is usually still in flight when turn 2 starts.
      bus.emit({ type: "thinking", turnId: "turn-2" });
      expect(bus.getSnapshot().liveAssistantSegments).toMatchObject([
        { content: "persisted" },
        { content: "local only" },
      ]);

      bus.emit({ type: "thinking", turnId: "turn-3" });
      expect(bus.getSnapshot().liveAssistantSegments).toMatchObject([{ content: "local only" }]);
    });

    it("keeps a finished tool across the next turn start so it cannot fall back to running", () => {
      const bus = getOrCreateBus("test-tool-turn-boundary");
      bus.emit({ type: "thinking", turnId: "turn-1" });
      bus.emit({ type: "tool_start", toolCallId: "tc-done", name: "view" });
      bus.emit({ type: "tool_start", toolCallId: "tc-open", name: "bash" });
      bus.emit({ type: "tool_done", toolCallId: "tc-done", success: true, result: "ok" });

      bus.emit({ type: "thinking", turnId: "turn-2" });
      // A reconnecting client must receive the completion its disk read may not show yet.
      expect(bus.getSnapshot().liveTools).toMatchObject([{ toolCallId: "tc-done", success: true, result: "ok" }]);

      bus.emit({ type: "thinking", turnId: "turn-3" });
      expect(bus.getSnapshot().liveTools).toEqual([]);
    });
  });

  describe("model thinking", () => {
    it("accumulates streamed thinking so a reconnecting client receives it in the snapshot", () => {
      const bus = getOrCreateBus("test-reasoning-stream");
      bus.emit({ type: "thinking", turnId: "turn-1", turnInstanceId: "turn-start-1" });
      bus.emit({ type: "reasoning_delta", reasoningId: "r-1", content: "The scanner " });
      bus.emit({ type: "reasoning_delta", reasoningId: "r-1", content: "must agree." });

      expect(bus.getSnapshot().liveReasoning).toMatchObject([{
        id: "r-1",
        content: "The scanner must agree.",
        turnId: "turn-1",
        turnInstanceId: "turn-start-1",
      }]);
      expect(bus.getSnapshot().liveReasoning[0]?.completedAt).toBeUndefined();
    });

    it("stamps thinking events with the current turn for subscribers", () => {
      const bus = getOrCreateBus("test-reasoning-turn-scope");
      const received: StreamEvent[] = [];
      bus.subscribe((event) => received.push(event));

      bus.emit({ type: "thinking", turnId: "turn-1", turnInstanceId: "turn-start-1" });
      bus.emit({ type: "reasoning_delta", reasoningId: "r-1", content: "hm" });

      expect(received.find((event) => event.type === "reasoning_delta")).toMatchObject({
        turnId: "turn-1",
        turnInstanceId: "turn-start-1",
      });
    });

    it("closes thinking when visible text or a tool call starts", () => {
      const textBus = getOrCreateBus("test-reasoning-closed-by-text");
      textBus.emit({ type: "reasoning_delta", reasoningId: "r-1", content: "thought" });
      textBus.emit({ type: "delta", content: "Answer" });
      expect(textBus.getSnapshot().liveReasoning[0]?.completedAt).toBeDefined();

      const toolBus = getOrCreateBus("test-reasoning-closed-by-tool");
      toolBus.emit({ type: "reasoning_delta", reasoningId: "r-1", content: "thought" });
      toolBus.emit({ type: "tool_start", toolCallId: "tc-1", name: "grep", timestamp: "2026-09-20T08:00:03.000Z" });
      expect(toolBus.getSnapshot().liveReasoning[0]?.completedAt).toBe("2026-09-20T08:00:03.000Z");
    });

    it("commits thinking under the assistant message that persisted it and announces the advance", () => {
      const bus = getOrCreateBus("test-reasoning-commit");
      const received: StreamEvent[] = [];
      bus.subscribe((event) => received.push(event));
      bus.emit({ type: "reasoning_delta", reasoningId: "r-1", content: "streamed" });

      bus.emit({
        type: "reasoning_committed",
        content: "persisted",
        sourceEventId: "assistant-message-1",
        timestamp: "2026-09-20T08:00:05.000Z",
      });

      expect(bus.getSnapshot().liveReasoning).toMatchObject([{
        id: "r-1",
        content: "persisted",
        sourceEventId: "assistant-message-1",
        committedAt: "2026-09-20T08:00:05.000Z",
      }]);
      expect(received.filter((event) => event.type === "history_advanced")).toHaveLength(1);
    });

    it("folds the complete block the SDK sends after its commit without resending it", () => {
      const bus = getOrCreateBus("test-reasoning-late-complete");
      const received: StreamEvent[] = [];
      bus.subscribe((event) => received.push(event));
      bus.emit({ type: "reasoning_delta", reasoningId: "r-1", content: "the thought" });
      bus.emit({ type: "reasoning_committed", content: "the thought", sourceEventId: "assistant-message-1" });
      bus.emit({ type: "reasoning", reasoningId: "r-1", content: "the thought" });

      expect(bus.getSnapshot().liveReasoning).toHaveLength(1);
      // Subscribers already hold this text; the whole block is not sent a third time.
      expect(received.some((event) => event.type === "reasoning")).toBe(false);
    });

    it("broadcasts the complete block when it is the only copy of the thinking", () => {
      const bus = getOrCreateBus("test-reasoning-complete-only");
      const received: StreamEvent[] = [];
      bus.subscribe((event) => received.push(event));

      bus.emit({ type: "reasoning", reasoningId: "r-1", content: "a model that does not stream its thinking" });

      expect(received.filter((event) => event.type === "reasoning")).toHaveLength(1);
      expect(bus.getSnapshot().liveReasoning).toMatchObject([{ id: "r-1" }]);
      expect(bus.getSnapshot().liveReasoning[0]?.completedAt).toBeDefined();
    });

    it("keeps committed thinking for one more turn, then lets it go", () => {
      const bus = getOrCreateBus("test-reasoning-turn-boundary");
      bus.emit({ type: "thinking", turnId: "turn-1" });
      bus.emit({ type: "reasoning_delta", reasoningId: "r-1", content: "first turn" });
      bus.emit({ type: "reasoning_committed", content: "first turn", sourceEventId: "assistant-message-1" });

      bus.emit({ type: "thinking", turnId: "turn-2" });
      bus.emit({ type: "reasoning_delta", reasoningId: "r-2", content: "cut short, never committed" });
      expect(bus.getSnapshot().liveReasoning.map((block) => block.id)).toEqual(["r-1", "r-2"]);

      bus.emit({ type: "thinking", turnId: "turn-3" });
      expect(bus.getSnapshot().liveReasoning).toEqual([]);
    });

    it("keeps committed thinking at the end of a run and drops thinking that was cut short", () => {
      const bus = getOrCreateBus("test-reasoning-terminal");
      bus.emit({ type: "reasoning_delta", reasoningId: "r-1", content: "kept" });
      bus.emit({ type: "reasoning_committed", content: "kept", sourceEventId: "assistant-message-1" });
      bus.emit({ type: "reasoning_delta", reasoningId: "r-2", content: "cut short by the stop button" });

      bus.emit({ type: "aborted", content: "" });

      expect(bus.getSnapshot().liveReasoning.map((block) => block.id)).toEqual(["r-1"]);
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

    it("stops delivering to a listener once it unsubscribes", () => {
      const bus = getOrCreateBus("test-unsub-1");
      const events: StreamEvent[] = [];
      const unsub = bus.subscribe((e) => events.push(e));

      unsub();
      bus.emit({ type: "delta", content: "missed" });

      // Only the initial snapshot delivered at subscribe time.
      expect(events).toHaveLength(1);
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

describe("event-bus sub-agents", () => {
  const liveToolIds = (bus: ReturnType<typeof getOrCreateBus>) => bus.getSnapshot().liveTools.map((tool) => tool.toolCallId);

  it("puts an agent's calls in the agent's turn, not the main agent's", () => {
    const bus = getOrCreateBus("test-agent-turn-stamp");
    const events: StreamEvent[] = [];
    bus.subscribe((event) => {
      if (event.type !== "snapshot" && event.type !== "history_advanced") events.push(event);
    });

    bus.emit({ type: "thinking", turnId: "0", turnInstanceId: "main-1" });
    bus.emit({ type: "tool_start", toolCallId: "task-bg", name: "task" });
    bus.emit({ type: "tool_done", toolCallId: "task-bg", success: true });
    // Before the agent's first turn is known, its call has no turn rather than someone else's.
    bus.emit({ type: "tool_start", toolCallId: "bg-early", name: "view", parentToolCallId: "task-bg" });
    bus.emit({ type: "agent_turn", agentToolCallId: "task-bg", turnInstanceId: "agent-1" });
    bus.emit({ type: "tool_start", toolCallId: "bg-view", name: "view", parentToolCallId: "task-bg" });
    // The event that ends a call does not name its parent; the bus remembers whose it is.
    bus.emit({ type: "tool_done", toolCallId: "bg-view", success: true });

    expect(events).toMatchObject([
      { type: "thinking", turnInstanceId: "main-1" },
      { type: "tool_start", toolCallId: "task-bg", turnId: "0", turnInstanceId: "main-1" },
      { type: "tool_done", toolCallId: "task-bg", turnInstanceId: "main-1" },
      { type: "tool_start", toolCallId: "bg-early" },
      { type: "agent_turn", agentToolCallId: "task-bg", turnInstanceId: "agent-1" },
      { type: "tool_start", toolCallId: "bg-view", turnInstanceId: "agent-1" },
      { type: "tool_done", toolCallId: "bg-view", turnInstanceId: "agent-1" },
    ]);
    expect(events[3]).not.toHaveProperty("turnId");
    expect(events[3]).not.toHaveProperty("turnInstanceId");
    expect(events[5]).not.toHaveProperty("turnId");
    expect(bus.getSnapshot().agentTurns).toEqual([["task-bg", "agent-1"]]);
  });

  it("keeps an agent's calls through the main agent's turns and lets them go at the agent's own", () => {
    const bus = getOrCreateBus("test-agent-turn-retention");
    bus.emit({ type: "thinking", turnId: "0", turnInstanceId: "main-1" });
    bus.emit({ type: "tool_start", toolCallId: "task-bg", name: "task" });
    bus.emit({ type: "tool_done", toolCallId: "task-bg", success: true });
    bus.emit({ type: "agent_turn", agentToolCallId: "task-bg", turnInstanceId: "agent-1" });
    bus.emit({ type: "tool_start", toolCallId: "bg-done", name: "view", parentToolCallId: "task-bg" });
    bus.emit({ type: "tool_done", toolCallId: "bg-done", success: true });
    bus.emit({ type: "tool_start", toolCallId: "bg-open", name: "bash", parentToolCallId: "task-bg" });

    // The main agent moves on twice. Its own finished call lasts one turn; the agent's are untouched.
    bus.emit({ type: "thinking", turnId: "1", turnInstanceId: "main-2" });
    expect(liveToolIds(bus)).toEqual(["task-bg", "bg-done", "bg-open"]);
    bus.emit({ type: "thinking", turnId: "2", turnInstanceId: "main-3" });
    expect(liveToolIds(bus)).toEqual(["bg-done", "bg-open"]);

    // The agent's next turn: its finished call stays for that one turn, as the main agent's did.
    bus.emit({ type: "agent_turn", agentToolCallId: "task-bg", turnInstanceId: "agent-2" });
    expect(liveToolIds(bus)).toEqual(["bg-done", "bg-open"]);
    bus.emit({ type: "agent_turn", agentToolCallId: "task-bg", turnInstanceId: "agent-3" });
    // A call still in flight is never let go.
    expect(liveToolIds(bus)).toEqual(["bg-open"]);
    expect(bus.getSnapshot().agentTurns).toEqual([["task-bg", "agent-3"]]);

    bus.reset();
    expect(bus.getSnapshot().agentTurns).toEqual([]);
  });

  it("leaves one agent's calls alone when another agent starts a turn", () => {
    const bus = getOrCreateBus("test-agent-turn-neighbours");
    bus.emit({ type: "agent_turn", agentToolCallId: "task-a", turnInstanceId: "a-1" });
    bus.emit({ type: "agent_turn", agentToolCallId: "task-b", turnInstanceId: "b-1" });
    bus.emit({ type: "tool_start", toolCallId: "a-view", name: "view", parentToolCallId: "task-a" });
    bus.emit({ type: "tool_done", toolCallId: "a-view", success: true });
    bus.emit({ type: "tool_start", toolCallId: "b-view", name: "view", parentToolCallId: "task-b" });
    bus.emit({ type: "tool_done", toolCallId: "b-view", success: true });

    bus.emit({ type: "agent_turn", agentToolCallId: "task-a", turnInstanceId: "a-2" });
    bus.emit({ type: "agent_turn", agentToolCallId: "task-a", turnInstanceId: "a-3" });

    expect(liveToolIds(bus)).toEqual(["b-view"]);
  });

  it("says when the main agent has stopped to wait, until it starts a turn again", () => {
    const bus = getOrCreateBus("test-main-idle");
    const events: StreamEvent[] = [];
    bus.subscribe((event) => {
      if (event.type !== "snapshot") events.push(event);
    });
    bus.emit({ type: "thinking", turnId: "0", turnInstanceId: "main-1" });
    expect(bus.getSnapshot().mainAgentIdle).toBe(false);

    bus.emit({ type: "main_idle" });
    bus.emit({ type: "main_idle" });
    expect(bus.getSnapshot().mainAgentIdle).toBe(true);
    // Said once, and it is not something disk history records.
    expect(events.filter((event) => event.type === "main_idle")).toEqual([{ type: "main_idle" }]);
    expect(events.some((event) => event.type === "history_advanced")).toBe(false);

    bus.emit({ type: "thinking", turnId: "1", turnInstanceId: "main-2" });
    expect(bus.getSnapshot().mainAgentIdle).toBe(false);

    bus.emit({ type: "main_idle" });
    bus.emit({ type: "done", content: "Done" });
    // A finished run is not waiting on anything.
    expect(bus.getSnapshot().mainAgentIdle).toBe(false);
  });

  it("tells the browser to read history when an agent starts or stops, and once more shortly after", () => {
    vi.useFakeTimers();
    try {
      const bus = getOrCreateBus("test-agent-change");
      const received: StreamEvent[] = [];
      const advances = () => received.filter((event) => event.type === "history_advanced").length;
      bus.subscribe((event) => received.push(event));

      bus.announceAgentChange();
      expect(advances()).toBe(1);
      // A second change inside the wait shares the one follow-up read.
      bus.announceAgentChange();
      expect(advances()).toBe(2);
      vi.advanceTimersByTime(1_000);
      expect(advances()).toBe(3);
      vi.advanceTimersByTime(5_000);
      expect(advances()).toBe(3);

      // A run that ends takes the follow-up with it: its ending is announced on its own.
      bus.announceAgentChange();
      bus.emit({ type: "done", content: "Done" });
      const afterDone = advances();
      vi.advanceTimersByTime(5_000);
      expect(advances()).toBe(afterDone);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("event-bus run mode", () => {
  it("puts the run mode in the snapshot, announces changes once, and forgets it on reset", () => {
    const bus = getOrCreateBus("test-run-mode-1");
    bus.reset();
    const events: StreamEvent[] = [];
    const unsubscribe = bus.subscribe((event) => events.push(event));

    bus.setRunMode("autopilot");
    bus.setRunMode("autopilot");
    expect(events.filter((event) => event.type === "run_mode")).toEqual([{ type: "run_mode", runMode: "autopilot" }]);
    expect(bus.getSnapshot().runMode).toBe("autopilot");

    bus.reset();
    expect(bus.getSnapshot()).not.toHaveProperty("runMode");
    unsubscribe();
  });
});
