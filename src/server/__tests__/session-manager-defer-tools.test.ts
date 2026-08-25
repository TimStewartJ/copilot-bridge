import { describe, it, expect, vi } from "vitest";
import { getBridgeToolDefinitions } from "../agent-tools-mcp/register.js";
import { toolFailure } from "../tool-results.js";
import { createTestApp } from "./test-app.js";
import { parseDeferId } from "../defer-ids.js";
import { TRANSCRIPT_SIZE_WARNING_BYTES } from "../tools/defer-tools.js";

function findTool(tools: ReturnType<typeof getBridgeToolDefinitions>, name: string) {
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
  it("creates a one-shot defer with a public once_ deferId", async () => {
    const { ctx } = createTestApp();
    const createTool = findTool(getBridgeToolDefinitions(ctx), "defer_create");

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
    const createTool = findTool(getBridgeToolDefinitions(ctx), "defer_create");
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
    const createTool = findTool(getBridgeToolDefinitions(ctx), "defer_create");

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
    const createTool = findTool(getBridgeToolDefinitions(ctx), "defer_create");
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
    const tools = getBridgeToolDefinitions(ctx);
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

  it("lists inactive defers when requested and reports transcript size warnings", async () => {
    const { ctx } = createTestApp();
    const tools = getBridgeToolDefinitions(ctx);
    const createTool = findTool(tools, "defer_create");
    const listTool = findTool(tools, "defer_list");

    await createTool.handler({ prompt: "active once", delaySeconds: 120 }, makeInvocation("session-A"));
    await createTool.handler({ prompt: "active loop", intervalSeconds: 300, maxRuns: 2 }, makeInvocation("session-A"));
    const cancelled = await createTool.handler({ prompt: "cancelled once", delaySeconds: 120 }, makeInvocation("session-A")) as any;
    const failed = await createTool.handler({ prompt: "failed loop", intervalSeconds: 300, maxRuns: 2 }, makeInvocation("session-A")) as any;
    ctx.deferredPromptStore!.cancelById(parseDeferId(cancelled.deferId)!.id);
    ctx.deferLoopStore!.markFailedById(parseDeferId(failed.deferId)!.id, "resumeSession timed out after 60s");

    const defaultResult = await listTool.handler({}, makeInvocation("session-A")) as any;
    expect(defaultResult.deferrals.map((item: any) => item.status).sort()).toEqual(["active", "pending"]);

    const transcriptSizeBytes = Math.round(96.1 * 1024 * 1024);
    vi.spyOn(ctx.sessionManager, "listSessionsFromDisk").mockResolvedValue([
      { sessionId: "session-A", eventLogSizeBytes: transcriptSizeBytes },
    ] as any);
    const result = await listTool.handler({ includeInactive: true }, makeInvocation("session-A")) as any;

    expect(result.deferrals.map((item: any) => item.status).sort()).toEqual([
      "active",
      "cancelled",
      "failed",
      "pending",
    ]);
    expect(result.deferrals.find((item: any) => item.deferId === failed.deferId)).toMatchObject({
      status: "failed",
      lastError: "resumeSession timed out after 60s",
    });
    expect(result.transcriptSizeBytes).toBe(transcriptSizeBytes);
    expect(result.warning).toContain("This session's transcript is 96.1 MB");
    expect(result.warning).toContain(`above ${TRANSCRIPT_SIZE_WARNING_BYTES / (1024 * 1024)} MB`);
  });

  it("includes transcript size without warning below the threshold", async () => {
    const { ctx } = createTestApp();
    const listTool = findTool(getBridgeToolDefinitions(ctx), "defer_list");
    vi.spyOn(ctx.sessionManager, "listSessionsFromDisk").mockResolvedValue([
      { sessionId: "session-A", eventLogSizeBytes: 1024 },
    ] as any);

    const result = await listTool.handler({}, makeInvocation("session-A")) as any;

    expect(result.transcriptSizeBytes).toBe(1024);
    expect(result.warning).toBeUndefined();
  });

  it("warns when creating an interval defer from a large transcript session", async () => {
    const { ctx } = createTestApp();
    const createTool = findTool(getBridgeToolDefinitions(ctx), "defer_create");
    const transcriptSizeBytes = Math.round(96.1 * 1024 * 1024);
    vi.spyOn(ctx.sessionManager, "listSessionsFromDisk").mockResolvedValue([
      { sessionId: "session-A", eventLogSizeBytes: transcriptSizeBytes },
    ] as any);

    const result = await createTool.handler(
      { prompt: "poll deployment", intervalSeconds: 300, maxRuns: 2 },
      makeInvocation("session-A"),
    ) as any;

    expect(result).toMatchObject({
      success: true,
      kind: "interval",
      transcriptSizeBytes,
    });
    expect(result.warning).toContain("This session's transcript is 96.1 MB");
    expect(result.warning).toContain("Prefer monitoring from a fresh session");
  });

  it("cancels one-shot and recurring defers by public deferId", async () => {
    const { ctx } = createTestApp();
    const tools = getBridgeToolDefinitions(ctx);
    const createTool = findTool(tools, "defer_create");
    const cancelTool = findTool(tools, "defer_cancel");
    const markAttention = vi.spyOn(ctx.sessionManager, "markSessionAttention");
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
    expect(markAttention).toHaveBeenCalledTimes(1);
    expect(markAttention).toHaveBeenCalledWith("session-A");
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

  it("reactivates cancelled one-shot and expired recurring defers for the owning session", async () => {
    const { ctx } = createTestApp();
    const oncePoke = vi.fn();
    const loopPoke = vi.fn();
    ctx.deferredPromptRunner = { start: vi.fn(), poke: oncePoke, shutdown: vi.fn() } as any;
    ctx.deferLoopRunner = { start: vi.fn(), poke: loopPoke, shutdown: vi.fn() } as any;
    const tools = getBridgeToolDefinitions(ctx);
    const createTool = findTool(tools, "defer_create");
    const reactivateTool = findTool(tools, "defer_reactivate");
    const summaryEvents: any[] = [];
    const unsubscribe = ctx.globalBus.subscribe((event) => {
      if (event.type === "session:defer-summary") summaryEvents.push(event);
    });

    const once = await createTool.handler({ prompt: "once", delaySeconds: 60 }, makeInvocation("session-A")) as any;
    const interval = await createTool.handler({ prompt: "loop", intervalSeconds: 300, maxRuns: 2 }, makeInvocation("session-A")) as any;
    ctx.deferredPromptStore!.cancelById(parseDeferId(once.deferId)!.id);
    ctx.deferLoopStore!.markExpired(parseDeferId(interval.deferId)!.id);
    oncePoke.mockClear();
    loopPoke.mockClear();

    const onceResult = await reactivateTool.handler({ deferId: once.deferId }, makeInvocation("session-A")) as any;
    const loopResult = await reactivateTool.handler({ deferId: interval.deferId }, makeInvocation("session-A")) as any;

    expect(onceResult).toMatchObject({
      success: true,
      deferId: once.deferId,
      kind: "once",
      status: "pending",
      nextRunAt: expect.any(String),
    });
    expect(loopResult).toMatchObject({
      success: true,
      deferId: interval.deferId,
      kind: "interval",
      status: "active",
      nextRunAt: expect.any(String),
    });
    expect(ctx.deferredPromptStore!.get(parseDeferId(once.deferId)!.id)).toMatchObject({
      status: "pending",
      attempts: 0,
      lastError: undefined,
    });
    expect(ctx.deferLoopStore!.get(parseDeferId(interval.deferId)!.id)).toMatchObject({
      status: "active",
      attempts: 0,
      lastError: undefined,
    });
    expect(oncePoke).toHaveBeenCalledTimes(1);
    expect(loopPoke).toHaveBeenCalledTimes(1);
    expect(summaryEvents.at(-1)).toMatchObject({
      type: "session:defer-summary",
      sessionId: "session-A",
      deferSummary: { count: 2 },
    });
    unsubscribe();
  });

  it("rejects defer reactivation for the wrong session or active status", async () => {
    const { ctx } = createTestApp();
    const tools = getBridgeToolDefinitions(ctx);
    const createTool = findTool(tools, "defer_create");
    const reactivateTool = findTool(tools, "defer_reactivate");

    const ownedOnce = await createTool.handler({ prompt: "not yours", delaySeconds: 60 }, makeInvocation("owner")) as any;
    ctx.deferredPromptStore!.cancelById(parseDeferId(ownedOnce.deferId)!.id);
    expect(expectFailure(await reactivateTool.handler({ deferId: ownedOnce.deferId }, makeInvocation("attacker"))))
      .toContain("does not belong to this session");

    const activeOnce = await createTool.handler({ prompt: "active once", delaySeconds: 60 }, makeInvocation("owner")) as any;
    expect(expectFailure(await reactivateTool.handler({ deferId: activeOnce.deferId }, makeInvocation("owner"))))
      .toContain("cannot be reactivated");

    const activeLoop = await createTool.handler({ prompt: "active loop", intervalSeconds: 300, maxRuns: 2 }, makeInvocation("owner")) as any;
    expect(expectFailure(await reactivateTool.handler({ deferId: activeLoop.deferId }, makeInvocation("owner"))))
      .toContain("cannot be reactivated");
  });

  it("rejects legacy deferredPromptId and loopId surfaces", async () => {
    const { ctx } = createTestApp();
    const tools = getBridgeToolDefinitions(ctx);
    const createTool = findTool(tools, "defer_create");
    const cancelTool = findTool(tools, "defer_cancel");
    const listTool = findTool(tools, "defer_list");

    await expect(createTool.handler({ prompt: "hi", delaySeconds: 10, deferredPromptId: "old" }, makeInvocation("s1")))
      .resolves.toEqual(toolFailure("Legacy deferredPromptId/loopId arguments are not supported. Use deferId."));
    // Legacy-only calls now fail the declared schema first: the required
    // replacement argument is named in the failure.
    const legacyCancel: any = await cancelTool.handler({ deferredPromptId: "old" }, makeInvocation("s1"));
    expect(String(legacyCancel.textResultForLlm)).toContain("missing required property: deferId");
    await expect(listTool.handler({ loopId: "old" }, makeInvocation("s1")))
      .resolves.toEqual(toolFailure("Legacy deferredPromptId/loopId arguments are not supported. Use deferId."));
  });

  it("does not cancel another session's defer", async () => {
    const { ctx } = createTestApp();
    const tools = getBridgeToolDefinitions(ctx);
    const createTool = findTool(tools, "defer_create");
    const cancelTool = findTool(tools, "defer_cancel");

    const created = await createTool.handler({ prompt: "not yours", delaySeconds: 60 }, makeInvocation("owner")) as any;
    const text = expectFailure(await cancelTool.handler({ deferId: created.deferId }, makeInvocation("attacker")));
    expect(text).toContain("does not belong to this session");
  });

  it("does not cancel another session's recurring interval defer", async () => {
    const { ctx } = createTestApp();
    const tools = getBridgeToolDefinitions(ctx);
    const createTool = findTool(tools, "defer_create");
    const cancelTool = findTool(tools, "defer_cancel");

    const created = await createTool.handler({ prompt: "not yours", intervalSeconds: 300 }, makeInvocation("owner")) as any;
    const text = expectFailure(await cancelTool.handler({ deferId: created.deferId }, makeInvocation("attacker")));
    expect(text).toContain("does not belong to this session");
    expect(ctx.deferLoopStore!.get(parseDeferId(created.deferId)!.id)!.status).toBe("active");
  });
});
