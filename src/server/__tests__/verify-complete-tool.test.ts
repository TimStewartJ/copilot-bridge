import { describe, expect, it, vi } from "vitest";
import { getBridgeToolDefinitions } from "../agent-tools-mcp/register.js";
import type { SkillCatalog } from "../skill-catalog.js";
import type { SkillSummary } from "../skills-registry.js";
import { createTestApp } from "./test-app.js";

const sessionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function playbook(id: string, label: string, evidence: SkillSummary["evidence"]): SkillSummary {
  return {
    id, name: id, label, description: `Playbook: ${label}`, kind: "playbook", family: "code", evidence,
    comparePrevious: false, roles: [], extends: [], allowedTools: [], source: "bundled",
    skillsDir: "skills", lastModified: null, editable: false, overrides: [],
  };
}

function setup(active?: string) {
  const playbooks = [playbook("bug-fix", "Bug fix", ["reproduced", "fixed"]), playbook("research", "Research", ["sourced"])];
  const skillCatalog = {
    current: () => playbooks,
    playbooks: () => playbooks,
    findPlaybook: (name: string | undefined) => playbooks.find((entry) => entry.id === name),
  } as unknown as SkillCatalog;
  const { app, ctx } = createTestApp({ skillCatalog });
  vi.spyOn(ctx.sessionManager, "getSessionPlaybook").mockReturnValue(active ? { playbook: active, source: "agent" } : undefined);
  const tool = getBridgeToolDefinitions(ctx).find((candidate) => candidate.name === "verify_complete");
  if (!tool) throw new Error("verify_complete tool not found");
  const call = (args: Record<string, unknown>) =>
    tool.handler(args, { sessionId, toolCallId: "call-1", toolName: "verify_complete", arguments: args }) as Promise<any>;
  return { app, ctx, call };
}

const pass = (kind: string, ref?: string) => ({ kind, claim: `${kind} checked`, result: "pass", ...(ref ? { ref } : {}) });

describe("verify_complete", () => {
  it("rejects a report that lacks the active playbook's required evidence and stores nothing", async () => {
    const { ctx, call } = setup("bug-fix");

    const result = await call({ summary: "Fixed the crash", evidence: [pass("tested"), { ...pass("fixed"), result: "fail" }] });

    expect(result.resultType).toBe("failure");
    expect(result.textResultForLlm).toContain("reproduced (the problem was observed before the change)");
    expect(result.textResultForLlm).not.toContain("fixed (");
    expect(result.textResultForLlm).toMatch(/tell the user what you could not check/);
    expect(ctx.completionReportStore?.listForSession(sessionId)).toEqual([]);
  });

  it.each([
    { evidence: [pass("sourced"), pass("reviewed")], unverified: [], status: "verified" },
    { evidence: [pass("sourced")], unverified: [], notes: ["not pushed; no pull request opened"], status: "verified" },
    { evidence: [pass("sourced"), { ...pass("reviewed"), result: "not_run" }], unverified: [], status: "partial" },
    { evidence: [pass("sourced")], unverified: ["the older archive"], status: "partial" },
    { evidence: [{ ...pass("sourced"), result: "fail" }, { ...pass("live"), result: "not_run" }], unverified: ["x"], status: "failed" },
  ])("records a $status report for a taskless chat without touching task history", async ({ evidence, unverified, notes, status }: any) => {
    const { ctx, call } = setup("research");
    const addEntry = vi.spyOn(ctx.taskHistoryStore!, "addEntry");

    const result = await call({ summary: "  Compared the options  ", evidence, unverified, ...(notes ? { notes } : {}) });

    expect(result).toMatchObject({ success: true, status, playbook: "research", playbookLabel: "Research" });
    const [report] = ctx.completionReportStore!.listForSession(sessionId);
    expect(report).toMatchObject({ id: result.reportId, status, summary: "Compared the options", playbook: "research", unverified, notes: notes ?? [] });
    expect(report?.taskId).toBeUndefined();
    expect(addEntry).not.toHaveBeenCalled();
  });

  it("checks an explicit playbook and adds one history entry to the chat's task", async () => {
    const { ctx, call } = setup();
    const task = ctx.taskStore.createTask("Crash on save");
    ctx.taskStore.linkSession(task.id, sessionId);

    const unknown = await call({ summary: "Done", playbook: "nonexistent", evidence: [pass("tested")] });
    expect(unknown.textResultForLlm).toMatch(/not an installed playbook.*bug-fix, research/);

    const result = await call({
      summary: "Saving no longer crashes",
      playbook: "bug-fix",
      evidence: [pass("reproduced", "npm test -- save.test.ts"), pass("fixed", "https://ci.example.test/run/42")],
    });

    expect(result).toMatchObject({ success: true, status: "verified" });
    expect(ctx.completionReportStore!.listForTask(task.id)).toHaveLength(1);
    const entries = ctx.taskHistoryStore!.listEntries(task.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ source: "agent", sessionId });
    expect(entries[0]?.text).toBe([
      "Verified (verified) Bug fix: Saving no longer crashes",
      "- reproduced: pass, npm test -- save.test.ts",
      "- fixed: pass, https://ci.example.test/run/42",
    ].join("\n"));
  });
});
