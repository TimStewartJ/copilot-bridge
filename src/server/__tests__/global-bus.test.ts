import { describe, it, expect } from "vitest";
import * as globalBus from "../global-bus.js";

describe("global-bus", () => {
  it("delivers events to subscribers", () => {
    const events: globalBus.StatusEvent[] = [];
    const unsub = globalBus.subscribe((e) => events.push(e));

    globalBus.emit({ type: "session:busy", sessionId: "s1" });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("session:busy");

    unsub();
  });

  it("unsubscribe stops delivery", () => {
    const events: globalBus.StatusEvent[] = [];
    const unsub = globalBus.subscribe((e) => events.push(e));
    unsub();

    globalBus.emit({ type: "session:idle", sessionId: "s1" });
    expect(events).toHaveLength(0);
  });

  it("listener errors do not break other listeners", () => {
    const events: globalBus.StatusEvent[] = [];

    const unsub1 = globalBus.subscribe(() => { throw new Error("boom"); });
    const unsub2 = globalBus.subscribe((e) => events.push(e));

    globalBus.emit({ type: "session:title", sessionId: "s1", title: "Test" });
    expect(events).toHaveLength(1);
    expect(events[0].title).toBe("Test");

    unsub1();
    unsub2();
  });

  it("multiple subscribers all receive events", () => {
    const events1: globalBus.StatusEvent[] = [];
    const events2: globalBus.StatusEvent[] = [];

    const unsub1 = globalBus.subscribe((e) => events1.push(e));
    const unsub2 = globalBus.subscribe((e) => events2.push(e));

    globalBus.emit({ type: "server:restart-pending", waitingSessions: 2 });
    expect(events1).toHaveLength(1);
    expect(events2).toHaveLength(1);

    unsub1();
    unsub2();
  });
});
