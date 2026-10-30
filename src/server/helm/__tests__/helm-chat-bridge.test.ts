import { describe, expect, it } from "vitest";
import { buildThinkerPacket, readBridgeForChat, renderThinkerPacket } from "../thinker/context.js";
import type { HelmSource } from "../thinker/sources.js";
import type { HelmMemoryEntry } from "../../../shared/helm-thinker.js";

const empty = { items: [], total: 0, hasMore: false };

function source(taskCount: number, row: Record<string, unknown> = {}): HelmSource {
  return {
    id: "pc", label: "PC", local: false, webBase: null,
    sessions: async () => [],
    snapshot: async () => ({ inputs: empty, replies: empty, actions: empty }) as any,
    overview: async () => ({
      tasks: Array.from({ length: taskCount }, (_, index) => ({
        id: `t${index}`, title: `Task ${index}`, state: "active", reasons: [], muted: false, busyCount: 0, idleDays: 3,
        nextAction: "x".repeat(400), waitingOn: "y".repeat(300), ...row,
      })),
    }) as any,
    input: async () => undefined,
    messages: async () => [],
    answer: async () => undefined,
    send: async () => undefined,
    tick: async () => undefined,
  };
}

describe("read_bridge for Helm's chat", () => {
  it("keeps a whole Bridge to a size the chat can read, and says what it left out", async () => {
    const view = await readBridgeForChat(source(150));
    expect(JSON.stringify(view).length).toBeLessThanOrEqual(40_000);
    expect(view.tasks.length).toBeGreaterThanOrEqual(20);
    expect(view.tasks.length + view.omitted!.tasks).toBe(150);
    expect(view.tasks[0]).toMatchObject({ taskId: "t0", title: "Task 0", idleDays: 3 });
  });

  it("returns a small Bridge whole", async () => {
    const view = await readBridgeForChat(source(3));
    expect(view.tasks).toHaveLength(3);
    expect(view.omitted).toBeUndefined();
  });
});

describe("the thinker's packet", () => {
  it("shows a task that has not moved with its dates and Helm's thread, but not its details", async () => {
    const at = "2026-10-29T15:00:00.000Z";
    const thread: HelmMemoryEntry = {
      id: "m1", kind: "thread", key: "pc:t0", text: "Waiting on the vendor's quote", source: null, author: "helm", status: "active",
      createdAt: at, updatedAt: at, confirmedAt: at, uses: 0, fromSources: [],
    };
    const packet = await buildThinkerPacket({
      sources: [source(2, { lastEngagedAt: "2026-10-26T09:00:00.000Z", nextTouchAt: "2026-10-28T16:00:00.000Z" })],
      now: new Date("2026-10-29T18:00:00.000Z"), trigger: "schedule", rebuild: false, lastRunAt: at,
      memory: [thread], feedback: [], previousItems: [],
    });
    const [unchanged, changed] = JSON.parse(renderThinkerPacket(packet)).bridges[0].tasks;
    expect(unchanged).toEqual({
      taskId: "t0", title: "Task 0", state: "active",
      nextTouchAt: "2026-10-28T16:00:00.000Z", lastEngagedAt: "2026-10-26T09:00:00.000Z", idleDays: 3, thread: "Waiting on the vendor's quote",
    });
    expect(changed).toMatchObject({ taskId: "t1", changed: true, nextAction: expect.any(String), lastEngagedAt: "2026-10-26T09:00:00.000Z" });
  });

  it("reads tidy signs for this Bridge's tasks only on the weekly rebuild", async () => {
    const local = { ...source(2), id: "local", local: true };
    const tidyHints = (taskId: string) => (taskId === "t1" ? ["notes are 30,000 characters"] : []);
    const build = (rebuild: boolean, sources: HelmSource[]) => buildThinkerPacket({
      sources, now: new Date("2026-10-29T18:00:00.000Z"), trigger: "schedule", rebuild, lastRunAt: null,
      memory: [], feedback: [], previousItems: [], tidyHints,
    });
    const tidyOf = (packet: Awaited<ReturnType<typeof build>>) => packet.bridges.map((bridge) => bridge.tasks.map((task) => task.tidy));

    expect(tidyOf(await build(true, [local, source(2)]))).toEqual([[undefined, ["notes are 30,000 characters"]], [undefined, undefined]]);
    expect(tidyOf(await build(false, [local]))).toEqual([[undefined, undefined]]);
  });
});
