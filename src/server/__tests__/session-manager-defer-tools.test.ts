import { describe, it, expect, vi } from "vitest";
import { createBridgeTools } from "../session-manager.js";
import { toolFailure } from "../tool-results.js";
import { createTestApp } from "./helpers.js";
import { parseDeferId } from "../defer-ids.js";

function findTool(tools: ReturnType<typeof createBridgeTools>, name: string) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool "${name}" not found`);
  return tool;
}

function makeInvocation(sessionId: string | undefined): any {
  return { sessionId, toolCallId: "tc-1", toolName: "test", arguments: {} };
}

function expectFailure(result: unknown): string {
  expect((result as any).resultType).toBe("failure");
  return (result as any).textResultForLlm as string;
}

describe("unified defer tools", () => {
  it("advertises defer_create/list/cancel but not legacy defer_session", () => {
    const { ctx } = createTestApp();
    const names = createBridgeTools(ctx).map((tool) => tool.name);
    expect(names).toContain("defer_create");
    expect(names).toContain("defer_list");
    expect(names).toContain("defer_cancel");
    expect(names).not.toContain("defer_session");
  });

  it("creates a one-shot defer with a public once_ deferId", async () => {
    const { ctx } = createTestApp();
    const createTool = findTool(createBridgeTools(ctx), "defer_create");

    const result = await createTool.handler(
      { prompt: "check on the build", delaySeconds: 60 },
      makeInvocation("session-abc"),
    ) as any;

    expect(result).toMatchObject({ success: true, kind: "once", sessionId: "session-abc" });
    expect(result.deferId).toMatch(/^once_/);
    expect(parseDeferId(result.deferId)).toMatchObject({ kind: "once" });
    const delta = new Date(result.nextRunAt).getTime() - Date.now();
    expect(delta).toBeGreaterThan(55_000);
    expect(delta).toBeLessThan(65_000);

    const parsed = parseDeferId(result.deferId)!;
    const stored = ctx.deferredPromptStore!.get(parsed.id);
    expect(stored).toMatchObject({ sessionId: "session-abc", status: "pending", deferId: result.deferId });
  });

  it("creates a one-shot defer from runAt with a public once_ deferId", async () => {
    const { ctx } = createTestApp();
    const createTool = findTool(createBridgeTools(ctx), "defer_create");
    const runAt = new Date(Date.now() + 120_000).toISOString();

    const result = await createTool.handler(
      { prompt: "check at an exact time", runAt },
      makeInvocation("session-abc"),
    ) as any;

    expect(result).toMatchObject({
      success: true,
      kind: "once",
      sessionId: "session-abc",
      runAt,
      nextRunAt: runAt,
    });
    expect(result.deferId).toMatch(/^once_/);
    expect(parseDeferId(result.deferId)).toMatchObject({ kind: "once" });
  });

  it("creates a recurring interval defer with a public interval_ deferId", async () => {
    const { ctx } = createTestApp();
    const pokeSpy = vi.fn();
    ctx.deferLoopRunner = { start: vi.fn(), poke: pokeSpy, shutdown: vi.fn() } as any;
    const createTool = findTool(createBridgeTools(ctx), "defer_create");

    const result = await createTool.handler(
      { prompt: "poll the deployment", intervalSeconds: 300, maxRuns: 3, name: "deploy poller" },
      makeInvocation("session-abc"),
    ) as any;

    expect(result).toMatchObject({
      success: true,
      kind: "interval",
      sessionId: "session-abc",
      intervalSeconds: 300,
      maxRuns: 3,
    });
    expect(result.deferId).toMatch(/^interval_/);
    const parsed = parseDeferId(result.deferId)!;
    expect(parsed.kind).toBe("interval");
    expect(ctx.deferLoopStore!.get(parsed.id)).toMatchObject({
      name: "deploy poller",
      status: "active",
      runCount: 0,
    });
    expect(pokeSpy).toHaveBeenCalled();
  });

  it("validates timing modes and recurring-only options", async () => {
    const { ctx } = createTestApp();
    const createTool = findTool(createBridgeTools(ctx), "defer_create");
    await expect(createTool.handler({ prompt: "hi" }, makeInvocation("s1")))
      .resolves.toEqual(toolFailure("Provide exactly one timing mode: delaySeconds, runAt, or intervalSeconds."));
    await expect(createTool.handler({ prompt: "hi", delaySeconds: 10, runAt: new Date(Date.now() + 60_000).toISOString() }, makeInvocation("s1")))
      .resolves.toEqual(toolFailure("delaySeconds and runAt are mutually exclusive."));
    await expect(createTool.handler({ prompt: "hi", delaySeconds: 10, intervalSeconds: 300 }, makeInvocation("s1")))
      .resolves.toEqual(toolFailure("intervalSeconds cannot be combined with delaySeconds or runAt."));
    await expect(createTool.handler({ prompt: "hi", runAt: new Date(Date.now() + 60_000).toISOString(), intervalSeconds: 300 }, makeInvocation("s1")))
      .resolves.toEqual(toolFailure("intervalSeconds cannot be combined with delaySeconds or runAt."));
    await expect(createTool.handler({ prompt: "hi", delaySeconds: 10, maxRuns: 2 }, makeInvocation("s1")))
      .resolves.toEqual(toolFailure("name, maxRuns, and expiresAt are valid only for recurring interval defers."));
    await expect(createTool.handler({ prompt: "hi", delaySeconds: 10, expiresAt: new Date(Date.now() + 60_000).toISOString() }, makeInvocation("s1")))
      .resolves.toEqual(toolFailure("name, maxRuns, and expiresAt are valid only for recurring interval defers."));
    await expect(createTool.handler({ prompt: "hi", intervalSeconds: 30 }, makeInvocation("s1")))
      .resolves.toEqual(toolFailure("intervalSeconds must be at least 300 seconds."));
    await expect(createTool.handler({ prompt: "hi", intervalSeconds: 2_592_001 }, makeInvocation("s1")))
      .resolves.toEqual(toolFailure("intervalSeconds exceeds maximum of 2592000 seconds (30 days)."));
    await expect(createTool.handler({ prompt: "hi", intervalSeconds: 604_800 }, makeInvocation("s1")))
      .resolves.toEqual(toolFailure("intervalSeconds must be less than the default recurring expiry of 604800 seconds unless maxRuns or expiresAt is provided."));
    await expect(createTool.handler({
      prompt: "hi",
      intervalSeconds: 604_800,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }, makeInvocation("s1")))
      .resolves.toEqual(toolFailure("expiresAt must be after the first recurring defer run."));
    await expect(createTool.handler({ prompt: "hi", intervalSeconds: 300, maxRuns: 0 }, makeInvocation("s1")))
      .resolves.toEqual(toolFailure("maxRuns must be an integer between 1 and 10000."));
  });

  it("lists active one-shot and recurring defers without legacy IDs", async () => {
    const { ctx } = createTestApp();
    const tools = createBridgeTools(ctx);
    const createTool = findTool(tools, "defer_create");
    const listTool = findTool(tools, "defer_list");

    await createTool.handler({ prompt: "one", delaySeconds: 120 }, makeInvocation("session-A"));
    await createTool.handler({ prompt: "loop", intervalSeconds: 300, maxRuns: 2 }, makeInvocation("session-A"));
    await createTool.handler({ prompt: "other", delaySeconds: 120 }, makeInvocation("session-B"));

    const result = await listTool.handler({}, makeInvocation("session-A")) as any;
    expect(result.deferrals).toHaveLength(2);
    expect(result.deferrals.map((d: any) => d.kind).sort()).toEqual(["interval", "once"]);
    for (const item of result.deferrals) {
      expect(item.deferId).toMatch(/^(once|interval)_/);
      expect(item.deferredPromptId).toBeUndefined();
      expect(item.loopId).toBeUndefined();
      expect(item.sessionId).toBe("session-A");
    }
  });

  it("cancels one-shot and recurring defers by public deferId", async () => {
    const { ctx } = createTestApp();
    const tools = createBridgeTools(ctx);
    const createTool = findTool(tools, "defer_create");
    const cancelTool = findTool(tools, "defer_cancel");
    const summaryEvents: any[] = [];
    const unsubscribe = ctx.globalBus.subscribe((event) => {
      if (event.type === "session:defer-summary") summaryEvents.push(event);
    });

    const once = await createTool.handler({ prompt: "cancel me", delaySeconds: 60 }, makeInvocation("session-A")) as any;
    const interval = await createTool.handler({ prompt: "cancel loop", intervalSeconds: 300 }, makeInvocation("session-A")) as any;

    await expect(cancelTool.handler({ deferId: once.deferId }, makeInvocation("session-A")))
      .resolves.toMatchObject({ success: true, kind: "once" });
    await expect(cancelTool.handler({ deferId: interval.deferId }, makeInvocation("session-A")))
      .resolves.toMatchObject({ success: true, kind: "interval" });

    expect(ctx.deferredPromptStore!.get(parseDeferId(once.deferId)!.id)!.status).toBe("cancelled");
    expect(ctx.deferLoopStore!.get(parseDeferId(interval.deferId)!.id)!.status).toBe("cancelled");
    expect(summaryEvents).toHaveLength(4);
    expect(summaryEvents.map((event) => event.deferSummary.count)).toEqual([1, 2, 1, 0]);
    expect(summaryEvents[0]).toMatchObject({
      type: "session:defer-summary",
      sessionId: "session-A",
      deferSummary: { count: 1, nextRunAt: once.nextRunAt },
    });
    expect(summaryEvents[1].deferSummary.nextRunAt).toBe(once.nextRunAt);
    expect(summaryEvents[2].deferSummary.nextRunAt).toBe(interval.nextRunAt);
    expect(summaryEvents[3].deferSummary.nextRunAt).toBeNull();
    for (const event of summaryEvents) {
      expect(event.prompt).toBeUndefined();
      expect(event.name).toBeUndefined();
      expect(event.content).toBeUndefined();
    }
    unsubscribe();
  });

  it("rejects legacy deferredPromptId and loopId surfaces", async () => {
    const { ctx } = createTestApp();
    const tools = createBridgeTools(ctx);
    const createTool = findTool(tools, "defer_create");
    const cancelTool = findTool(tools, "defer_cancel");
    const listTool = findTool(tools, "defer_list");

    await expect(createTool.handler({ prompt: "hi", delaySeconds: 10, deferredPromptId: "old" }, makeInvocation("s1")))
      .resolves.toEqual(toolFailure("Legacy deferredPromptId/loopId arguments are not supported. Use deferId."));
    await expect(cancelTool.handler({ deferredPromptId: "old" }, makeInvocation("s1")))
      .resolves.toEqual(toolFailure("Legacy deferredPromptId/loopId arguments are not supported. Use deferId."));
    await expect(listTool.handler({ loopId: "old" }, makeInvocation("s1")))
      .resolves.toEqual(toolFailure("Legacy deferredPromptId/loopId arguments are not supported. Use deferId."));
  });

  it("does not cancel another session's defer", async () => {
    const { ctx } = createTestApp();
    const tools = createBridgeTools(ctx);
    const createTool = findTool(tools, "defer_create");
    const cancelTool = findTool(tools, "defer_cancel");

    const created = await createTool.handler({ prompt: "not yours", delaySeconds: 60 }, makeInvocation("owner")) as any;
    const text = expectFailure(await cancelTool.handler({ deferId: created.deferId }, makeInvocation("attacker")));
    expect(text).toContain("does not belong to this session");
  });

  it("does not cancel another session's recurring interval defer", async () => {
    const { ctx } = createTestApp();
    const tools = createBridgeTools(ctx);
    const createTool = findTool(tools, "defer_create");
    const cancelTool = findTool(tools, "defer_cancel");

    const created = await createTool.handler({ prompt: "not yours", intervalSeconds: 300 }, makeInvocation("owner")) as any;
    const text = expectFailure(await cancelTool.handler({ deferId: created.deferId }, makeInvocation("attacker")));
    expect(text).toContain("does not belong to this session");
    expect(ctx.deferLoopStore!.get(parseDeferId(created.deferId)!.id)!.status).toBe("active");
  });
});
