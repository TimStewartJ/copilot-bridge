import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type DatabaseSync } from "../db.js";
import { createFocusSessionLaunchStore, publicFocusSessionLaunch } from "../focus-session-launch-store.js";
import { focusFingerprint } from "../focus-details-store.js";
import { createTaskStore } from "../task-store.js";
import { createTestBus, makeTestDir } from "./helpers.js";

const connections: DatabaseSync[] = [];
afterEach(() => { for (const db of connections.splice(0)) db.close(); });
function connection(directory: string) {
  const db = openDatabase(directory);
  connections.push(db);
  return db;
}
function input(taskId: string | null = null) {
  const prompt = "Review the concern";
  return {
    objectId: "focus-object", activationId: "episode", source: "launch_prompt" as const,
    objectType: "decision" as const, objectTitle: "Concern", taskId, taskTitle: taskId ? "Original task" : null,
    prompt, promptFingerprint: focusFingerprint({ prompt, taskId, creationOptions: {} }), creationOptions: {},
  };
}

describe("durable Focus launch store", () => {
  it("keeps one receipt and expected session ID across independent connections and reopening", () => {
    const directory = makeTestDir("focus-launch-receipts");
    const first = createFocusSessionLaunchStore(connection(directory));
    const second = createFocusSessionLaunchStore(connection(directory));
    const prepared = first.prepare(input());
    expect(prepared.created).toBe(true);
    expect(second.prepare(input())).toEqual({ created: false, receipt: prepared.receipt });
    expect(createFocusSessionLaunchStore(connection(directory)).find(input())).toEqual(prepared.receipt);
    const discussion = second.prepare({ ...input(), source: "discussion" });
    expect(discussion.receipt.expectedSessionId).not.toBe(prepared.receipt.expectedSessionId);
    expect(() => first.prepare({ ...input(), promptFingerprint: "changed" })).toThrow("different prompt");
  });

  it("arbitrates one creator and fences stale owners across connections", () => {
    const directory = makeTestDir("focus-launch-owner");
    const first = createFocusSessionLaunchStore(connection(directory));
    const second = createFocusSessionLaunchStore(connection(directory));
    const prepared = first.prepare(input()).receipt;
    const stale = second.requireReceipt(prepared.id);
    const owner = first.claim(prepared, { pid: 100, startMarker: "first" })!;
    expect(second.claim(stale, { pid: 101, startMarker: "second" })).toBeUndefined();
    first.markDispatched(owner.id, owner.ownerToken!);
    const unknown = first.fail(owner.id, owner.ownerToken!, "unknown", "creation", "Response lost");
    const recovery = second.claim(unknown, { pid: 101, startMarker: "second" })!;
    expect(() => first.markCreated(owner.id, owner.ownerToken!, owner.expectedSessionId)).toThrow("claim changed");
    expect(() => second.markDispatched(owner.id, recovery.ownerToken!)).toThrow("already dispatched");
    second.markCreated(owner.id, recovery.ownerToken!, owner.expectedSessionId);
    second.markLinked(owner.id, recovery.ownerToken!);
    second.claimPrompt(owner.id, recovery.ownerToken!);
    const ready = second.complete(owner.id, recovery.ownerToken!);
    expect(first.requireReceipt(owner.id).status).toBe("ready");
    expect(first.claim(ready, { pid: 100, startMarker: "first" })).toBeUndefined();
    const published = publicFocusSessionLaunch(owner);
    expect(published).not.toHaveProperty("ownerToken");
    expect(published).not.toHaveProperty("ownerStartMarker");
  });

  it("retains the receipt and task provenance after task deletion", () => {
    const directory = makeTestDir("focus-launch-orphan");
    const db = connection(directory);
    const tasks = createTaskStore(db, createTestBus());
    const task = tasks.createTask("Original task");
    const store = createFocusSessionLaunchStore(db);
    const receipt = store.prepare(input(task.id)).receipt;
    tasks.deleteTask(task.id);
    expect(store.requireReceipt(receipt.id)).toMatchObject({ taskId: task.id, taskTitle: "Original task", status: "prepared" });
  });
});
