import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createSkillPackManager } from "../skill-packs.js";
import { formatModelRolesBlock } from "../skill-catalog.js";
import { createUnattendedRunStore } from "../unattended-run-store.js";
import { createSettingsStore } from "../settings-store.js";
import { getBridgeToolDefinitions } from "../agent-tools-mcp/register.js";
import type { SkillPackConfig } from "../../shared/skill-packs.js";
import { makeTestDir, setupTestDb } from "./helpers.js";
import { createTestApp } from "./test-app.js";

const SESSION = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function writeSkill(dir: string, id: string): void {
  mkdirSync(join(dir, id), { recursive: true });
  writeFileSync(join(dir, id, "SKILL.md"), `---\nname: ${id}\ndescription: d\n---\nBody\n`);
}

describe("skill pack manager", () => {
  it("clones a new git pack, fetches an existing one, and keeps the last good sync when a fetch fails", async () => {
    const dataDir = makeTestDir("packs-data");
    const pack: SkillPackConfig = { id: "team", name: "Team", source: { kind: "git", url: "https://git.example.com/team/skills.git", ref: "main" } };
    const calls: string[][] = [];
    let fetchFails = false;
    const runGit = vi.fn(async (_cwd: string, args: string[]) => {
      calls.push(args);
      if (args[0] === "clone") writeSkill(join(args.at(-1)!, "skills"), "packed");
      if (args[0] === "clone") mkdirSync(join(args.at(-1)!, ".git"), { recursive: true });
      if (args[0] === "fetch" && fetchFails) return { ok: false as const, error: "network unreachable" };
      if (args[0] === "rev-parse") return { ok: true as const, output: "abc1234" };
      return { ok: true as const, output: "" };
    });
    const onChanged = vi.fn();
    const manager = createSkillPackManager({ dataDir, getPacks: () => [pack], runGit, onChanged, removeTree: async () => {} });

    const cloned = await manager.sync("team");
    expect(calls[0]).toEqual(["clone", "--depth", "1", "--branch", "main", "--", pack.source.kind === "git" ? pack.source.url : "", join(dataDir, "skill-packs", "team")]);
    expect(cloned).toMatchObject({ state: "ready", commit: "abc1234", skillCount: 1 });
    expect(onChanged).toHaveBeenCalledTimes(1);

    await manager.sync("team");
    expect(calls.map((args) => args[0])).toEqual(["clone", "rev-parse", "remote", "fetch", "reset", "rev-parse"]);

    fetchFails = true;
    const failed = await manager.sync("team");
    expect(failed).toMatchObject({ state: "error", commit: "abc1234", error: expect.stringContaining("network unreachable") });
    // A pack with a good earlier checkout keeps loading while its source is unreachable.
    expect(manager.activeRoots().map((root) => root.id)).toEqual(["team"]);
  });

  it("loads untagged packs everywhere and tagged packs only for matching tasks, skipping missing folders", async () => {
    const present = makeTestDir("pack-present");
    const packs: SkillPackConfig[] = [
      { id: "everywhere", name: "Everywhere", source: { kind: "folder", path: present } },
      { id: "work", name: "Work", source: { kind: "folder", path: present }, tags: ["Work"] },
      { id: "off", name: "Off", source: { kind: "folder", path: present }, enabled: false },
      { id: "gone", name: "Gone", source: { kind: "folder", path: join(present, "missing") } },
    ];
    const manager = createSkillPackManager({ dataDir: makeTestDir("packs-data"), getPacks: () => packs });
    const statuses = await manager.listStatuses();
    expect(statuses.find((status) => status.id === "gone")).toMatchObject({ state: "missing" });
    expect(manager.activeRoots().map((root) => root.id)).toEqual(["everywhere"]);
    expect(manager.activeRoots(["work"]).map((root) => root.id)).toEqual(["everywhere", "work"]);
    expect(manager.activeRoots([], { ignoreTags: true }).map((root) => root.id)).toEqual(["everywhere", "work"]);
  });
});

describe("skill pack settings", () => {
  it.each([
    [[{ id: "Bad Id", name: "x", source: { kind: "folder", path: "/x" } }], /lower-case/],
    [[{ id: "a", name: "x", source: { kind: "git", url: "--upload-pack=evil" } }], /git URL/],
    [[{ id: "a", name: "x", source: { kind: "git", url: "https://git.example.com/a.git", ref: "../main" } }], /branch or tag/],
    [[{ id: "a", name: "x", source: { kind: "folder", path: "relative/path" } }], /absolute/],
    [[{ id: "a", name: "x", source: { kind: "folder", path: "/x" } }, { id: "a", name: "y", source: { kind: "folder", path: "/y" } }], /twice/],
  ])("rejects invalid pack %#", (skillPacks, message) => {
    const store = createSettingsStore(setupTestDb());
    expect(() => store.updateSettings({ skillPacks } as never)).toThrow(message);
  });

  it("stores a normalized pack list and clears it with an empty list", () => {
    const store = createSettingsStore(setupTestDb());
    store.updateSettings({ skillPacks: [{ id: "team", name: " Team ", source: { kind: "git", url: "https://git.example.com/a.git" }, enabled: true, tags: ["Work", "Work", " "] }] });
    expect(store.getSettings().skillPacks).toEqual([{ id: "team", name: "Team", source: { kind: "git", url: "https://git.example.com/a.git" }, tags: ["Work"] }]);
    store.updateSettings({ skillPacks: [] });
    expect(store.getSettings().skillPacks).toBeUndefined();
  });
});

describe("model roles block", () => {
  it("lists helpers, reviewers and a panel, and says when the panel has one model family", () => {
    const presets = { preset1: { model: "gpt-fast" }, preset2: { model: "gpt-standard" }, preset3: { model: "claude-deep" } };
    const block = formatModelRolesBlock({ modelPresets: presets, modelRoles: { reviewers: { tier: "preset3" } } })!;
    expect(block).toContain("- helpers (searches, commands, routine sub-tasks): gpt-fast");
    expect(block).toContain("- reviewers (review and judgment): claude-deep");
    expect(block).toContain("The panel covers 2 model families.");
    const single = formatModelRolesBlock({ modelPresets: { preset2: { model: "gpt-standard" } } })!;
    expect(single).toContain("panel review is degraded");
  });
});

describe("unattended runs", () => {
  it("counts automated turns per chat until the user writes or dismisses it", () => {
    const store = createUnattendedRunStore(setupTestDb());
    store.noteTurn("chat-a", "defer", "2026-10-01T08:00:00.000Z");
    store.noteTurn("chat-a", "schedule", "2026-10-01T09:00:00.000Z");
    store.noteTurn("chat-a", "defer", "2026-10-01T10:00:00.000Z");
    expect(store.list()).toEqual([{
      sessionId: "chat-a", turnCount: 3, firstAt: "2026-10-01T08:00:00.000Z", lastAt: "2026-10-01T10:00:00.000Z", origins: ["defer", "schedule"],
    }]);
    store.clear("chat-a");
    expect(store.list()).toEqual([]);
  });
});

describe("playbook_select", () => {
  it("records an installed playbook or the direct path and names what to load", async () => {
    const { ctx } = createTestApp();
    const set = vi.spyOn(ctx.sessionManager, "setSessionPlaybook").mockImplementation(async (_id, playbook, source) => ({
      ...(playbook ? { playbook, source, label: playbook === "none" ? "Direct" : "Research" } : {}),
    }));
    ctx.skillCatalog = {
      ...ctx.skillCatalog!,
      current: () => [{ id: "local-notes", extends: ["research"] }] as never,
      playbooks: () => [{ id: "research" }] as never,
      findPlaybook: (name: string | undefined) => (name === "research" ? { id: "research", evidence: ["sourced"] } as never : undefined),
    };
    const homeSkills = join(ctx.copilotHome!, "skills");
    mkdirSync(join(homeSkills, "research"), { recursive: true });
    writeFileSync(join(homeSkills, "research", "SKILL.md"), "---\nname: research\ndescription: d\n---\n1. Open the canonical source.\n");
    mkdirSync(join(homeSkills, "local-notes"), { recursive: true });
    writeFileSync(join(homeSkills, "local-notes", "SKILL.md"), "---\nname: local-notes\ndescription: d\n---\nSave findings to the team notes.\n");
    const tool = getBridgeToolDefinitions(ctx).find((candidate) => candidate.name === "playbook_select")!;
    const invocation = { sessionId: SESSION, toolCallId: "call-1", toolName: "playbook_select", arguments: {} };

    const picked: any = await tool.handler({ playbook: "research", reason: "Cited answer needed" }, invocation);
    expect(set).toHaveBeenCalledWith(SESSION, "research", "agent");
    expect(picked).toMatchObject({ success: true, playbook: "research", requiredEvidence: ["sourced"], extensions: ["local-notes"] });
    expect(picked.steps).toContain("1. Open the canonical source.");
    expect(picked.steps).toContain("# Added on this machine by local-notes\n\nSave findings to the team notes.");
    expect(picked.steps).toMatch(/# Final step \(required\)\nBefore your final reply, call verify_complete .*it must include sourced/);
    expect(picked.message).toContain("verify_complete with evidence of kind sourced");
    expect(ctx.skillUsageStore!.list().map((usage) => usage.skillName).sort()).toEqual(["local-notes", "research"]);

    // Asking again for the active playbook returns its steps without taking over who chose it.
    vi.spyOn(ctx.sessionManager, "getSessionPlaybook").mockReturnValue({ playbook: "research", source: "user", label: "Research" });
    set.mockClear();
    expect(await tool.handler({ playbook: "research" }, invocation)).toMatchObject({ steps: expect.stringContaining("canonical source") });
    expect(set).not.toHaveBeenCalled();

    // The direct path for one request leaves a playbook the schedule (or user, or task) set in place.
    vi.mocked(ctx.sessionManager.getSessionPlaybook).mockReturnValue({ playbook: "research", source: "schedule", label: "Research" });
    const direct: any = await tool.handler({ playbook: "none" }, invocation);
    expect(direct).toMatchObject({ success: true, playbook: "none" });
    expect(direct.message).toContain("stays on Research, which its schedule chose");
    expect(set).not.toHaveBeenCalled();
    vi.mocked(ctx.sessionManager.getSessionPlaybook).mockReturnValue({});

    expect(await tool.handler({ playbook: "none" }, invocation)).toMatchObject({ success: true, playbook: "none" });
    expect(set).toHaveBeenCalledWith(SESSION, "none", "agent");
    const unknown: any = await tool.handler({ playbook: "astrology" }, invocation);
    expect(JSON.stringify(unknown)).toContain("Installed: research");
  });
});

describe("unattended run routes", () => {
  it("lists runs with their task, starts a review in the chat and dismisses", async () => {
    const { app, ctx } = createTestApp();
    const { default: request } = await import("supertest");
    const task = ctx.taskStore.createTask("Rental watch");
    ctx.taskStore.linkSession(task.id, SESSION);
    ctx.unattendedRunStore!.noteTurn(SESSION, "schedule");
    const listed = await request(app).get("/api/unattended-runs");
    expect(listed.body.runs).toEqual([expect.objectContaining({ sessionId: SESSION, turnCount: 1, taskTitle: "Rental watch" })]);

    const startWork = vi.spyOn(ctx.sessionManager, "startWork");
    await request(app).post(`/api/unattended-runs/${SESSION}/review`).expect(200);
    expect(startWork).toHaveBeenCalledWith(SESSION, "/review-unattended");

    await request(app).delete(`/api/unattended-runs/${SESSION}`).expect(200);
    expect((await request(app).post(`/api/unattended-runs/${SESSION}/review`)).status).toBe(404);
  });
});
