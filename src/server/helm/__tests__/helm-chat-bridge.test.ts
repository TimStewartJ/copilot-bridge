import { describe, expect, it } from "vitest";
import { readBridgeForChat } from "../thinker/context.js";
import type { HelmSource } from "../thinker/sources.js";

const empty = { items: [], total: 0, hasMore: false };

function source(taskCount: number): HelmSource {
  return {
    id: "pc", label: "PC", local: false, webBase: null,
    sessions: async () => [],
    snapshot: async () => ({ inputs: empty, replies: empty, actions: empty }) as any,
    overview: async () => ({
      tasks: Array.from({ length: taskCount }, (_, index) => ({
        id: `t${index}`, title: `Task ${index}`, state: "active", reasons: [], muted: false, busyCount: 0, idleDays: 3,
        nextAction: "x".repeat(400), waitingOn: "y".repeat(300),
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
