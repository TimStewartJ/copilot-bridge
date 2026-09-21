import { beforeEach, describe, expect, it, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createManagementJobStore } from "../management-job-store.js";
import { createSelfAdminToolDefinitions } from "../tools/self-admin-tools.js";
import type { ToolInvocation } from "@github/copilot-sdk";
import { createTestApp } from "./test-app.js";

const requestRestartMock = vi.hoisted(() => vi.fn());
vi.mock("../restart-signal.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../restart-signal.js")>(),
  requestRestart: requestRestartMock,
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const { withTestSourceCheckout } = await import("./test-paths.js");
  return { ...actual, existsSync: withTestSourceCheckout(actual.existsSync) };
});

beforeEach(() => {
  requestRestartMock.mockReset().mockResolvedValue({ requestedAt: "2026-09-20T17:00:00Z", validationMode: "operational" });
});

function setup(name: string) {
  const { ctx, db } = createTestApp();
  ctx.managementJobStore = createManagementJobStore(db, { dataDir: ctx.runtimePaths!.dataDir });
  const tool = createSelfAdminToolDefinitions(ctx).find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`${name} tool is missing`);
  const invocation = { sessionId: "session-a", toolCallId: "tool-a", toolName: name, arguments: {} } satisfies ToolInvocation;
  return { ctx, tool, invocation };
}

function resultRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a tool result object");
  return Object.fromEntries(Object.entries(value));
}

describe("self-admin restart requests", () => {
  it("requests a background restart even while a deploy is queued", async () => {
    const { ctx, tool, invocation } = setup("self_restart");
    ctx.managementJobStore!.enqueue("staging_deploy", { stagingDir: "worktree" });
    const result = resultRecord(await tool.handler({}, invocation));
    expect(result).toMatchObject({ success: true, toolNextAction: "proceed" });
    expect(result.terminal).not.toBe(true);
    expect(result.message).toContain("keep working normally");
    expect(result.message).not.toContain("Stop issuing tools");
    expect(requestRestartMock).toHaveBeenCalledWith(ctx.runtimePaths!.dataDir, {
      validationMode: "operational", source: "self_restart",
    });
  });

  it("does not treat a pending or claimed restart as a tool failure", async () => {
    const { ctx, tool, invocation } = setup("self_restart");
    await writeFile(join(ctx.runtimePaths!.dataDir, "restart-in-progress.json"), "{}");
    await expect(tool.handler({}, invocation)).resolves.toMatchObject({ success: true });
    await expect(tool.handler({}, invocation)).resolves.toMatchObject({ success: true });
    expect(requestRestartMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces a failed restart request rather than reporting success", async () => {
    const { tool, invocation } = setup("self_restart");
    requestRestartMock.mockRejectedValueOnce(new Error("disk full"));
    const result = resultRecord(await tool.handler({}, invocation));
    expect(result.resultType).toBe("failure");
    expect(result.textResultForLlm).toContain("disk full");
  });

  it("enqueues self-update while a restart is pending without doing update work in the handler", async () => {
    const { ctx, tool, invocation } = setup("self_update");
    await writeFile(join(ctx.runtimePaths!.dataDir, "restart.signal"), "{}");
    const result = resultRecord(await tool.handler({}, invocation));
    expect(result).toMatchObject({ success: true, status: "queued", jobId: expect.any(String) });
    expect(ctx.managementJobStore!.listActive(["self_update"])).toHaveLength(1);
    expect(requestRestartMock).not.toHaveBeenCalled();
  });

  it("keeps the checkout-mutation safety check separate from restart waiting", async () => {
    const { ctx, tool, invocation } = setup("self_update");
    ctx.managementJobStore!.enqueue("staging_deploy", { stagingDir: "worktree" });
    const result = resultRecord(await tool.handler({}, invocation));
    expect(result.resultType).toBe("failure");
    expect(result.textResultForLlm).toContain("same checkout");
    expect(result.terminal).not.toBe(true);
  });
});
