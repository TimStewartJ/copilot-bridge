import { describe, expect, it } from "vitest";
import { setupTestDb } from "./helpers.js";
import { createUnsentMessageStore } from "../unsent-message-store.js";

describe("unsent message store", () => {
  it("shows a message only once its delivery failed, and drops it once the runtime has it", () => {
    const store = createUnsentMessageStore(setupTestDb());
    store.recordPending({ sessionId: "s1", id: "m1", content: "first", at: new Date("2026-11-01T10:00:00Z") });
    store.recordPending({ sessionId: "s1", id: "m2", content: "second", mode: "autopilot" });
    expect(store.list("s1")).toEqual([]);

    store.markUndelivered("s1", "m1", "stopped");
    store.markUndelivered("s1", "m2", "failed", "Model unavailable");
    expect(store.list("s1")).toEqual([
      { id: "m1", content: "first", state: "stopped", createdAt: "2026-11-01T10:00:00.000Z" },
      expect.objectContaining({ id: "m2", state: "failed", error: "Model unavailable", mode: "autopilot" }),
    ]);

    store.retire("s1", "m2");
    expect(store.list("s1").map((message) => message.id)).toEqual(["m1"]);
    // Still known, so a repeat of the same browser message is not run again.
    expect(store.has("s1", "m2")).toBe(true);

    // Once handed to the runtime, a stop no longer decides: the runtime's answer does.
    store.recordPending({ sessionId: "s1", id: "m3", content: "third" });
    store.markSending("s1", "m3");
    expect(store.markUndelivered("s1", "m3", "stopped")).toBe(false);
    expect(store.list("s1").map((message) => message.id)).toEqual(["m1"]);
  });

  it("lets one resend win, puts a failed resend back, and keeps dismissed ids", () => {
    const store = createUnsentMessageStore(setupTestDb());
    store.recordPending({ sessionId: "s1", id: "m1", content: "hello" });
    store.markUndelivered("s1", "m1", "stopped");

    const claimed = store.claimResend("s1", "m1");
    expect(claimed).toMatchObject({ id: "m1", content: "hello", state: "stopped" });
    expect(store.claimResend("s1", "m1")).toBeUndefined();
    expect(store.list("s1")).toEqual([]);

    store.finishResend("s1", claimed!, false);
    expect(store.list("s1")).toEqual([expect.objectContaining({ id: "m1", state: "stopped" })]);

    store.finishResend("s1", store.claimResend("s1", "m1")!, true);
    expect(store.list("s1")).toEqual([]);
    expect(store.discard("s1", "m1")).toBe(false);
    // Still known, so a late repeat of the same browser message is not sent again.
    expect(store.has("s1", "m1")).toBe(true);
  });

  it("after a restart, shows what was never handed to the runtime as interrupted, and only that", () => {
    const store = createUnsentMessageStore(setupTestDb());
    store.recordPending({ sessionId: "s1", id: "waiting", content: "hello" });
    store.recordPending({ sessionId: "s1", id: "handed-over", content: "hi" });
    store.markSending("s1", "handed-over");

    expect(store.recoverAfterRestart()).toBe(1);
    expect(store.list("s1")).toEqual([expect.objectContaining({ id: "waiting", state: "interrupted" })]);
  });
});
