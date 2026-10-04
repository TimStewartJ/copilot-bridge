import { describe, expect, it, vi } from "vitest";
import { getBridgeToolDefinitions } from "../agent-tools-mcp/register.js";
import type { AgentDismissResult, SessionAgentTask } from "../../shared/session-agents.js";
import { AGENT_LIFECYCLE_GUIDANCE } from "../session-instructions.js";
import { createTestApp } from "./test-app.js";

function makeInvocation(sessionId: string | undefined): any {
  return { sessionId, toolCallId: "tc-1", toolName: "test", arguments: {} };
}

function expectFailure(result: unknown): string {
  expect((result as any).resultType).toBe("failure");
  return (result as any).textResultForLlm as string;
}

function agent(id: string, partial: Partial<SessionAgentTask> = {}): SessionAgentTask {
  return { id, status: "idle", executionMode: "background", ...partial };
}

/** A session whose runtime lists the given agents, with the two calls the tools make recorded. */
function setup(tasks: SessionAgentTask[], source: "live" | "lastSeen" | "unknown" = "live") {
  const { ctx } = createTestApp();
  const cancelSessionAgent = vi.fn(async (): Promise<{ cancelled: boolean } | undefined> => ({ cancelled: true }));
  const dismissSessionAgent = vi.fn(async (): Promise<AgentDismissResult> => ({ dismissed: true }));
  ctx.sessionManager.listSessionAgents = vi.fn(async () => ({ tasks, source }));
  ctx.sessionManager.cancelSessionAgent = cancelSessionAgent;
  ctx.sessionManager.dismissSessionAgent = dismissSessionAgent;
  const tools = getBridgeToolDefinitions(ctx);
  const tool = (name: string) => {
    const found = tools.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`Tool "${name}" not found`);
    return found;
  };
  return { ctx, stop: tool("agent_stop"), dismiss: tool("agent_dismiss"), cancelSessionAgent, dismissSessionAgent };
}

describe("agent_stop", () => {
  it("stops a working agent of the calling session, found by ID", async () => {
    const { ctx, stop, cancelSessionAgent } = setup([
      agent("a-lead", { name: "ui-lead", status: "running" }),
      agent("a-docs", { name: "docs" }),
    ]);

    const result = await stop.handler({ agent_id: "a-lead" }, makeInvocation("session-1")) as any;

    expect(ctx.sessionManager.listSessionAgents).toHaveBeenCalledWith("session-1");
    expect(cancelSessionAgent).toHaveBeenCalledWith("session-1", "a-lead");
    expect(result).toMatchObject({ success: true, changed: true, agentId: "a-lead", status: "cancelled" });
    // The caller is told the agent still holds its place, since stopping alone frees nothing.
    expect(result.message).toContain("agent_dismiss");
  });

  it("finds an agent by the name it was launched under, and stops an idle one too", async () => {
    const { stop, cancelSessionAgent } = setup([agent("a-lead", { name: "ui-lead" })]);

    const result = await stop.handler({ agent_id: " ui-lead " }, makeInvocation("session-1")) as any;

    expect(cancelSessionAgent).toHaveBeenCalledWith("session-1", "a-lead");
    expect(result).toMatchObject({ success: true, agentId: "a-lead" });
  });

  it("asks for the ID when two agents share a name", async () => {
    const { stop, cancelSessionAgent } = setup([
      agent("a-1", { name: "writer", status: "running" }),
      agent("a-2", { name: "writer" }),
    ]);

    const message = expectFailure(await stop.handler({ agent_id: "writer" }, makeInvocation("session-1")));

    expect(message).toContain('2 agents are named "writer"');
    expect(message).toContain("a-1 (running)");
    expect(message).toContain("a-2 (idle)");
    expect(cancelSessionAgent).not.toHaveBeenCalled();
  });

  it("names the tracked agents when the one asked for is not among them", async () => {
    const { stop, cancelSessionAgent } = setup([agent("a-docs", { name: "docs" })]);

    const message = expectFailure(await stop.handler({ agent_id: "ui-lead" }, makeInvocation("session-1")));

    expect(message).toContain('No agent with the ID or name "ui-lead"');
    expect(message).toContain("docs (a-docs): idle");
    expect(cancelSessionAgent).not.toHaveBeenCalled();
  });

  it("leaves an agent that has already ended as it is", async () => {
    const { stop, cancelSessionAgent } = setup([agent("a-done", { name: "docs", status: "completed" })]);

    const result = await stop.handler({ agent_id: "docs" }, makeInvocation("session-1")) as any;

    expect(result).toMatchObject({ success: true, changed: false, status: "completed" });
    expect(cancelSessionAgent).not.toHaveBeenCalled();
  });

  it("fails when the runtime did not stop the agent, or the session's agents cannot be read", async () => {
    const working = setup([agent("a-lead", { name: "ui-lead", status: "running" })]);
    working.cancelSessionAgent.mockResolvedValueOnce({ cancelled: false });
    expect(expectFailure(await working.stop.handler({ agent_id: "a-lead" }, makeInvocation("session-1"))))
      .toContain("did not stop ui-lead (a-lead)");
    working.cancelSessionAgent.mockRejectedValueOnce(new Error("task intake is closed"));
    expect(expectFailure(await working.stop.handler({ agent_id: "a-lead" }, makeInvocation("session-1"))))
      .toContain("task intake is closed");

    const stale = setup([agent("a-lead", { status: "running" })], "lastSeen");
    expect(expectFailure(await stale.stop.handler({ agent_id: "a-lead" }, makeInvocation("session-1"))))
      .toContain("cannot be read right now");
    expect(stale.cancelSessionAgent).not.toHaveBeenCalled();
  });

  it("needs a calling session and an agent", async () => {
    const { stop, cancelSessionAgent } = setup([agent("a-lead")]);

    expect(expectFailure(await stop.handler({ agent_id: "a-lead" }, makeInvocation(undefined))))
      .toContain("requires an invoking session");
    expect(expectFailure(await stop.handler({ agent_id: "  " }, makeInvocation("session-1"))))
      .toContain("agent_id must be a non-empty string");
    expect(cancelSessionAgent).not.toHaveBeenCalled();
  });
});

describe("agent_dismiss", () => {
  it("dismisses an agent of the calling session that is not working", async () => {
    const { dismiss, dismissSessionAgent, cancelSessionAgent } = setup([agent("a-docs", { name: "docs" })]);

    const result = await dismiss.handler({ agent_id: "docs" }, makeInvocation("session-1")) as any;

    expect(dismissSessionAgent).toHaveBeenCalledWith("session-1", "a-docs");
    expect(cancelSessionAgent).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: true, agentId: "a-docs" });
    expect(result.message).toContain("no longer counts as a live agent");
  });

  it("refuses a working agent and says to stop it first", async () => {
    const { dismiss, dismissSessionAgent } = setup([agent("a-lead", { name: "ui-lead", status: "running" })]);
    dismissSessionAgent.mockResolvedValueOnce({ dismissed: false, reason: "running" });

    const message = expectFailure(await dismiss.handler({ agent_id: "ui-lead" }, makeInvocation("session-1")));

    expect(message).toContain("ui-lead (a-lead) is working");
    expect(message).toContain("agent_stop");
  });

  it("says an agent that is not listed may have left by itself", async () => {
    // The runtime drops a stopped agent once it was read, which is the usual order of calls.
    const { dismiss, dismissSessionAgent } = setup([]);

    const message = expectFailure(await dismiss.handler({ agent_id: "a-lead" }, makeInvocation("session-1")));

    expect(message).toContain('No agent with the ID or name "a-lead"');
    expect(message).toContain("leaves the list by itself once it is read");
    expect(message).toContain("This session has no tracked agents.");
    expect(dismissSessionAgent).not.toHaveBeenCalled();
  });

  it("treats an agent that left the list in the meantime as done, and reports the other refusals", async () => {
    const { dismiss, dismissSessionAgent } = setup([agent("a-docs", { name: "docs" })]);

    dismissSessionAgent.mockResolvedValueOnce({ dismissed: false, reason: "not-found" });
    expect(await dismiss.handler({ agent_id: "docs" }, makeInvocation("session-1")))
      .toMatchObject({ success: true, changed: false });

    dismissSessionAgent.mockResolvedValueOnce({ dismissed: false, reason: "refused" });
    expect(expectFailure(await dismiss.handler({ agent_id: "docs" }, makeInvocation("session-1"))))
      .toContain("kept docs (a-docs) on its list");

    dismissSessionAgent.mockResolvedValueOnce({ dismissed: false, reason: "unavailable" });
    expect(expectFailure(await dismiss.handler({ agent_id: "docs" }, makeInvocation("session-1"))))
      .toContain("cannot be dismissed right now");

    dismissSessionAgent.mockRejectedValueOnce(new Error("cancel failed"));
    expect(expectFailure(await dismiss.handler({ agent_id: "docs" }, makeInvocation("session-1"))))
      .toContain("Could not dismiss docs (a-docs): cancel failed");
  });
});

describe("agent lifecycle guidance", () => {
  it("names the tools that end an agent, which the runtime's own tools cannot do", () => {
    const { ctx } = createTestApp();
    const names = new Set(getBridgeToolDefinitions(ctx).map((tool) => tool.name));

    for (const name of ["agent_stop", "agent_dismiss"]) {
      expect(names.has(name), name).toBe(true);
      expect(AGENT_LIFECYCLE_GUIDANCE).toContain(name);
    }
    expect(AGENT_LIFECYCLE_GUIDANCE).toContain("is not seen until its current turn ends");
  });
});
