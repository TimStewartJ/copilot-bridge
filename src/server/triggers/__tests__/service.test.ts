import { beforeEach, describe, expect, it } from "vitest";
import { setupTestDb } from "../../__tests__/helpers.js";
import { createDeferredPromptStore } from "../../deferred-prompt-store.js";
import type { DatabaseSync } from "../../db.js";
import { createGlobalBus, type StatusEvent } from "../../global-bus.js";
import { createTaskStore } from "../../task-store.js";
import { createTriggerMessageDelivery, createTriggerResultDelivery } from "../messages.js";
import { createTriggerService } from "../service.js";
import { createTriggerStore } from "../store.js";

const NOW = new Date("2026-11-16T12:00:00.000Z");
let db: DatabaseSync;

beforeEach(() => {
  db = setupTestDb();
});

function setup() {
  const bus = createGlobalBus();
  const events: StatusEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const taskStore = createTaskStore(db, bus);
  const task = taskStore.createTask("Ops");
  const store = createTriggerStore(db);
  const outbox = createDeferredPromptStore(db);
  const pokes: string[] = [];
  const service = createTriggerService({
    store, taskStore, globalBus: bus, deferredPromptStore: outbox,
    chatRunner: { poke: () => pokes.push("chat") },
    taskRunner: { poke: () => pokes.push("task") },
  });
  return { bus, events, taskStore, task, store, outbox, service, pokes };
}

const check = { command: ["status-cli"] };

describe("trigger service: create", () => {
  it.each([
    { name: "a one-time trigger with a check", input: { delaySeconds: 60, check }, error: /cannot have a check/ },
    { name: "an unchecked interval under five minutes", input: { intervalSeconds: 120 }, error: /at least 300 without a check/ },
    { name: "a checked interval under 30 seconds", input: { intervalSeconds: 10, check }, error: /at least 30 with a check/ },
    { name: "an unchecked cron every minute", input: { cron: "* * * * *" }, error: /60 seconds apart; without a check the minimum is 300/ },
    { name: "two timings", input: { delaySeconds: 60, intervalSeconds: 600 }, error: /exactly one timing/ },
    { name: "an exit_code check that also fires on its first run", input: { intervalSeconds: 60, check: { ...check, fireOn: "exit_code", fireOnFirstRun: true } }, error: /applies only to change checks/ },
  ])("refuses $name", ({ input, error }) => {
    const { service } = setup();
    const result = service.create({ prompt: "Look", then: "worker", sessionId: "chat-1", ...input }, {}, NOW);
    expect(result).toMatchObject({ ok: false, status: 400, error: expect.stringMatching(error) });
  });

  it("accepts a checked cron every minute and gives a recurring chat trigger a week's expiry", () => {
    const { service, events, pokes } = setup();
    events.length = 0;
    const result = service.create({ prompt: "Look", then: "message", sessionId: "chat-1", cron: "* * * * *", timezone: "UTC", check }, {}, NOW);
    expect(result).toMatchObject({
      ok: true,
      trigger: {
        sessionId: "chat-1", action: { kind: "chat", via: "message" }, nextRunAt: "2026-11-16T12:01:00.000Z",
        expiresAt: "2026-11-23T12:00:00.000Z", check: { command: ["status-cli"], fireOn: "change", timeoutSeconds: 60 },
      },
    });
    expect(events.map((event) => event.type)).toEqual(["trigger:changed", "session:trigger-summary"]);
    expect(pokes).toEqual(["chat"]);
  });

  it("bounds task-creating triggers and keeps tasks they made from making more", () => {
    const { service, store, task } = setup();
    const base = { prompt: "Triage", then: "new_task", taskId: task.id, title: "Alert triage", intervalSeconds: 600, check };
    expect(service.create(base, {}, NOW)).toMatchObject({ ok: false, error: expect.stringMatching(/needs maxRuns/) });
    expect(service.create({ ...base, maxRuns: 21 }, {}, NOW)).toMatchObject({ ok: false, error: expect.stringMatching(/at most 20/) });
    const created = service.create({ ...base, maxRuns: 3 }, {}, NOW);
    expect(created).toMatchObject({ ok: true, trigger: { taskId: task.id, action: { kind: "new_task", title: "Alert triage" } } });

    store.recordRun({ triggerId: created.ok ? created.trigger.id : "", sessionId: "chat-1", taskId: "made-task" });
    expect(service.create({ ...base, maxRuns: 3 }, { taskId: "made-task" }, NOW))
      .toMatchObject({ ok: false, error: expect.stringMatching(/created by a trigger/) });
  });
});

describe("trigger service: lifecycle", () => {
  it("pauses, resumes from now, and restarts a stopped trigger after retiring its stale final message", () => {
    const { service, store, outbox } = setup();
    const created = service.create({ prompt: "Look", sessionId: "chat-1", intervalSeconds: 600 }, {}, NOW);
    if (!created.ok) throw new Error(created.error);
    const id = created.trigger.id;

    expect(service.update(id, { active: false }, NOW)).toMatchObject({ ok: true, trigger: { status: "paused" } });
    expect(service.runNow(id, NOW)).toMatchObject({ ok: false, status: 409 });
    const later = new Date(NOW.getTime() + 3_600_000);
    expect(service.update(id, { active: true }, later)).toMatchObject({
      ok: true, trigger: { status: "active", nextRunAt: "2026-11-16T13:10:00.000Z" },
    });

    expect(service.cancel(id, later)).toMatchObject({ ok: true, trigger: { status: "cancelled" } });
    const final = createTriggerResultDelivery({ triggerId: id, parentSessionId: "chat-1" }, "FINAL TRIGGER RESULT: stopped.");
    outbox.enqueueDelivery(final);
    expect(service.reactivate(`interval_${id}`, later)).toMatchObject({ ok: true, trigger: { status: "active" } });
    expect(outbox.get(final.id)?.status).toBe("cancelled");
    expect(store.get(id)).toMatchObject({ attempts: 0, nextRunAt: later.toISOString() });
  });

  it("gives a one-time chat trigger turned recurring the default end, and keeps a queued message prompt when restarted", () => {
    const { service, outbox } = setup();
    const created = service.create({ prompt: "Ping", then: "message", sessionId: "chat-1", delaySeconds: 60 }, {}, NOW);
    if (!created.ok) throw new Error(created.error);
    const id = created.trigger.id;
    expect(service.update(id, { intervalSeconds: 600 }, NOW)).toMatchObject({ ok: true, trigger: { expiresAt: "2026-11-23T12:00:00.000Z" } });

    const fired = createTriggerMessageDelivery({ triggerId: id, parentSessionId: "chat-1", prompt: "Ping", continues: false });
    outbox.enqueueDelivery(fired);
    service.cancel(id, NOW);
    expect(service.reactivate(id, NOW)).toMatchObject({ ok: true });
    expect(outbox.get(fired.id)?.status).toBe("pending");
  });

  it("refuses to change a trigger while it runs", () => {
    const { service, store } = setup();
    const created = service.create({ prompt: "Look", sessionId: "chat-1", delaySeconds: 0 }, {}, NOW);
    if (!created.ok) throw new Error(created.error);
    store.claimDue(created.trigger.id, 60_000, NOW.toISOString());
    expect(service.update(created.trigger.id, { prompt: "Other" }, NOW)).toMatchObject({ ok: false, status: 409 });
  });
});
