import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "../db.js";
import { createGlobalBus } from "../global-bus.js";
import { initPushEventNotifications, type PushEventNotificationDisposer, type PushSendSummary } from "../push-notification-service.js";
import { createTaskStore } from "../task-store.js";
import { setupTestDb } from "./helpers.js";
vi.mock("../public-url.js", () => ({ buildPublicUrl: (path: string) => path }));
const SENT: PushSendSummary = { attempted: 1, sent: 1, failed: 0, pruned: 0 };
describe("native needs-input delivery retries and episode fencing", () => {
  let db: DatabaseSync, stop: PushEventNotificationDisposer;
  let ctx: Parameters<typeof initPushEventNotifications>[0];
  let send: ReturnType<typeof vi.fn<() => Promise<PushSendSummary>>>;
  let complete: (() => void) | undefined;
  beforeEach(() => {
    db = setupTestDb();
    const globalBus = createGlobalBus();
    ctx = { globalBus, taskStore: createTaskStore(db, globalBus), apiBasePath: "/api" };
    send = vi.fn(async () => SENT);
    stop = initPushEventNotifications(ctx, { sendToAll: send, sendToEndpoint: send });
  });
  afterEach(async () => { complete?.(); complete = undefined; await stop(); db.close(); vi.restoreAllMocks(); });
  function emit(count: number) { ctx.globalBus.emit({ type: "session:user-input", sessionId: "waiting", needsUserInput: count > 0, pendingUserInputCount: count }); }
  it.each(["throw", "empty", "partial"] as const)("retries %s failure but does not duplicate success", async failure => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    if (failure === "throw") send.mockRejectedValueOnce(new Error("Offline"));
    else send.mockResolvedValueOnce(failure === "empty" ? { attempted: 0, sent: 0, failed: 0, pruned: 0 } : { attempted: 2, sent: 1, failed: 1, pruned: 0 });
    emit(1); emit(2); await stop.flush();
    expect(send).toHaveBeenCalledTimes(1); expect(warning).toHaveBeenCalled();
    emit(3); await stop.flush();
    expect(send).toHaveBeenCalledTimes(2);
    emit(4); await stop.flush(); expect(send).toHaveBeenCalledTimes(2);
  });
  it("coalesces concurrent events and never lets an old delivery suppress a newer episode", async () => {
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    send.mockImplementationOnce(() => { entered(); return new Promise(resolve => { complete = () => resolve(SENT); }); });
    emit(1); await started; emit(2);
    expect(send).toHaveBeenCalledTimes(1);
    emit(0); complete!(); await stop.flush();
    emit(1); await stop.flush();
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("respects task muting without a Decision or Focus store", async () => {
    const task = ctx.taskStore.createTask("Muted");
    ctx.taskStore.linkSession(task.id, "waiting");
    ctx.taskStore.updateTask(task.id, { muted: true });
    emit(1); await stop.flush(); expect(send).not.toHaveBeenCalled();
    ctx.taskStore.updateTask(task.id, { muted: false });
    emit(1); await stop.flush(); expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]).toEqual([expect.objectContaining({ url: expect.stringContaining(`/tasks/${task.id}/sessions/waiting`) })]);
  });
  it("waits for admitted sends during shutdown and admits no new notifications", async () => {
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    send.mockImplementationOnce(() => { entered(); return new Promise(resolve => { complete = () => resolve(SENT); }); });
    emit(1); await started;
    let settled = false; const closing = stop().then(() => { settled = true; });
    await Promise.resolve(); expect(settled).toBe(false);
    complete!(); await closing; emit(0); emit(1);
    expect(send).toHaveBeenCalledOnce();
  });
});
