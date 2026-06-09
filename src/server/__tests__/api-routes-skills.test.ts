import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deleteHomeSkill,
  isValidSkillId,
  listSkills,
  readSkill,
} from "../skills-registry.js";
import {
  installApiRouteTestHooks,
  makeTestDir,
  request,
  type ApiRouteTestState,
} from "./api-routes-test-helpers.js";

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

  beforeEach(() => {
    copilotHome = join(makeTestDir("skills-home"), ".copilot");
    repoRoot = makeTestDir("skills-repo");
    mkdirSync(join(copilotHome, "skills"), { recursive: true });
    mkdirSync(join(repoRoot, "skills"), { recursive: true });
  });

  it("lists home and bundled skills, sorted by display name", () => {
    writeSkill(join(copilotHome, "skills"), "zeta", { name: "Zeta", description: "z skill" });
    writeSkill(join(repoRoot, "skills"), "browser", { name: "Alpha Browser", description: "b skill" });

    const skills = listSkills({ copilotHome, repoRoot });
    expect(skills.map((s) => s.id)).toEqual(["browser", "zeta"]);
    expect(skills[0]).toMatchObject({ id: "browser", name: "Alpha Browser", source: "bundled" });
    expect(skills[1]).toMatchObject({ id: "zeta", name: "Zeta", source: "home" });
  });

  it("falls back to directory name and parses allowed-tools", () => {
    writeSkill(join(copilotHome, "skills"), "no-name", {
      description: "desc",
      "allowed-tools": "Bash(agent-browser:*)",
    });
    const [skill] = listSkills({ copilotHome, repoRoot });
    expect(skill.name).toBe("no-name");
    expect(skill.allowedTools).toEqual(["Bash(agent-browser:*)"]);
  });

  it("prefers home over bundled when the id exists in both", () => {
    writeSkill(join(copilotHome, "skills"), "dup", { name: "Home Dup" });
    writeSkill(join(repoRoot, "skills"), "dup", { name: "Bundled Dup" });
    const skills = listSkills({ copilotHome, repoRoot });
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({ id: "dup", name: "Home Dup", source: "home" });
  });

  it("ignores directories without a SKILL.md", () => {
    mkdirSync(join(copilotHome, "skills", "empty"), { recursive: true });
    expect(listSkills({ copilotHome, repoRoot })).toHaveLength(0);
  });

  it("ignores directories with unsafe names", () => {
    writeSkill(join(copilotHome, "skills"), "bad name", { name: "Bad" });
    expect(listSkills({ copilotHome, repoRoot })).toHaveLength(0);
  });

  it("reads a skill body and frontmatter", () => {
    writeSkill(join(copilotHome, "skills"), "alpha", { name: "Alpha", description: "d" }, "# Heading\n\ncontent");
    const detail = readSkill({ copilotHome, repoRoot }, "alpha");
    expect(detail).toMatchObject({ id: "alpha", name: "Alpha", source: "home" });
    expect(detail?.body).toContain("# Heading");
    expect(detail?.raw).toContain("name: Alpha");
  });

  it("returns null when reading an unknown or invalid skill", () => {
    expect(readSkill({ copilotHome, repoRoot }, "missing")).toBeNull();
    expect(readSkill({ copilotHome, repoRoot }, "../escape")).toBeNull();
  });

  it("deletes a home skill directory", async () => {
    writeSkill(join(copilotHome, "skills"), "alpha", { name: "Alpha" });
    const result = await deleteHomeSkill({ copilotHome, id: "alpha" });
    expect(result).toBe("deleted");
    expect(existsSync(join(copilotHome, "skills", "alpha"))).toBe(false);
  });

  it("does not delete bundled-only skills via the home path", async () => {
    writeSkill(join(repoRoot, "skills"), "browser", { name: "Browser" });
    const result = await deleteHomeSkill({ copilotHome, id: "browser" });
    expect(result).toBe("not-found");
    expect(existsSync(join(repoRoot, "skills", "browser"))).toBe(true);
  });

  it("reveals the bundled skill again after deleting a shadowing home skill", async () => {
    writeSkill(join(copilotHome, "skills"), "dup", { name: "Home Dup" });
    writeSkill(join(repoRoot, "skills"), "dup", { name: "Bundled Dup" });

    expect(listSkills({ copilotHome, repoRoot })[0]).toMatchObject({ id: "dup", source: "home" });
    expect(await deleteHomeSkill({ copilotHome, id: "dup" })).toBe("deleted");

    const after = listSkills({ copilotHome, repoRoot });
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: "dup", name: "Bundled Dup", source: "bundled" });
    expect(readSkill({ copilotHome, repoRoot }, "dup")).toMatchObject({ source: "bundled" });
  });

  it("rejects unsafe ids without touching the filesystem", async () => {
    const sibling = makeTestDir("skills-sibling");
    mkdirSync(join(sibling, "victim"), { recursive: true });
    writeFileSync(join(sibling, "victim", "SKILL.md"), "secret");

    for (const id of ["..", "../victim", "a/b", "a\\b", " ", "alpha ", " alpha"]) {
      expect(isValidSkillId(id)).toBe(false);
      expect(await deleteHomeSkill({ copilotHome, id })).toBe("invalid");
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

  it("GET /api/skills includes a home skill", async () => {
    writeSkill(homeSkills(), "my-skill", { name: "My Skill", description: "test desc" });
    const res = await request(app).get("/api/skills");
    expect(res.status).toBe(200);
    const skill = res.body.skills.find((s: { id: string }) => s.id === "my-skill");
    expect(skill).toMatchObject({ id: "my-skill", name: "My Skill", source: "home" });
  });

  it("GET /api/skills/:id returns the markdown body", async () => {
    writeSkill(homeSkills(), "my-skill", { name: "My Skill" }, "# Hello\n\nworld");
    const res = await request(app).get("/api/skills/my-skill");
    expect(res.status).toBe(200);
    expect(res.body.skill.body).toContain("# Hello");
  });

  it("GET /api/skills/:id returns 404 for an unknown skill", async () => {
    const res = await request(app).get("/api/skills/nope");
    expect(res.status).toBe(404);
  });

  it("GET /api/skills/:id returns 400 for an invalid id", async () => {
    const res = await request(app).get("/api/skills/bad%20name");
    expect(res.status).toBe(400);
  });

  it("DELETE /api/skills/:id removes a home skill", async () => {
    writeSkill(homeSkills(), "my-skill", { name: "My Skill" });
    const del = await request(app).delete("/api/skills/my-skill");
    expect(del.status).toBe(200);
    expect(del.body.success).toBe(true);
    expect(existsSync(join(homeSkills(), "my-skill"))).toBe(false);
    const after = await request(app).get("/api/skills/my-skill");
    expect(after.status).toBe(404);
  });

  it("DELETE /api/skills/:id returns 404 for an unknown skill", async () => {
    const res = await request(app).delete("/api/skills/nope");
    expect(res.status).toBe(404);
  });

  it("DELETE /api/skills/:id returns 400 for an invalid id", async () => {
    const res = await request(app).delete("/api/skills/bad%20name");
    expect(res.status).toBe(400);
  });
});
