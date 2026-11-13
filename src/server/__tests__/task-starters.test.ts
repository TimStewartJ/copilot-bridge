import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestBus, setupTestDb } from "./helpers.js";
import { createTaskStore, type TaskStore } from "../task-store.js";
import { createTaskStartersStore, type TaskStartersStore } from "../task-starters-store.js";
import { AUTO_REFRESH_QUIET_MS, parseStartersReply, TaskStartersService } from "../task-starters.js";
import { createGlobalBus } from "../global-bus.js";
import type { DatabaseSync } from "../db.js";

let db: DatabaseSync;
let taskStore: TaskStore;
let starters: TaskStartersStore;

beforeEach(() => {
  db = setupTestDb();
  taskStore = createTaskStore(db, createTestBus());
  starters = createTaskStartersStore(db);
});

function service(reply: string | undefined, extra: Record<string, unknown> = {}, options = {}) {
  const prompts: string[] = [];
  const ctx = {
    ...extra,
    taskStore,
    taskStartersStore: starters,
    settingsStore: { getSettings: () => ({}) },
    sessionTitles: { getTitle: () => undefined },
    sessionManager: {
      isSessionBusy: () => false,
      listModels: async () => [],
      createHelperSession: async () => ({
        session: {
          sendAndWait: async ({ prompt }: { prompt: string }) => { prompts.push(prompt); return { data: { content: reply } }; },
          abort: async () => undefined,
        },
        dispose: async () => undefined,
      }),
    },
  } as unknown as ConstructorParameters<typeof TaskStartersService>[0];
  return { svc: new TaskStartersService(ctx, options), prompts };
}

describe("task starters store", () => {
  it("replaces only the open set, closes each suggestion once, and goes with its task", () => {
    const task = taskStore.createTask("Example trip");
    const [first] = starters.replace(task.id, [{ label: "Book it", prompt: "Book the flight." }, { label: "Pack", prompt: "Make a packing list." }], "helm");
    expect(starters.close(task.id, first!.id, "dismissed")).toBe(true);
    expect(starters.close(task.id, first!.id, "used")).toBe(false);

    starters.replace(task.id, [{ label: "Check in", prompt: "Check in online.", playbook: "none" }], "refresh");
    expect(starters.list(task.id).map((starter) => [starter.label, starter.source, starter.playbook])).toEqual([["Check in", "refresh", "none"]]);
    expect(starters.listDismissedLabels(task.id)).toEqual(["Book it"]);

    taskStore.deleteTaskCascade(task.id);
    expect(db.prepare("SELECT COUNT(*) AS n FROM task_starters").get()).toEqual({ n: 0 });
  });
});

describe("task starters refresh", () => {

  it("writes the model's chats for that task, and reports a reply that doesn't fit", async () => {
    const task = taskStore.createTask("Example launch");
    const good = service("Here you go:\n```json\n{\"chats\":[{\"label\":\"Draft the notes\",\"prompt\":\"Draft the release notes.\"}]}\n```");
    await good.svc.refresh(task.id);
    expect(good.prompts[0]).toContain("Example launch");
    expect(good.svc.get(task.id)).toMatchObject({ refreshing: false, starters: [{ label: "Draft the notes", source: "refresh" }] });

    const bad = service(JSON.stringify({ chats: [{ label: "x".repeat(200), prompt: "p" }] }));
    await bad.svc.refresh(task.id);
    const after = bad.svc.get(task.id);
    expect(after.error).toMatch(/didn't fit/);
    expect(after.starters.map((starter) => starter.label)).toEqual(["Draft the notes"]);
  });

  it("finds the JSON in a reply with text around it", () => {
    expect(parseStartersReply("Sure! {\"chats\": []} Done.")).toEqual([]);
    expect(() => parseStartersReply("no json")).toThrow(/no suggestions/);
  });
});

describe("task starters auto-refresh", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("refreshes a task once its chat stays quiet after a reply, skipping scheduled chats and recent refreshes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const bus = createGlobalBus();
    const task = taskStore.createTask("Example garden plan");
    taskStore.linkSession(task.id, "chat-1");
    taskStore.linkSession(task.id, "monitor-1");
    const states: Record<string, { triggeredBy?: string }> = { "monitor-1": { triggeredBy: "schedule" } };
    const reply = JSON.stringify({ chats: [{ label: "Order seeds", prompt: "Order the seeds on the list." }] });
    const { svc, prompts } = service(reply, { globalBus: bus, bridgeSessionStateStore: { getState: (id: string) => states[id] } }, { autoRefresh: true });

    bus.emit({ type: "session:idle", sessionId: "monitor-1", assistantPreview: "Nothing new." });
    await vi.advanceTimersByTimeAsync(AUTO_REFRESH_QUIET_MS);
    expect(prompts).toHaveLength(0);

    bus.emit({ type: "session:idle", sessionId: "chat-1", assistantPreview: "Drafted the bed layout." });
    await vi.advanceTimersByTimeAsync(AUTO_REFRESH_QUIET_MS - 1);
    expect(prompts).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(svc.get(task.id).refreshing).toBe(false));
    expect(prompts[0]).toContain("Drafted the bed layout.");
    expect(svc.get(task.id).starters).toMatchObject([{ label: "Order seeds", source: "auto" }]);

    bus.emit({ type: "session:idle", sessionId: "chat-1", assistantPreview: "Done." });
    await vi.advanceTimersByTimeAsync(AUTO_REFRESH_QUIET_MS);
    expect(prompts).toHaveLength(1);
    svc.dispose();
  });
});
