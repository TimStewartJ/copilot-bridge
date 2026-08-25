import { describe, it, expect } from "vitest";
import { createGlobalBus, type StatusEvent } from "../global-bus.js";

describe("global-bus", () => {
  it("listener errors do not break other listeners", () => {
    const globalBus = createGlobalBus();
    const events: StatusEvent[] = [];

    const unsub1 = globalBus.subscribe(() => { throw new Error("boom"); });
    const unsub2 = globalBus.subscribe((e) => events.push(e));

    globalBus.emit({ type: "session:title", sessionId: "s1", title: "Test" });
    expect(events).toHaveLength(1);
    expect(events[0].title).toBe("Test");

    unsub1();
    unsub2();
  });

  it("supports stalled session transitions", () => {
    const globalBus = createGlobalBus();
    const events: StatusEvent[] = [];
    const unsub = globalBus.subscribe((e) => events.push(e));

    globalBus.emit({ type: "session:stalled", sessionId: "s1" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "session:stalled", sessionId: "s1" });

    unsub();
  });

});
