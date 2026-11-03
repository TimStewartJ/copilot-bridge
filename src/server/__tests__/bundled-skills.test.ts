import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import matter from "gray-matter";
import { describe, expect, it } from "vitest";
import {
  isEvidenceKind,
  isPlaybookFamily,
  parseMetadataList,
  type PlaybookFamily,
} from "../../shared/workflow-vocabulary.js";

const SKILLS_DIR = resolve(import.meta.dirname, "..", "..", "..", "skills");

const CONTRACT_PLAYBOOKS: Record<string, PlaybookFamily> = {
  investigate: "code",
  "bug-fix": "code",
  feature: "code",
  refactor: "code",
  "pr-to-merge-ready": "code",
  research: "knowledge",
  write: "knowledge",
  decide: "knowledge",
  "plan-project": "knowledge",
  watch: "ongoing",
  sweep: "ongoing",
  "buy-or-book": "errand",
  "schedule-it": "errand",
  pickup: "meta",
  pause: "meta",
  "unattended-run": "meta",
};
const CONTRACT_HELPERS = ["reflect", "correct", "review-unattended", "panel-review"];

const bundled = readdirSync(SKILLS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(SKILLS_DIR, entry.name, "SKILL.md")))
  .map((entry) => entry.name)
  .sort();

describe("bundled skills", () => {
  it("ships every playbook and helper the workflow contract names", () => {
    expect(bundled).toEqual(expect.arrayContaining([...Object.keys(CONTRACT_PLAYBOOKS), ...CONTRACT_HELPERS]));
  });

  it.each(bundled)("%s has valid frontmatter", (dir) => {
    const raw = readFileSync(join(SKILLS_DIR, dir, "SKILL.md"), "utf8");
    const { data } = matter(raw);
    expect(data.name).toBe(dir);
    expect(typeof data.description).toBe("string");
    const description = (data.description as string).trim();
    expect(description.length).toBeGreaterThan(0);
    expect(description.length).toBeLessThan(1024);

    const metadata = (data.metadata ?? {}) as Record<string, unknown>;
    for (const [key, value] of Object.entries(metadata)) {
      expect(typeof value, `metadata ${key}`).toBe("string");
    }
    expect(metadata["bridge-roles"]).toBeUndefined();
    expect(metadata["bridge-extends"]).toBeUndefined();
    for (const kind of parseMetadataList(metadata["bridge-evidence"])) {
      expect(isEvidenceKind(kind), `evidence kind ${kind}`).toBe(true);
    }

    const contractFamily = CONTRACT_PLAYBOOKS[dir];
    if (contractFamily || CONTRACT_HELPERS.includes(dir) || metadata["bridge-kind"] !== undefined) {
      // Playbook and helper text is copied into todo lists verbatim and follows the plain-prose rule.
      expect(raw.includes("\u2014"), "contains an em dash").toBe(false);
    }
    if (contractFamily || metadata["bridge-kind"] === "playbook") {
      expect(metadata["bridge-kind"]).toBe("playbook");
      expect(isPlaybookFamily(metadata["bridge-family"])).toBe(true);
      if (contractFamily) expect(metadata["bridge-family"]).toBe(contractFamily);
      expect(metadata["bridge-label"]).toEqual(expect.stringMatching(/\S/));
      expect(description.startsWith("Playbook: ")).toBe(true);
    } else if (CONTRACT_HELPERS.includes(dir) || metadata["bridge-kind"] === "helper") {
      expect(metadata["bridge-kind"]).toBe("helper");
      expect(metadata["bridge-label"]).toEqual(expect.stringMatching(/\S/));
      expect(description.startsWith("Helper: ")).toBe(true);
    } else {
      expect(metadata["bridge-kind"]).toBeUndefined();
    }
  });
});
