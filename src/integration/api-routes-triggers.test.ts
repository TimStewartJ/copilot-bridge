import { describe, expect, it } from "vitest";
import type { ApiRouteTestState } from "../test-support/api-routes.js";
import { installApiRouteTestHooks, request } from "../test-support/api-routes.js";

let app: ApiRouteTestState["app"];
let ctx: ApiRouteTestState["ctx"];

installApiRouteTestHooks((state) => {
  ({ app, ctx } = state);
});

const CHAT = "11111111-2222-4333-8444-555555555555";

describe("Trigger routes", () => {
  it("creates, lists, pauses, runs, cancels and deletes a task trigger", async () => {
    const task = ctx.taskStore.createTask("Ops");
    const created = await request(app).post("/api/triggers").send({
      name: "Daily review", prompt: "Review builds", then: "new_chat", taskId: task.id,
      cron: "0 8 * * 1-5", timezone: "UTC", modelTier: "preset2", keepChats: 3,
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      name: "Daily review", then: "new_chat", taskId: task.id, status: "active",
      when: { kind: "cron", cron: "0 8 * * 1-5", timezone: "UTC" }, modelTier: "preset2", keepChats: 3,
      canRun: true, canPause: true,
    });
    const id = created.body.id;

    const listed = await request(app).get(`/api/triggers?taskId=${task.id}`);
    expect(listed.status).toBe(200);
    expect(listed.body.triggers.map((trigger: { id: string }) => trigger.id)).toEqual([id]);

    expect((await request(app).patch(`/api/triggers/${id}`).send({ active: false })).body).toMatchObject({ status: "paused", canResume: true });
    expect((await request(app).post(`/api/triggers/${id}/run`)).status).toBe(409);
    expect((await request(app).patch(`/api/triggers/${id}`).send({ active: true })).body).toMatchObject({ status: "active" });
    expect((await request(app).post(`/api/triggers/${id}/run`)).body).toMatchObject({ runNow: true, canRun: false });
    expect((await request(app).post(`/api/triggers/${id}/cancel`)).body).toMatchObject({ status: "cancelled", canReactivate: true });

    const chats = await request(app).get(`/api/triggers/${id}/chats`);
    expect(chats.body).toMatchObject({ sessions: [], total: 0 });

    expect((await request(app).delete(`/api/triggers/${id}`)).body).toEqual({ ok: true, id });
    expect((await request(app).get(`/api/triggers/${id}`)).status).toBe(404);
  });

  it("lists a chat's triggers with their runs and messages, and accepts an id the trigger had as a defer", async () => {
    const created = await request(app).post("/api/triggers").send({
      prompt: "Check the PR", then: "worker", sessionId: CHAT, intervalSeconds: 60, check: { command: ["status-cli"], fireOn: "exit_code" },
    });
    expect(created.status).toBe(201);
    const listed = await request(app).get(`/api/triggers?sessionId=${CHAT}`);
    expect(listed.body).toMatchObject({
      sessionId: CHAT,
      triggers: [{ id: created.body.id, then: "worker", check: { command: ["status-cli"], fireOn: "exit_code" } }],
      recentRuns: [],
      recentDeliveries: [],
    });
    expect((await request(app).patch(`/api/triggers/interval_${created.body.id}`).send({ name: "PR watch" })).body).toMatchObject({ name: "PR watch" });
  });

  it.each([
    { name: "an unknown field", body: { prompt: "x", then: "worker", sessionId: CHAT, delaySeconds: 60, enabled: true }, error: /Unknown field/ },
    { name: "a rule the service enforces", body: { prompt: "x", then: "worker", sessionId: CHAT, delaySeconds: 60, check: { command: ["a"] } }, error: /cannot have a check/ },
  ])("rejects $name with 400", async ({ body, error }) => {
    const res = await request(app).post("/api/triggers").send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(error);
  });

  it("requires a chat or a task to list", async () => {
    expect((await request(app).get("/api/triggers")).status).toBe(400);
  });
});
