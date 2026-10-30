import { describe, expect, it, vi } from "vitest";
import type { ChecklistItem } from "../checklist-store.js";
import { createDocsStore } from "../docs-store.js";
import type { Task } from "../task-store.js";
import type { TaskHistoryEntry } from "../task-history-store.js";
import {
  BRIDGE_CONTEXT_HISTORY_ENTRIES,
  buildBridgeContextSections,
  emptyBridgeContextHashes,
  PLACEHOLDER_TITLE_GUIDANCE,
  renderBridgeContextBlock,
  type BridgeContextDeps,
} from "../session-context-block.js";
import { PLACEHOLDER_TASK_TITLE } from "../task-store.js";
import { makeTestDir } from "./helpers.js";

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Find a rental",
    kind: "task",
    muted: false,
    deferred: false,
    status: "active",
    notes: "",
    instructions: "",
    priority: 0,
    order: 0,
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    sessionIds: [],
    workItems: [],
    pullRequests: [],
    ...overrides,
  } as Task;
}

function checklistItem(overrides: Partial<ChecklistItem> = {}): ChecklistItem {
  return {
    id: "check",
    taskId: "task-1",
    text: "Review",
    done: false,
    order: 0,
    createdAt: "2026-04-01T00:00:00.000Z",
    ...overrides,
  };
}

function historyStore(entries: Array<Pick<TaskHistoryEntry, "at" | "text">>): NonNullable<BridgeContextDeps["taskHistoryStore"]> {
  return {
    countEntries: () => entries.length,
    listEntries: (_taskId, options) => entries.slice(0, options?.limit ?? 20).map((entry, index) => ({
      id: entries.length - index, taskId: "task-1", source: "agent" as const, ...entry,
    })),
  };
}

function sectionContent(deps: BridgeContextDeps, task: Task | null, name: string): string {
  return buildBridgeContextSections(deps, task).find((section) => section.name === name)?.content ?? "";
}

describe("bridge context sections", () => {
  it("renders a task's changing state in task_state and its notes in task_notes", () => {
    const checklistStore = { listChecklistItems: () => [
      checklistItem({ id: "c1", text: "Call the landlord", deadline: "2026-04-02" }),
      checklistItem({ id: "c2", text: "Pick neighborhoods", done: true }),
    ] };
    const task = createTask({
      notes: "Two strong leads.",
      nextAction: "Tour 2040 Main",
      workItems: [{ id: "ABC-1", provider: "linear" }],
      pullRequests: [{ repoId: "r", repoName: "owner/repo", prId: 42, provider: "github" }],
    });

    const [state, notes] = buildBridgeContextSections({ checklistStore }, task, { groupName: "Home", notes: "Budget $3k" });
    const content = state!.content;

    expect(content.startsWith("<task_state>\nTask: \"Find a rental\" (taskId: task-1, status: active, kind: task)")).toBe(true);
    expect(content).toContain("Linked work items: #ABC-1 (linear)");
    expect(content).toContain("Linked PRs: owner/repo #42");
    expect(content).toContain("- Next step: Tour 2040 Main");
    expect(content).not.toContain("Two strong leads.");
    expect(notes!.content).toBe([
      "<task_notes>",
      "Task notes (the current state of the work; any rules the user wrote here still apply):\nTwo strong leads.",
      "",
      'Group notes (task group "Home"):\nBudget $3k',
      "</task_notes>",
    ].join("\n"));
    expect(content).toContain("Checklist: 1 open, 1 completed. Use action_list for the full checklist.");
    expect(content).toContain("- [ ] Call the landlord [id: c1] (due 2026-04-02)");
    expect(content).not.toContain("Pick neighborhoods");
    expect(content.endsWith("</task_state>")).toBe(true);
    // Instructions live in the system prompt, not in the changing state.
    expect(sectionContent({}, createTask({ instructions: "Never email" }), "task_state")).not.toContain("Never email");
  });

  it("keeps open item order and full task requirements without replaying completed text", () => {
    const completedText = "An old investigation is complete. ".repeat(100);
    const items = [
      checklistItem({ id: "second", text: "Second in the saved order", deadline: "2026-04-02" }),
      checklistItem({ id: "done", text: completedText, done: true }),
      checklistItem({ id: "first", text: "First by name, last in the saved order", order: 2 }),
    ];
    const before = structuredClone(items);
    const task = createTask({
      doneWhen: "The user reviews the preview and deployment is verified.",
    });
    const content = sectionContent({ checklistStore: { listChecklistItems: () => items } }, task, "task_state");

    expect(content).toContain("Checklist: 2 open, 1 completed.");
    expect(content).toContain("- [ ] Second in the saved order [id: second] (due 2026-04-02)\n- [ ] First by name, last in the saved order [id: first]");
    expect(content).not.toContain(completedText);
    expect(content).toContain(`- Done when: ${task.doneWhen}`);
    expect(items).toEqual(before);
  });

  it("reports all-completed and empty checklists without implying task completion", () => {
    const task = createTask({ doneWhen: "Production validation has passed." });
    const completed = checklistItem({ text: "Implement the change", done: true });
    const content = sectionContent({ checklistStore: { listChecklistItems: () => [completed] } }, task, "task_state");

    expect(content).toContain("status: active");
    expect(content).toContain("- Done when: Production validation has passed.");
    expect(content).toContain("Checklist: 0 open, 1 completed. Use action_list for the full checklist.");
    expect(content).not.toContain("Implement the change");
    expect(content).not.toContain("- [");
    expect(sectionContent({ checklistStore: { listChecklistItems: () => [] } }, task, "task_state"))
      .not.toContain("Checklist:");
  });

  it("changes the context hash on completion and reopening, not edits to hidden completed text", () => {
    const item = checklistItem({ text: "Review the preview" });
    const deps = { checklistStore: { listChecklistItems: () => [item] } };
    const task = createTask();
    const open = buildBridgeContextSections(deps, task)[0]!;
    item.done = true;
    const complete = buildBridgeContextSections(deps, task)[0]!;
    expect(complete.hash).not.toBe(open.hash);
    expect(complete.content).not.toContain(item.text);

    item.text = "Review the updated preview";
    expect(buildBridgeContextSections(deps, task)[0]!.hash).toBe(complete.hash);
    item.done = false;
    const reopened = buildBridgeContextSections(deps, task)[0]!;
    expect(reopened.hash).not.toBe(complete.hash);
    expect(reopened.content).toContain("- [ ] Review the updated preview [id: check]");
  });

  it("lists the latest history entries on one line each and points at the tool for the rest", () => {
    const long = `Toured the unit\nand ${"x".repeat(400)}`;
    const entries = [
      { at: "2026-09-26T10:00:00.000Z", text: long },
      { at: "2026-09-25T10:00:00.000Z", text: "Second" },
      { at: "2026-09-24T10:00:00.000Z", text: "Third" },
      { at: "2026-09-23T10:00:00.000Z", text: "Fourth" },
    ];
    const content = sectionContent({ taskHistoryStore: historyStore(entries) }, createTask(), "task_state");

    expect(content).toContain("History: 4 entries, newest first. Use task_history_list for more or to search.");
    const lines = content.split("\n").filter((line) => /^- 2026-/.test(line));
    expect(lines).toHaveLength(BRIDGE_CONTEXT_HISTORY_ENTRIES);
    expect(lines[0]!.startsWith("- 2026-09-26: Toured the unit and x")).toBe(true);
    expect(lines[0]!.length).toBeLessThanOrEqual("- 2026-09-26: ".length + 200);
    expect(lines[0]!.endsWith("…")).toBe(true);
    expect(content).not.toContain("Fourth");
    expect(sectionContent({ taskHistoryStore: historyStore([]) }, createTask(), "task_state")).not.toContain("History:");
  });

  it("asks for a title only while the task still has the placeholder title", () => {
    const placeholder = buildBridgeContextSections({}, createTask({ title: PLACEHOLDER_TASK_TITLE }))[0]!;
    const named = buildBridgeContextSections({}, createTask({ title: "Find a rental" }))[0]!;

    expect(placeholder.content).toContain(PLACEHOLDER_TITLE_GUIDANCE);
    expect(named.content).not.toContain(PLACEHOLDER_TITLE_GUIDANCE);
    // Renaming changes the section, so the next block replaces the one that carried the guidance.
    expect(named.hash).not.toBe(placeholder.hash);
  });

  it("hashes each section independently so only the changed one is resent", () => {
    const docsStore = createDocsStore(makeTestDir("context-block-docs"));
    docsStore.writePage("runbooks/deploy", "# Deploy");
    const build = (task: Task | null) => buildBridgeContextSections({ docsStore }, task);
    const hashes = (task: Task | null) => build(task).map((section) => section.hash);
    const before = hashes(createTask({ notes: "first" }));

    expect(build(null).map((section) => section.name)).toEqual(["task_state", "task_notes", "knowledge_base"]);
    expect(hashes(createTask({ notes: "first" }))).toEqual(before);
    // A new next step leaves the notes alone; new notes leave the rest of the state alone.
    const moved = hashes(createTask({ notes: "first", nextAction: "Call the landlord" }));
    expect([moved[0] !== before[0], moved[1] !== before[1], moved[2] !== before[2]]).toEqual([true, false, false]);
    const edited = hashes(createTask({ notes: "second" }));
    expect([edited[0] !== before[0], edited[1] !== before[1], edited[2] !== before[2]]).toEqual([false, true, false]);
    // Every section is always present, so leaving a task or emptying the docs is just a change.
    const detached = buildBridgeContextSections({}, null);
    expect(detached.map((section) => section.content)).toEqual([
      "<task_state>\nThis chat is not linked to a Bridge task.\n</task_state>",
      "<task_notes>\nThis chat is not linked to a Bridge task.\n</task_notes>",
      "<knowledge_base>\nThe knowledge base is empty.\n</knowledge_base>",
    ]);
    expect([...emptyBridgeContextHashes().values()]).toEqual(detached.map((section) => section.hash));
    // Linked notes that were emptied differ from the starting point, so a chat is told after a restart.
    expect(sectionContent({}, createTask({ notes: "" }), "task_notes")).toBe("<task_notes>\nThis task has no notes.\n</task_notes>");
  });

  it("keeps deadline rendering stable as the clock crosses follow-up and checklist deadlines", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const checklistStore = { listChecklistItems: () => [
        checklistItem({ deadline: "2026-04-02" }),
      ] };
      const task = createTask({ nextTouchAt: "2026-04-02T12:00:00Z" });
      vi.setSystemTime(new Date("2026-04-01T00:00:00Z"));
      const before = buildBridgeContextSections({ checklistStore }, task);
      vi.setSystemTime(new Date("2026-04-04T00:00:00Z"));
      expect(buildBridgeContextSections({ checklistStore }, task)).toEqual(before);
      expect(before[0]!.content).toContain("2026-04-02T12:00:00Z");
      expect(before[0]!.content).toContain("(due 2026-04-02)");
      expect(before[0]!.content).not.toMatch(/OVERDUE|upcoming|\(due\)|\(overdue\)/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps database schema context stable when collection entries change without scanning entries", () => {
    const docsStore = createDocsStore(makeTestDir("context-block-db"));
    docsStore.writeSchema("notes", { name: "Notes", fields: [{ name: "title", type: "text" }] });
    const scan = vi.spyOn(docsStore, "listDbEntries");
    const before = buildBridgeContextSections({ docsStore }, null);
    docsStore.addDbEntry("notes", { title: "First note" });
    docsStore.addDbEntry("notes", { title: "Second note" });
    expect(buildBridgeContextSections({ docsStore }, null)).toEqual(before);
    expect(before[2]!.content).toContain('notes/ "Notes": title (text)');
    expect(scan).not.toHaveBeenCalled();
  });
});

describe("bridge context block", () => {
  it("wraps changed sections with a note that Bridge, not the user, added them", () => {
    const [section] = buildBridgeContextSections({}, createTask());
    const block = renderBridgeContextBlock([section!]);
    expect(block).toBe([
      "<bridge_context>",
      "Copilot Bridge added this block with the latest state; the user did not type it. Each section replaces any earlier section with the same name.",
      section!.content,
      "</bridge_context>",
    ].join("\n"));
    expect(renderBridgeContextBlock([])).toBeUndefined();
  });

});
