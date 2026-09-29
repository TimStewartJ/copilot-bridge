import { describe, expect, it, vi } from "vitest";
import type { ChecklistStore } from "../checklist-store.js";
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
  it("renders a task's changing state in one task_state section", () => {
    const checklistStore = { listChecklistItems: () => [
      { id: "c1", text: "Call the landlord", done: false, deadline: "2026-04-02" },
      { id: "c2", text: "Pick neighborhoods", done: true },
    ] } as unknown as ChecklistStore;
    const task = createTask({
      notes: "Two strong leads.",
      nextAction: "Tour 2040 Main",
      workItems: [{ id: "ABC-1", provider: "linear" }],
      pullRequests: [{ repoId: "r", repoName: "owner/repo", prId: 42, provider: "github" }],
    });

    const content = buildBridgeContextSections({ checklistStore }, task, { groupName: "Home", notes: "Budget $3k" })[0]!.content;

    expect(content.startsWith("<task_state>\nTask: \"Find a rental\" (taskId: task-1, status: active, kind: task)")).toBe(true);
    expect(content).toContain("Linked work items: #ABC-1 (linear)");
    expect(content).toContain("Linked PRs: owner/repo #42");
    expect(content).toContain("- Next step: Tour 2040 Main");
    expect(content).toContain("Task notes (the current state of the work; any rules the user wrote here still apply):\nTwo strong leads.");
    expect(content).toContain('Group notes (task group "Home"):\nBudget $3k');
    expect(content).toContain("- [ ] Call the landlord [id: c1] (due 2026-04-02)\n- [x] Pick neighborhoods [id: c2]");
    expect(content.endsWith("</task_state>")).toBe(true);
    // Instructions live in the system prompt, not in the changing state.
    expect(sectionContent({}, createTask({ instructions: "Never email" }), "task_state")).not.toContain("Never email");
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
    const before = buildBridgeContextSections({ docsStore }, createTask({ notes: "first" }));
    const again = buildBridgeContextSections({ docsStore }, createTask({ notes: "first" }));
    const after = buildBridgeContextSections({ docsStore }, createTask({ notes: "second" }));

    expect(before.map((section) => section.name)).toEqual(["task_state", "knowledge_base"]);
    expect(again.map((section) => section.hash)).toEqual(before.map((section) => section.hash));
    expect(after[0]!.hash).not.toBe(before[0]!.hash);
    expect(after[1]!.hash).toBe(before[1]!.hash);
    // Both sections are always present, so leaving a task or emptying the docs is just a change.
    const detached = buildBridgeContextSections({}, null);
    expect(detached.map((section) => section.content)).toEqual([
      "<task_state>\nThis chat is not linked to a Bridge task.\n</task_state>",
      "<knowledge_base>\nThe knowledge base is empty.\n</knowledge_base>",
    ]);
    expect(detached[0]!.hash).not.toBe(before[0]!.hash);
    expect([...emptyBridgeContextHashes().values()]).toEqual(detached.map((section) => section.hash));
  });

  it("keeps deadline rendering stable as the clock crosses follow-up and checklist deadlines", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const checklistStore = { listChecklistItems: () => [
        { id: "check", text: "Review", done: false, deadline: "2026-04-02" },
      ] } as unknown as ChecklistStore;
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
    expect(before[1]!.content).toContain('notes/ "Notes": title (text)');
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
