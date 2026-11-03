import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  customizeSkill,
  deleteHomeSkill,
  isValidSkillId,
  readSkill,
  scanSkills,
  writeHomeSkill,
} from "../server/skills-registry.js";
import {
  installApiRouteTestHooks,
  makeTestDir,
  request,
  type ApiRouteTestState,
} from "../test-support/api-routes.js";

function writeSkill(skillsRoot: string, id: string, frontmatter: Record<string, string>, body = "Body text"): void {
  const dir = join(skillsRoot, id);
  mkdirSync(dir, { recursive: true });
  const fm = Object.entries(frontmatter)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
  writeFileSync(join(dir, "SKILL.md"), `---\n${fm}\n---\n\n${body}\n`);
}

describe("skills-registry", () => {
  let copilotHome: string;
  let repoRoot: string;
  let packRoot: string;

  beforeEach(() => {
    copilotHome = join(makeTestDir("skills-home"), ".copilot");
    repoRoot = makeTestDir("skills-repo");
    packRoot = makeTestDir("skills-pack");
    mkdirSync(join(copilotHome, "skills"), { recursive: true });
    mkdirSync(join(repoRoot, "skills"), { recursive: true });
    mkdirSync(join(packRoot, "skills"), { recursive: true });
  });

  const options = () => ({ copilotHome, repoRoot, packs: [{ id: "team", name: "Team pack", root: packRoot }] });

  it("lists home, pack and bundled skills sorted by name, with home over pack over bundled", async () => {
    writeSkill(join(copilotHome, "skills"), "zeta", { name: "Zeta", description: "z skill" });
    writeSkill(join(repoRoot, "skills"), "browser", { name: "Alpha Browser", description: "b skill" });
    writeSkill(join(packRoot, "skills"), "middle", { name: "Middle", description: "m skill" });
    writeSkill(join(copilotHome, "skills"), "dup", { name: "Home Dup" });
    writeSkill(join(packRoot, "skills"), "dup", { name: "Pack Dup" });
    writeSkill(join(repoRoot, "skills"), "dup", { name: "Bundled Dup" });

    const skills = await scanSkills(options());
    expect(skills.map((s) => s.id)).toEqual(["browser", "dup", "middle", "zeta"]);
    expect(skills.find((s) => s.id === "dup")).toMatchObject({ name: "Home Dup", source: "home", editable: true, overrides: ["pack", "bundled"] });
    expect(skills.find((s) => s.id === "middle")).toMatchObject({ source: "pack", packId: "team", packName: "Team pack", editable: false });
    expect(skills.find((s) => s.id === "browser")).toMatchObject({ source: "bundled", editable: false });
  });

  it("parses workflow metadata and drops unknown values", async () => {
    const dir = join(copilotHome, "skills", "fixer");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), [
      "---",
      "name: fixer",
      "description: \"Playbook: fix things.\"",
      "metadata:",
      "  bridge-kind: playbook",
      "  bridge-family: code",
      "  bridge-label: Fixer",
      "  bridge-evidence: reproduced, fixed, vibes",
      "  bridge-compare-previous: \"true\"",
      "  bridge-roles: code-host, astrology",
      "  bridge-extends: bug-fix, ../escape",
      "allowed-tools: Bash(agent-browser:*)",
      "---",
      "Steps",
    ].join("\n"));
    const [skill] = await scanSkills(options());
    expect(skill).toMatchObject({
      kind: "playbook", family: "code", label: "Fixer", evidence: ["reproduced", "fixed"], comparePrevious: true,
      roles: ["code-host"], extends: ["bug-fix"], allowedTools: ["Bash(agent-browser:*)"],
    });
  });

  it("ignores directories without a SKILL.md or with unsafe names, and reads bodies", async () => {
    mkdirSync(join(copilotHome, "skills", "empty"), { recursive: true });
    writeSkill(join(copilotHome, "skills"), "bad name", { name: "Bad" });
    expect(await scanSkills({ copilotHome, repoRoot })).toHaveLength(0);

    writeSkill(join(copilotHome, "skills"), "alpha", { name: "Alpha", description: "d" }, "# Heading\n\ncontent");
    const detail = await readSkill({ copilotHome, repoRoot }, "alpha");
    expect(detail).toMatchObject({ id: "alpha", name: "Alpha", source: "home" });
    expect(detail?.body).toContain("# Heading");
    expect(detail?.raw).toContain("name: Alpha");
    expect(await readSkill({ copilotHome, repoRoot }, "missing")).toBeNull();
    expect(await readSkill({ copilotHome, repoRoot }, "../escape")).toBeNull();
  });

  it("edits only home skills and validates the frontmatter", async () => {
    writeSkill(join(copilotHome, "skills"), "alpha", { name: "alpha", description: "d" });
    writeSkill(join(repoRoot, "skills"), "browser", { name: "browser", description: "b" });
    const raw = "---\nname: alpha\ndescription: updated\n---\nNew body\n";
    expect(await writeHomeSkill(options(), "alpha", raw)).toMatchObject({ status: "written", skill: { description: "updated" } });
    expect(await writeHomeSkill(options(), "browser", raw)).toEqual({ status: "not-found" });
    for (const [bad, message] of [
      ["no frontmatter", /start with YAML/],
      ["---\nname: other\ndescription: d\n---\n", /match the folder/],
      ["---\nname: alpha\n---\n", /description/],
      ["---\nname: [unclosed\n---\n", /not valid YAML/],
    ] as const) {
      const result = await writeHomeSkill(options(), "alpha", bad);
      expect(result.status).toBe("invalid");
      expect(result.status === "invalid" ? result.error : "").toMatch(message);
    }
    expect(readFileSync(join(copilotHome, "skills", "alpha", "SKILL.md"), "utf-8")).toBe(raw);
  });

  it("customizes a bundled skill into a home copy that overrides it until deleted", async () => {
    writeSkill(join(repoRoot, "skills"), "watch", { name: "watch", description: "bundled" });
    expect(await customizeSkill(options(), "watch")).toMatchObject({ status: "written", skill: { source: "home", overrides: ["bundled"] } });
    expect(await customizeSkill(options(), "watch")).toEqual({ status: "exists" });
    expect(await customizeSkill(options(), "missing")).toEqual({ status: "not-found" });
    expect(await deleteHomeSkill({ copilotHome, id: "watch" })).toBe("deleted");
    expect(await readSkill(options(), "watch")).toMatchObject({ source: "bundled" });
    // Bundled-only skills are not reachable through the home delete path.
    expect(await deleteHomeSkill({ copilotHome, id: "watch" })).toBe("not-found");
    expect(existsSync(join(repoRoot, "skills", "watch"))).toBe(true);
  });

  it("rejects unsafe ids without touching the filesystem", async () => {
    const sibling = makeTestDir("skills-sibling");
    mkdirSync(join(sibling, "victim"), { recursive: true });
    writeFileSync(join(sibling, "victim", "SKILL.md"), "secret");

    for (const id of ["..", "../victim", "a/b", "a\\b", " ", "alpha ", " alpha"]) {
      expect(isValidSkillId(id)).toBe(false);
      expect(await deleteHomeSkill({ copilotHome, id })).toBe("invalid");
      expect((await writeHomeSkill(options(), id, "---\nname: x\n---\n")).status).toBe("invalid");
    }
    expect(existsSync(join(sibling, "victim", "SKILL.md"))).toBe(true);
  });
});

describe("skill routes", () => {
  let app: ApiRouteTestState["app"];
  let ctx: ApiRouteTestState["ctx"];

  installApiRouteTestHooks((state) => {
    ({ app, ctx } = state);
  });

  const homeSkills = () => join(ctx.copilotHome!, "skills");

  it("lists skills with usage and serves the playbook catalog", async () => {
    writeSkill(homeSkills(), "my-skill", { name: "my-skill", description: "test desc" });
    writeSkill(homeSkills(), "my-playbook", {
      name: "my-playbook",
      description: "\"Playbook: do a thing.\"",
      metadata: "\n  bridge-kind: playbook\n  bridge-family: knowledge\n  bridge-label: My playbook",
    });
    ctx.skillUsageStore?.record("my-skill", "session-1");
    ctx.skillUsageStore?.record("my-skill", "session-2");
    const res = await request(app).get("/api/skills");
    expect(res.status).toBe(200);
    expect(res.body.skills.find((s: { id: string }) => s.id === "my-skill")).toMatchObject({ source: "home", useCount: 2 });

    const playbooks = await request(app).get("/api/playbooks");
    expect(playbooks.body.playbooks).toContainEqual(expect.objectContaining({
      id: "my-playbook", label: "My playbook", family: "knowledge", description: "Do a thing.", source: "home",
    }));
  });

  it("reads, edits, customizes and deletes skills with the right status codes", async () => {
    writeSkill(homeSkills(), "my-skill", { name: "my-skill", description: "d" }, "# Hello\n\nworld");
    expect((await request(app).get("/api/skills/my-skill")).body.skill.body).toContain("# Hello");
    expect((await request(app).get("/api/skills/nope")).status).toBe(404);
    expect((await request(app).get("/api/skills/bad%20name")).status).toBe(400);

    const raw = "---\nname: my-skill\ndescription: edited\n---\nBody\n";
    const edited = await request(app).put("/api/skills/my-skill").send({ raw });
    expect(edited.status).toBe(200);
    expect(edited.body.skill.description).toBe("edited");
    expect((await request(app).put("/api/skills/my-skill").send({ raw: "nope" })).status).toBe(400);
    expect((await request(app).put("/api/skills/nope").send({ raw })).status).toBe(404);

    expect((await request(app).post("/api/skills/my-skill/customize")).status).toBe(409);
    const history = await request(app).get("/api/skills/my-skill/history");
    expect(history.body).toEqual({ commits: [], tracked: false });

    expect((await request(app).delete("/api/skills/my-skill")).body.success).toBe(true);
    expect(existsSync(join(homeSkills(), "my-skill"))).toBe(false);
    expect((await request(app).delete("/api/skills/nope")).status).toBe(404);
    expect((await request(app).delete("/api/skills/bad%20name")).status).toBe(400);
  });

  it("lists configured skill packs and refuses to sync an unknown one", async () => {
    const folder = makeTestDir("route-pack");
    writeSkill(join(folder, "skills"), "packed", { name: "packed", description: "p" });
    await request(app).patch("/api/settings").send({
      skillPacks: [{ id: "local", name: "Local pack", source: { kind: "folder", path: folder } }],
    }).expect(200);
    const listed = await request(app).get("/api/skill-packs");
    expect(listed.body.packs).toEqual([{ id: "local", name: "Local pack", source: { kind: "folder", path: folder } }]);
    expect(listed.body.statuses[0]).toMatchObject({ id: "local", state: "ready", skillCount: 1 });
    expect((await request(app).post("/api/skill-packs/missing/sync")).status).toBe(404);
    expect((await request(app).post("/api/skill-packs/local/sync")).body.status).toMatchObject({ state: "ready" });
  });
});
