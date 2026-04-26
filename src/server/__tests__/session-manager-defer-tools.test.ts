import { describe, it, expect, vi } from "vitest";
import { createBridgeTools } from "../session-manager.js";
import { toolFailure } from "../tool-results.js";
import { createTestApp } from "./helpers.js";

// ── Helpers ──────────────────────────────────────────────────────

function findTool(tools: ReturnType<typeof createBridgeTools>, name: string) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool "${name}" not found`);
  return tool;
}

function makeInvocation(sessionId: string | undefined): any {
  return { sessionId, toolCallId: "tc-1", toolName: "test", arguments: {} };
}

/** Assert result is a tool failure and return its text */
function expectFailure(result: unknown): string {
  expect((result as any).resultType).toBe("failure");
  return (result as any).textResultForLlm as string;
}

// ── defer_session ─────────────────────────────────────────────────

describe("defer_session tool", () => {
  it("creates a pending deferral with delaySeconds", async () => {
    const { ctx } = createTestApp();
    const tool = findTool(createBridgeTools(ctx), "defer_session");

    const result = await tool.handler(
      { prompt: "check on the build", delaySeconds: 60 },
      makeInvocation("session-abc"),
    ) as any;

    expect(result.success).toBe(true);
    expect(result.sessionId).toBe("session-abc");
    expect(result.message).toContain("Deferred prompt scheduled");

    const delta = new Date(result.runAt).getTime() - Date.now();
    expect(delta).toBeGreaterThan(55_000);
    expect(delta).toBeLessThan(65_000);

    const stored = ctx.deferredPromptStore!.get(result.deferredPromptId);
    expect(stored).toBeDefined();
    expect(stored!.sessionId).toBe("session-abc");
    expect(stored!.status).toBe("pending");
  });

  it("creates a pending deferral with runAt", async () => {
    const { ctx } = createTestApp();
    const tool = findTool(createBridgeTools(ctx), "defer_session");
    const runAt = new Date(Date.now() + 120_000).toISOString();

    const result = await tool.handler(
      { prompt: "follow up", runAt },
      makeInvocation("session-abc"),
    ) as any;

    expect(result.success).toBe(true);
    expect(result.runAt).toBe(runAt);
    expect(result.sessionId).toBe("session-abc");
  });

  it("rejects missing invocation session", async () => {
    const { ctx } = createTestApp();
    const tool = findTool(createBridgeTools(ctx), "defer_session");
    const result = await tool.handler({ prompt: "hello", delaySeconds: 10 }, makeInvocation(undefined));
    expect(result).toEqual(toolFailure("No active session — defer_session requires an invocation session."));
  });

  it("rejects empty prompt", async () => {
    const { ctx } = createTestApp();
    const tool = findTool(createBridgeTools(ctx), "defer_session");
    expect(await tool.handler({ prompt: "", delaySeconds: 10 }, makeInvocation("s1")))
      .toEqual(toolFailure("prompt must be a non-empty string."));
    expect(await tool.handler({ prompt: "  ", delaySeconds: 10 }, makeInvocation("s1")))
      .toEqual(toolFailure("prompt must be a non-empty string."));
  });

  it("rejects too-long prompt", async () => {
    const { ctx } = createTestApp();
    const tool = findTool(createBridgeTools(ctx), "defer_session");
    const bigPrompt = "x".repeat(32 * 1024 + 1);
    const text = expectFailure(await tool.handler({ prompt: bigPrompt, delaySeconds: 10 }, makeInvocation("s1")));
    expect(text).toContain("too long");
  });

  it("rejects both timing fields", async () => {
    const { ctx } = createTestApp();
    const tool = findTool(createBridgeTools(ctx), "defer_session");
    const result = await tool.handler(
      { prompt: "hi", delaySeconds: 10, runAt: new Date(Date.now() + 60_000).toISOString() },
      makeInvocation("s1"),
    );
    expect(result).toEqual(toolFailure("Provide exactly one of delaySeconds or runAt, not both."));
  });

  it("rejects missing timing field", async () => {
    const { ctx } = createTestApp();
    const tool = findTool(createBridgeTools(ctx), "defer_session");
    const result = await tool.handler({ prompt: "hi" }, makeInvocation("s1"));
    expect(result).toEqual(toolFailure("Provide exactly one of delaySeconds or runAt."));
  });

  it("rejects negative delaySeconds", async () => {
    const { ctx } = createTestApp();
    const tool = findTool(createBridgeTools(ctx), "defer_session");
    expectFailure(await tool.handler({ prompt: "hi", delaySeconds: -5 }, makeInvocation("s1")));
  });

  it("rejects zero delaySeconds", async () => {
    const { ctx } = createTestApp();
    const tool = findTool(createBridgeTools(ctx), "defer_session");
    expectFailure(await tool.handler({ prompt: "hi", delaySeconds: 0 }, makeInvocation("s1")));
  });

  it("rejects too-large delaySeconds (>30 days)", async () => {
    const { ctx } = createTestApp();
    const tool = findTool(createBridgeTools(ctx), "defer_session");
    const text = expectFailure(
      await tool.handler({ prompt: "hi", delaySeconds: 30 * 24 * 3600 + 1 }, makeInvocation("s1")),
    );
    expect(text).toContain("exceeds maximum horizon");
  });

  it("rejects non-finite delaySeconds", async () => {
    const { ctx } = createTestApp();
    const tool = findTool(createBridgeTools(ctx), "defer_session");
    expectFailure(await tool.handler({ prompt: "hi", delaySeconds: Infinity }, makeInvocation("s1")));
  });

  it("rejects invalid runAt (not a date)", async () => {
    const { ctx } = createTestApp();
    const tool = findTool(createBridgeTools(ctx), "defer_session");
    const text = expectFailure(await tool.handler({ prompt: "hi", runAt: "not-a-date" }, makeInvocation("s1")));
    expect(text).toContain("not a valid date");
  });

  it("rejects past runAt", async () => {
    const { ctx } = createTestApp();
    const tool = findTool(createBridgeTools(ctx), "defer_session");
    const pastDate = new Date(Date.now() - 60_000).toISOString();
    const result = await tool.handler({ prompt: "hi", runAt: pastDate }, makeInvocation("s1"));
    expect(result).toEqual(toolFailure("runAt must be in the future."));
  });

  it("rejects too-far runAt (>30 days)", async () => {
    const { ctx } = createTestApp();
    const tool = findTool(createBridgeTools(ctx), "defer_session");
    const farDate = new Date(Date.now() + (30 * 24 * 3600 + 60) * 1000).toISOString();
    const text = expectFailure(await tool.handler({ prompt: "hi", runAt: farDate }, makeInvocation("s1")));
    expect(text).toContain("exceeds maximum horizon");
  });

  it("calls poke on the runner after creating a deferral", async () => {
    const { ctx } = createTestApp();
    const pokeSpy = vi.fn();
    ctx.deferredPromptRunner = { start: vi.fn(), poke: pokeSpy, shutdown: vi.fn() } as any;
    const tool = findTool(createBridgeTools(ctx), "defer_session");
    await tool.handler({ prompt: "poke test", delaySeconds: 30 }, makeInvocation("s1"));
    expect(pokeSpy).toHaveBeenCalled();
  });

  it("fails clearly when deferredPromptStore is missing", async () => {
    const { ctx } = createTestApp();
    delete (ctx as any).deferredPromptStore;
    const tool = findTool(createBridgeTools(ctx), "defer_session");
    const result = await tool.handler({ prompt: "hi", delaySeconds: 10 }, makeInvocation("s1"));
    expect(result).toEqual(toolFailure("Deferred prompt store is unavailable."));
  });
});

// ── defer_list ────────────────────────────────────────────────────

describe("defer_list tool", () => {
  it("returns only pending/running deferrals for the invoking session", async () => {
    const { ctx } = createTestApp();
    const tools = createBridgeTools(ctx);
    const deferTool = findTool(tools, "defer_session");
    const listTool = findTool(tools, "defer_list");

    await deferTool.handler({ prompt: "session A prompt", delaySeconds: 60 }, makeInvocation("session-A"));
    await deferTool.handler({ prompt: "session B prompt", delaySeconds: 60 }, makeInvocation("session-B"));

    const result = await listTool.handler({}, makeInvocation("session-A")) as any;
    expect(result.deferrals).toHaveLength(1);
    expect(result.deferrals[0].sessionId).toBe("session-A");
    expect(result.deferrals[0].prompt).toBe("session A prompt");
    expect(result.deferrals[0].status).toBe("pending");
  });

  it("returns empty list when no deferrals exist for this session", async () => {
    const { ctx } = createTestApp();
    const listTool = findTool(createBridgeTools(ctx), "defer_list");
    const result = await listTool.handler({}, makeInvocation("session-A")) as any;
    expect(result.deferrals).toEqual([]);
  });

  it("rejects missing invocation session", async () => {
    const { ctx } = createTestApp();
    const listTool = findTool(createBridgeTools(ctx), "defer_list");
    const result = await listTool.handler({}, makeInvocation(undefined));
    expect(result).toEqual(toolFailure("No active session — defer_list requires an invocation session."));
  });

  it("does not expose other sessions' deferrals", async () => {
    const { ctx } = createTestApp();
    const deferTool = findTool(createBridgeTools(ctx), "defer_session");
    const listTool = findTool(createBridgeTools(ctx), "defer_list");

    await deferTool.handler({ prompt: "other session", delaySeconds: 60 }, makeInvocation("session-other"));
    const result = await listTool.handler({}, makeInvocation("session-me")) as any;
    expect(result.deferrals).toHaveLength(0);
  });
});

// ── defer_cancel ─────────────────────────────────────────────────

describe("defer_cancel tool", () => {
  it("cancels a pending deferral belonging to this session", async () => {
    const { ctx } = createTestApp();
    const deferTool = findTool(createBridgeTools(ctx), "defer_session");
    const cancelTool = findTool(createBridgeTools(ctx), "defer_cancel");

    const created = await deferTool.handler({ prompt: "cancel me", delaySeconds: 60 }, makeInvocation("session-A")) as any;
    const result = await cancelTool.handler({ deferredPromptId: created.deferredPromptId }, makeInvocation("session-A")) as any;

    expect(result.success).toBe(true);
    const stored = ctx.deferredPromptStore!.get(created.deferredPromptId);
    expect(stored!.status).toBe("cancelled");
  });

  it("does not cancel another session's deferral", async () => {
    const { ctx } = createTestApp();
    const deferTool = findTool(createBridgeTools(ctx), "defer_session");
    const cancelTool = findTool(createBridgeTools(ctx), "defer_cancel");

    const created = await deferTool.handler({ prompt: "not yours", delaySeconds: 60 }, makeInvocation("session-owner")) as any;
    const text = expectFailure(
      await cancelTool.handler({ deferredPromptId: created.deferredPromptId }, makeInvocation("session-attacker")),
    );
    expect(text).toContain("does not belong to this session");

    const stored = ctx.deferredPromptStore!.get(created.deferredPromptId);
    expect(stored!.status).toBe("pending");
  });

  it("does not report running deferrals as cancellable", async () => {
    const { ctx } = createTestApp();
    const cancelTool = findTool(createBridgeTools(ctx), "defer_cancel");
    const stored = ctx.deferredPromptStore!.create("session-A", "already dispatching", new Date().toISOString());
    ctx.deferredPromptStore!.claimDue(stored.id, 60_000);

    const text = expectFailure(
      await cancelTool.handler({ deferredPromptId: stored.id }, makeInvocation("session-A")),
    );

    expect(text).toContain("is running and cannot be cancelled");
    expect(ctx.deferredPromptStore!.get(stored.id)!.status).toBe("running");
  });

  it("rejects missing invocation session", async () => {
    const { ctx } = createTestApp();
    const cancelTool = findTool(createBridgeTools(ctx), "defer_cancel");
    const result = await cancelTool.handler({ deferredPromptId: "any-id" }, makeInvocation(undefined));
    expect(result).toEqual(toolFailure("No active session — defer_cancel requires an invocation session."));
  });

  it("fails for unknown deferral ID", async () => {
    const { ctx } = createTestApp();
    const cancelTool = findTool(createBridgeTools(ctx), "defer_cancel");
    const text = expectFailure(await cancelTool.handler({ deferredPromptId: "does-not-exist" }, makeInvocation("s1")));
    expect(text).toContain("not found");
  });
});
