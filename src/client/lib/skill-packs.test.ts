import { describe, expect, it } from "vitest";
import type { SkillPackConfig } from "../../shared/skill-packs.js";
import { buildSkillPack, EMPTY_SKILL_PACK_FORM, uniqueSkillPackId } from "./skill-packs";

function pack(id: string): SkillPackConfig {
  return { id, name: id, source: { kind: "folder", path: "/srv/skills" } };
}

describe("skill packs", () => {
  it("makes an id from the name that no pack uses yet", () => {
    expect(uniqueSkillPackId("Team Skills", [])).toBe("team-skills");
    expect(uniqueSkillPackId("Team Skills", ["team-skills", "team-skills-2"])).toBe("team-skills-3");
    const long = "a".repeat(40);
    expect(uniqueSkillPackId(long, [long])).toBe(`${"a".repeat(38)}-2`);
  });

  it.each([
    [{ name: " " }, "Name the pack."],
    [{ name: "Tools", url: "-c core.sshCommand=x" }, "Use an https://, ssh://, git@ or file:// URL."],
    [{ name: "Tools", url: "https://git.example.com/skills.git", ref: "../main" }, "That branch or tag name is not valid."],
    [{ name: "Tools", kind: "folder" as const, path: "relative/skills" }, "Use an absolute folder path."],
  ])("rejects %j", (changes, error) => {
    expect(buildSkillPack({ ...EMPTY_SKILL_PACK_FORM, ...changes }, [])).toEqual({ error });
  });

  it("builds a git pack with a deduplicated id, trimmed ref and tags", () => {
    expect(buildSkillPack({
      ...EMPTY_SKILL_PACK_FORM,
      name: "Tools",
      url: " https://git.example.com/skills.git ",
      ref: " release ",
      tags: ["work", "work", " "],
    }, [pack("tools")])).toEqual({
      pack: {
        id: "tools-2",
        name: "Tools",
        source: { kind: "git", url: "https://git.example.com/skills.git", ref: "release" },
        tags: ["work"],
      },
    });
  });

  it("refuses a pack past the limit", () => {
    const full = Array.from({ length: 20 }, (_, index) => pack(`p${index}`));
    expect(buildSkillPack({ ...EMPTY_SKILL_PACK_FORM, name: "More", kind: "folder", path: "/srv/more" }, full))
      .toEqual({ error: "At most 20 packs." });
  });
});
