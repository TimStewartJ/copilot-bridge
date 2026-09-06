import { describe, expect, it, vi } from "vitest";
import type { ApiRouteTestState } from "../../test-support/api-routes.js";
import { installApiRouteTestHooks, request } from "../../test-support/api-routes.js";
import { decisionDetails } from "./focus-test-fixtures.js";
import { createFocusSessionLaunchService } from "../focus-session-launch-service.js";
import type { FocusLaunchSource } from "../focus-session-launch-store.js";

let app: ApiRouteTestState["app"];
let ctx: ApiRouteTestState["ctx"];
installApiRouteTestHooks((state) => { ({ app, ctx } = state); });

function source(taskId?: string) {
  return ctx.focusMutationCoordinator.saveDecision({
    ...decisionDetails, title: "Discuss the rollout", taskId,
    action: { prompt: "Review the rollout alternatives and recommend the next step." },
  }).decision;
}
function launchIdentity(object: ReturnType<typeof source>, launchSource: FocusLaunchSource = "launch_prompt") {
  return { objectId: object.id, activationId: object.activationId, source: launchSource };
}
function reconstruct(status: "alive" | "exited" | "replaced" | "unknown" = "exited") {
  ctx.focusSessionLaunchService = createFocusSessionLaunchService(ctx, ctx.focusSessionLaunchStore, {
    getOwner: async () => ({ pid: process.pid, startMarker: "new-test-owner" }),
    getOwnerStatus: async () => status,
  });
}
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
async function prepare(object: ReturnType<typeof source>) {
  const response = await request(app).post("/api/focus/session-launches/prepare").send(launchIdentity(object));
  expect(response.status).toBe(201);
  return ctx.focusSessionLaunchStore.requireReceipt(response.body.receipt.id);
}

describe("durable Focus session launches", () => {
  it("persists preparation and survives client/query-cache loss and service reconstruction", async () => {
    const object = source();
    const create = vi.spyOn(ctx.sessionManager, "createSession");
    const send = vi.spyOn(ctx.sessionManager, "startWorkAndWaitForDelivery");
    const prepared = await prepare(object);
    expect(prepared.status).toBe("prepared");
    expect(prepared.expectedSessionId).toBe(prepared.id);
    expect(create).not.toHaveBeenCalled();

    const started = await request(app).post(`/api/focus/session-launches/${prepared.id}/start`).send({});
    expect(started.status).toBe(200);
    expect(started.body.receipt).toMatchObject({
      status: "ready", sessionId: prepared.expectedSessionId, promptStatus: "sent", linkedAt: expect.any(String),
    });
    expect(started.body.receipt).not.toHaveProperty("ownerToken");
    expect(create.mock.calls[0]?.[0]).toMatchObject({ expectedSessionId: prepared.expectedSessionId });
    expect(send).toHaveBeenCalledWith(prepared.expectedSessionId, prepared.prompt, undefined, {
      clientMessageId: `focus-launch:${prepared.id}`,
    });
    expect(ctx.decisionStore.get(object.id)).toMatchObject({ sessionId: prepared.expectedSessionId, lifecycle: "acknowledged", status: "active" });

    reconstruct();
    const queried = await request(app).get("/api/focus/session-launches").query(launchIdentity(object));
    const repeated = await request(app).post("/api/focus/session-launches").send(launchIdentity(object));
    expect(queried.body.receipt).toEqual(started.body.receipt);
    expect(repeated.body.receipt).toEqual(started.body.receipt);
    expect(create).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent clients and records the expected ID before external creation", async () => {
    const object = source();
    const entered = gate();
    const release = gate();
    const prepareSpy = vi.spyOn(ctx.focusSessionLaunchService!, "prepare");
    const create = vi.spyOn(ctx.sessionManager, "createSession").mockImplementation(async (options) => {
      const receipt = ctx.focusSessionLaunchStore.find(launchIdentity(object))!;
      expect(receipt.status).toBe("creating");
      expect(receipt.expectedSessionId).toBe(options?.expectedSessionId);
      expect(receipt.creationDispatchedAt).toBeNull();
      options?.onCreateStarting?.();
      expect(ctx.focusSessionLaunchStore.requireReceipt(receipt.id).creationDispatchedAt).not.toBeNull();
      entered.resolve();
      await release.promise;
      return { sessionId: receipt.expectedSessionId };
    });
    const first = request(app).post("/api/focus/session-launches").send(launchIdentity(object)).then((response) => response);
    try {
      await entered.promise;
      const second = request(app).post("/api/focus/session-launches").send(launchIdentity(object)).then((response) => response);
      await vi.waitFor(() => expect(prepareSpy).toHaveBeenCalledTimes(2));
      expect(create).toHaveBeenCalledTimes(1);
      release.resolve();
      const responses = await Promise.all([first, second]);
      expect(responses.map((response) => response.body.sessionId)).toEqual([
        responses[0]!.body.sessionId, responses[0]!.body.sessionId,
      ]);
      expect(responses.every((response) => response.body.receipt.status === "ready")).toBe(true);
    } finally { release.resolve(); }
  });

  it.each(["focus", "task"] as const)("recovers failed %s linking without another session or prompt", async (link) => {
    const task = ctx.taskStore.createTask("Rollout task");
    const object = source(task.id);
    const create = vi.spyOn(ctx.sessionManager, "createTaskSession");
    const send = vi.spyOn(ctx.sessionManager, "startWorkAndWaitForDelivery");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    if (link === "focus") vi.spyOn(ctx.focusMutationCoordinator, "linkLaunchedSession").mockImplementationOnce(() => { throw new Error("Focus link unavailable"); });
    else vi.spyOn(ctx.taskStore, "linkSession").mockImplementationOnce(() => { throw new Error("Task link unavailable"); });

    const failed = await request(app).post("/api/focus/session-launches").send(launchIdentity(object));
    expect(failed.status).toBe(502);
    expect(failed.body.receipt).toMatchObject({ status: "failed", errorStage: "link", sessionId: expect.any(String), promptStatus: "pending" });
    expect(ctx.decisionStore.get(object.id)?.lifecycle).toBe("active");
    expect(send).not.toHaveBeenCalled();

    reconstruct();
    const recovered = await request(app).post(`/api/focus/session-launches/${failed.body.receipt.id}/start`).send({});
    expect(recovered.status).toBe(200);
    expect(recovered.body.receipt).toMatchObject({ status: "ready", sessionId: failed.body.sessionId });
    expect(create).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(ctx.taskStore.getTask(task.id)?.sessionIds).toContain(failed.body.sessionId);
    expect(ctx.decisionStore.get(object.id)?.lifecycle).toBe("acknowledged");
  });

  it("reconciles an existing expected session after the creator process disappears", async () => {
    const object = source();
    const receipt = await prepare(object);
    const claimed = ctx.focusSessionLaunchStore.claim(receipt, { pid: 12345, startMarker: "old-process" })!;
    ctx.focusSessionLaunchStore.markDispatched(receipt.id, claimed.ownerToken!);
    reconstruct();
    const probe = vi.spyOn(ctx.sessionManager, "getSessionCreationState").mockResolvedValue("present");
    const create = vi.spyOn(ctx.sessionManager, "createSession");
    const warm = vi.spyOn(ctx.sessionManager, "warmSession");
    const recovered = await request(app).post(`/api/focus/session-launches/${receipt.id}/start`).send({});
    expect(recovered.status).toBe(200);
    expect(recovered.body.receipt).toMatchObject({ sessionId: receipt.expectedSessionId, status: "ready" });
    expect(probe).toHaveBeenCalledWith(receipt.expectedSessionId);
    expect(create).not.toHaveBeenCalled();
    expect(warm).toHaveBeenCalledWith(receipt.expectedSessionId);
    expect(() => ctx.focusSessionLaunchStore.markCreated(receipt.id, claimed.ownerToken!, receipt.expectedSessionId)).toThrow("claim changed");
  });

  it("recovers an abandoned local claim after persisting the link failure also failed", async () => {
    const object = source();
    const create = vi.spyOn(ctx.sessionManager, "createSession");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(ctx.focusMutationCoordinator, "linkLaunchedSession").mockImplementationOnce(() => { throw new Error("Link unavailable"); });
    vi.spyOn(ctx.focusSessionLaunchStore, "fail").mockImplementationOnce(() => { throw new Error("Receipt temporarily unavailable"); });
    const first = await request(app).post("/api/focus/session-launches").send(launchIdentity(object));
    expect(first.status).toBe(500);
    const receipt = ctx.focusSessionLaunchStore.find(launchIdentity(object))!;
    expect(receipt.ownerToken).not.toBeNull();
    ctx.focusSessionLaunchService = createFocusSessionLaunchService(ctx, ctx.focusSessionLaunchStore, {
      getOwner: async () => ({ pid: process.pid, startMarker: "test-app" }),
      getOwnerStatus: async () => "alive",
    });
    const recovered = await request(app).post(`/api/focus/session-launches/${receipt.id}/start`).send({});
    expect(recovered.status).toBe(200);
    expect(recovered.body.receipt.status).toBe("ready");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("safely resumes a dead claim that never dispatched external creation", async () => {
    const object = source();
    const receipt = await prepare(object);
    ctx.focusSessionLaunchStore.claim(receipt, { pid: 12345, startMarker: "old-process" });
    reconstruct();
    const create = vi.spyOn(ctx.sessionManager, "createSession");
    const recovered = await request(app).post(`/api/focus/session-launches/${receipt.id}/start`).send({});
    expect(recovered.status).toBe(200);
    expect(recovered.body.sessionId).toBe(receipt.expectedSessionId);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it.each(["alive", "unknown"] as const)("does not steal %s process ownership", async (status) => {
    const object = source();
    const receipt = await prepare(object);
    const claimed = ctx.focusSessionLaunchStore.claim(receipt, { pid: 12345, startMarker: "old-process" })!;
    reconstruct(status);
    const create = vi.spyOn(ctx.sessionManager, "createSession");
    const probe = vi.spyOn(ctx.sessionManager, "getSessionCreationState");
    const response = await request(app).post(`/api/focus/session-launches/${receipt.id}/start`).send({});
    expect(response.status).toBe(202);
    expect(response.body.sessionId).toBe(receipt.expectedSessionId);
    expect(create).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
    expect(ctx.focusSessionLaunchStore.requireReceipt(receipt.id).ownerToken).toBe(claimed.ownerToken);
  });

  it("does not replay an ambiguous dispatched create when the expected session is absent", async () => {
    const object = source();
    const receipt = await prepare(object);
    const claimed = ctx.focusSessionLaunchStore.claim(receipt, { pid: 12345, startMarker: "old-process" })!;
    ctx.focusSessionLaunchStore.markDispatched(receipt.id, claimed.ownerToken!);
    reconstruct();
    const create = vi.spyOn(ctx.sessionManager, "createSession");
    const response = await request(app).post(`/api/focus/session-launches/${receipt.id}/start`).send({});
    expect(response.status).toBe(409);
    expect(response.body.receipt).toMatchObject({ status: "unknown", errorStage: "creation", expectedSessionId: receipt.expectedSessionId });
    expect(response.body.error).toContain("no duplicate creation");
    expect(create).not.toHaveBeenCalled();
    expect(ctx.decisionStore.get(object.id)?.lifecycle).toBe("active");
  });

  it("separates launch-prompt and discussion identities and rejects intent changes within one identity", async () => {
    const object = source();
    const first = await request(app).post("/api/focus/session-launches").send(launchIdentity(object));
    const conflict = await request(app).post("/api/focus/session-launches").send({ ...launchIdentity(object), prompt: "Different launch" });
    expect(conflict.status).toBe(409);
    const discussion = await request(app).post("/api/focus/session-launches").send({ ...launchIdentity(object, "discussion"), prompt: "Discuss the trade-off" });
    expect(discussion.status).toBe(201);
    expect(discussion.body.sessionId).not.toBe(first.body.sessionId);
    const receipts = await request(app).get("/api/focus/session-launches").query({ objectId: object.id, activationId: object.activationId });
    expect(receipts.body.receipts).toHaveLength(2);
  });

  it("preserves handed-off lifecycle and ordinary session creation APIs", async () => {
    const task = ctx.taskStore.createTask("Task session");
    const object = source(task.id);
    ctx.focusMutationCoordinator.promoteToAction(object.id, ctx.checklistStore);
    const linked = await request(app).post(`/api/tasks/${task.id}/session`).send({ focusLaunch: launchIdentity(object) });
    expect(linked.status).toBe(201);
    expect(linked.body.receipt.taskId).toBe(task.id);
    expect(ctx.decisionStore.get(object.id)).toMatchObject({ lifecycle: "handed_off", status: "active", sessionId: linked.body.sessionId });
    const ordinary = await request(app).post("/api/sessions").send({});
    expect(ordinary.body).toEqual({ sessionId: "test-session" });
    const ordinaryTask = await request(app).post(`/api/tasks/${task.id}/session`).send({});
    expect(ordinaryTask.body).toEqual({ sessionId: "task-session" });
    const global = source();
    const globalLaunch = await request(app).post("/api/sessions").send({ focusLaunch: launchIdentity(global) });
    expect(globalLaunch.status).toBe(201);
    expect(globalLaunch.body.receipt.taskId).toBeNull();
  });

  it("rejects invisible default destinations but permits explicit global launch", async () => {
    const task = ctx.taskStore.createTask("Archived source");
    const object = source(task.id);
    ctx.taskStore.updateTask(task.id, { status: "archived" });
    expect((await request(app).post("/api/focus/session-launches").send(launchIdentity(object))).status).toBe(400);
    const explicit = await request(app).post("/api/focus/session-launches").send({ ...launchIdentity(object), taskId: null });
    expect(explicit.status).toBe(201);
    expect(explicit.body.receipt.taskId).toBeNull();
  });

  it.each([false, true])("guards a superseding episode without sending its old prompt, before dispatch=%s", async (beforeDispatch) => {
    const object = source();
    const entered = gate();
    const release = gate();
    const send = vi.spyOn(ctx.sessionManager, "startWorkAndWaitForDelivery");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(ctx.sessionManager, "createSession").mockImplementation(async (options) => {
      if (!beforeDispatch) options?.onCreateStarting?.();
      entered.resolve();
      await release.promise;
      if (beforeDispatch) options?.onCreateStarting?.();
      return { sessionId: options!.expectedSessionId! };
    });
    const pending = request(app).post("/api/focus/session-launches").send(launchIdentity(object)).then((response) => response);
    try {
      await entered.promise;
      const next = ctx.focusMutationCoordinator.updateDecision(object.id, { lifecycle: "active", newEpisode: true, episodeReason: "New concern" });
      release.resolve();
      const response = await pending;
      expect(response.status).toBe(409);
      expect(response.body.receipt.status).toBe("superseded");
      expect(response.body.receipt.sessionId).toBe(beforeDispatch ? null : response.body.receipt.expectedSessionId);
      if (beforeDispatch) expect(response.body.receipt.creationDispatchedAt).toBeNull();
      expect(ctx.decisionStore.get(object.id)).toMatchObject({ activationId: next.activationId, lifecycle: "active", sessionId: null });
      expect(send).not.toHaveBeenCalled();
    } finally { release.resolve(); }
  });

  it("keeps uncertain prompt delivery inspectable without sending it twice", async () => {
    const object = source();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const create = vi.spyOn(ctx.sessionManager, "createSession");
    const send = vi.spyOn(ctx.sessionManager, "startWorkAndWaitForDelivery").mockRejectedValue(new Error("Prompt delivery response lost"));
    const failed = await request(app).post("/api/focus/session-launches").send(launchIdentity(object));
    expect(failed.status).toBe(409);
    expect(failed.body.receipt).toMatchObject({ status: "unknown", promptStatus: "unknown", errorStage: "prompt" });
    reconstruct();
    const repeated = await request(app).post(`/api/focus/session-launches/${failed.body.receipt.id}/start`).send({});
    expect(repeated.body.sessionId).toBe(failed.body.sessionId);
    expect(create).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect((await request(app).get(`/api/focus/session-launches/${failed.body.receipt.id}`)).body.receipt.error).toContain("response lost");
  });
});
