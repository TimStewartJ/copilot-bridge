import { describe, expect, it } from "vitest";
import type { PlaybookInfo } from "../../shared/workflow-vocabulary.js";
import { groupPlaybooksByFamily, playbookViewLabel } from "./playbooks";

function playbook(id: string, label: string, family: PlaybookInfo["family"]): PlaybookInfo {
  return { id, label, description: "", family, evidence: [], source: "bundled" };
}

describe("playbooks", () => {
  it("groups by family in vocabulary order, sorts by label and skips empty families", () => {
    const groups = groupPlaybooksByFamily([
      playbook("watch", "Watch", "ongoing"),
      playbook("research", "Research", "knowledge"),
      playbook("refactor", "Refactor", "code"),
      playbook("bug-fix", "Bug fix", "code"),
    ]);
    expect(groups.map((group) => [group.label, group.playbooks.map((entry) => entry.id)])).toEqual([
      ["Code", ["bug-fix", "refactor"]],
      ["Knowledge work", ["research"]],
      ["Ongoing", ["watch"]],
    ]);
  });

  it.each([
    [undefined, undefined],
    [{}, undefined],
    [{ playbook: "none", source: "user" as const }, "Direct"],
    [{ playbook: "bug-fix", source: "agent" as const, label: "Bug fix" }, "Bug fix"],
    [{ playbook: "research", source: "task" as const }, "Research"],
    [{ playbook: "gone", source: "task" as const }, "gone"],
  ])("labels %j as %s", (view, expected) => {
    expect(playbookViewLabel(view, [playbook("research", "Research", "knowledge")])).toBe(expected);
  });
});
