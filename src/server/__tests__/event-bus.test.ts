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

    it("can clear pendingPrompt after the user message is persisted", () => {
      const bus = getOrCreateBus("test-pending-prompt-1");
      bus.setPendingPrompt("recover me");

      expect(bus.getSnapshot().pendingPrompt).toBe("recover me");

      bus.clearPendingPrompt();

      expect(bus.getSnapshot().pendingPrompt).toBeUndefined();
    });

    it("tracks tool lifecycle", () => {
      const bus = getOrCreateBus("test-tool-1");
      bus.emit({ type: "tool_start", toolCallId: "tc1", name: "grep" });
      bus.emit({ type: "tool_start", toolCallId: "tc2", name: "view" });
      expect(bus.getSnapshot().activeTools).toHaveLength(2);

      bus.emit({ type: "tool_done", toolCallId: "tc1" });
      expect(bus.getSnapshot().activeTools).toHaveLength(1);
      expect(bus.getSnapshot().activeTools[0].name).toBe("view");
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
      bus.emit({ type: "done", content: "Final answer" });

      const snap = bus.getSnapshot();
      expect(snap.complete).toBe(true);
      expect(snap.finalContent).toBe("Final answer");
      expect(snap.accumulatedContent).toBe("");
      expect(snap.activeTools).toEqual([]);
      expect(bus.complete).toBe(true);
    });

    it("error marks complete with error message", () => {
      const bus = getOrCreateBus("test-error-1");
      bus.emit({ type: "error", message: "Something broke" });

      const snap = bus.getSnapshot();
      expect(snap.complete).toBe(true);
      expect(snap.errorMessage).toBe("Something broke");
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
      bus.setPendingPrompt("prompt");

      bus.reset();
      const snap = bus.getSnapshot();
      expect(snap.accumulatedContent).toBe("");
      expect(snap.intentText).toBe("");
      expect(snap.activeTools).toEqual([]);
      expect(snap.complete).toBe(false);
      expect(snap.finalContent).toBeUndefined();
      expect(snap.errorMessage).toBeUndefined();
      expect(snap.pendingPrompt).toBeUndefined();
    });
  });
});
