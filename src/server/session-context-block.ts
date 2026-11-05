import { createHash } from "node:crypto";
import type { ChecklistStore } from "./checklist-store.js";
import type { DocsIndex } from "./docs-index.js";
import type { DocsStore } from "./docs-store.js";
import type { TagStore } from "./tag-store.js";
import { PLACEHOLDER_TASK_TITLE, type Task } from "./task-store.js";
import type { TaskHistoryStore } from "./task-history-store.js";
import { escapePromptLiteral, formatLinkedPullRequest, formatRelatedDocManifestEntry } from "./session-formatting.js";
import { sliceTaskNotes, TASK_NOTES_BRIEF_LENGTH, taskNotesRevision, type TaskNotesSource } from "./task-note-pages.js";
import { formatTaskMomentumContext } from "./session-task-momentum.js";
import { NO_PLAYBOOK, type PlaybookSource } from "../shared/workflow-vocabulary.js";

/**
 * Task and knowledge-base state that changes while a chat runs. It travels at the start of user
 * messages instead of in the system prompt, so edits never invalidate the cached conversation and
 * reach cached chats on their next message. Every section is always present, so a chat that
 * leaves its task or loses its knowledge base is told so like any other change, and each section
 * is resent only when it changes. Notes have a section of their own: a new history line or
 * next step doesn't resend the notes, and a change beyond an excerpt still changes its revision.
 */
export type BridgeContextSectionName = "task_state" | "task_notes" | "knowledge_base" | "playbook";

export interface BridgeContextSection {
  name: BridgeContextSectionName;
  content: string;
  hash: string;
}

export interface BridgeContextDeps {
  checklistStore?: Pick<ChecklistStore, "listChecklistItems">;
  tagStore?: Pick<TagStore, "getEffectiveTaskTags">;
  docsIndex?: Pick<DocsIndex, "findDocsByTagNames">;
  docsStore?: Pick<DocsStore, "readPage">;
  taskHistoryStore?: Pick<TaskHistoryStore, "listEntries" | "countEntries">;
}

export const BRIDGE_CONTEXT_HISTORY_ENTRIES = 3;
/**
 * Lives in task_state rather than the system prompt so it disappears once the task has a real
 * title: the renamed state replaces this section, and sub-agents never receive it.
 */
export const PLACEHOLDER_TITLE_GUIDANCE = `This task still has the placeholder title "${PLACEHOLDER_TASK_TITLE}". After reading the user's message, use task_update to give it a concise, descriptive title (3-6 words). Do this silently without mentioning it to the user.`;
const HISTORY_LINE_LENGTH = 200;

const RELATED_DOCS_LIMIT = 3;

function oneLine(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

function section(name: BridgeContextSectionName, lines: string[], empty: string): BridgeContextSection {
  const body = lines.filter((line) => line.trim()).join("\n\n") || empty;
  const content = `<${name}>\n${body}\n</${name}>`;
  return { name, content, hash: createHash("sha256").update(content).digest("hex") };
}

function buildTaskState(deps: BridgeContextDeps, task: Task | null | undefined): BridgeContextSection {
  if (!task) return section("task_state", [], "This chat is not linked to a Bridge task.");
  const lines: string[] = [`Task: "${task.title}" (taskId: ${task.id}, status: ${task.status}, kind: ${task.kind})`];
  if (task.title === PLACEHOLDER_TASK_TITLE) lines.push(PLACEHOLDER_TITLE_GUIDANCE);
  if (task.workItems.length > 0) {
    lines.push(`Linked work items: ${task.workItems.map((w) => `#${w.id} (${w.provider})`).join(", ")}`);
  }
  if (task.pullRequests.length > 0) {
    lines.push(`Linked PRs: ${task.pullRequests.map(formatLinkedPullRequest).join(", ")}`);
  }
  const momentum = formatTaskMomentumContext(task);
  if (momentum) lines.push(momentum);
  const checklist = deps.checklistStore?.listChecklistItems(task.id) ?? [];
  if (checklist.length > 0) {
    const open = checklist.filter((item) => !item.done);
    lines.push([
      `Checklist: ${open.length} open, ${checklist.length - open.length} completed. Use action_list for the full checklist.`,
      ...open.map((item) => (
        `- [ ] ${item.text} [id: ${item.id}]${item.deadline ? ` (due ${item.deadline})` : ""}`
      )),
    ].join("\n"));
  }
  const historyTotal = deps.taskHistoryStore?.countEntries(task.id) ?? 0;
  if (historyTotal > 0) {
    const recent = deps.taskHistoryStore?.listEntries(task.id, { limit: BRIDGE_CONTEXT_HISTORY_ENTRIES }) ?? [];
    lines.push([
      `History: ${historyTotal} ${historyTotal === 1 ? "entry" : "entries"}, newest first. Use task_history_list for more or to search.`,
      ...recent.map((entry) => `- ${entry.at.slice(0, 10)}: ${oneLine(entry.text, HISTORY_LINE_LENGTH)}`),
    ].join("\n"));
  }
  return section("task_state", lines, "");
}

// A linked task without notes must not read like a chat without a task: that text is the
// ledger's starting point, so after a restart a chat whose notes were cleared would not be told.
const NO_TASK_NOTES = "This chat is not linked to a Bridge task.";
const EMPTY_TASK_NOTES = "This task has no notes.";

function buildTaskNotes(
  task: Task | null | undefined,
  groupNotes: { groupName: string; notes: string } | null | undefined,
): BridgeContextSection {
  if (!task) return section("task_notes", [], NO_TASK_NOTES);
  const lines: string[] = [];
  let hasExcerpt = false;
  function addNotes(source: TaskNotesSource, label: string, raw: string) {
    if (!raw.trim()) return;
    if (raw.length <= TASK_NOTES_BRIEF_LENGTH) {
      lines.push(`${label}:\n${raw.trim()}`);
    } else {
      hasExcerpt = true;
      // Cut the stored text, not a trimmed copy, so nextOffset continues where this stops.
      const shown = sliceTaskNotes(raw, 0, TASK_NOTES_BRIEF_LENGTH);
      lines.push(`${label} [first ${shown.length} of ${raw.length} characters, revision ${taskNotesRevision(raw)}, notesSource: "${source}", nextOffset: ${shown.length}]:\n${shown.trim()}…`);
    }
  }
  addNotes("task", "Task notes (the current state of the work; any rules the user wrote here still apply)", task.notes);
  if (groupNotes) addNotes("group", `Group notes (task group "${escapePromptLiteral(oneLine(groupNotes.groupName, 80))}")`, groupNotes.notes);
  if (hasExcerpt) {
    lines.push(`Excerpts can omit rules and decisions. When your work depends on them, read the rest with task_get_info (taskId: ${task.id}, with the notesSource, nextOffset as offset, and revision shown; repeat until nextOffset is null). To change part of task notes, use task_update with notesEdit.`);
  }
  return section("task_notes", lines, EMPTY_TASK_NOTES);
}

function buildKnowledgeBase(deps: BridgeContextDeps, task: Task | null | undefined): BridgeContextSection {
  // These are the same prerequisites as docs_search/list/read/schema. No catalog walk is needed,
  // including for an empty but available knowledge base or a chat without a task.
  if (!deps.docsStore || !deps.docsIndex) return section("knowledge_base", [], "Knowledge base tools are unavailable.");
  const lines = ["Find pages with docs_search or browse with docs_list. Use docs_read for current text and docs_db_schema for collection fields."];
  if (task && deps.tagStore) {
    const tags = deps.tagStore.getEffectiveTaskTags(task.id, task.groupId).map((tag) => tag.name);
    const pointers = tags.length ? deps.docsIndex.findDocsByTagNames(tags, RELATED_DOCS_LIMIT)
      .map(formatRelatedDocManifestEntry).filter((entry) => entry !== undefined) : [];
    if (pointers.length) lines.push(`Pages related to this task's tags:\n${pointers.join("\n")}`);
  }
  return section("knowledge_base", lines, "");
}

/** The chat's playbook as the agent is told about it. */
export interface PlaybookContext {
  playbook: string;
  source: PlaybookSource;
  label?: string;
  /** False when the name is not an installed playbook (a pin left behind after a skill was removed). */
  installed: boolean;
  /** Machine skills that add steps to this playbook. */
  extensions: string[];
}

const PLAYBOOK_CHOSEN_BY: Record<PlaybookSource, string> = {
  user: "the user chose it",
  agent: "you chose it with playbook_select",
  task: "this chat's task pins it",
  schedule: "the schedule that started this chat pins it",
};

/** A playbook as the agent sees it when choosing one. */
export interface PlaybookChoice {
  id: string;
  label?: string;
  description: string;
}

const NO_ACTIVE_PLAYBOOK = "No playbook is chosen for this chat yet.";

function shortDescription(description: string): string {
  const text = description.replace(/^Playbook:\s*/i, "").replace(/\s+/g, " ").trim();
  const sentence = text.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? text;
  return oneLine(sentence, 140);
}

function buildPlaybook(playbook: PlaybookContext | undefined, choices: readonly PlaybookChoice[]): BridgeContextSection {
  if (!playbook) {
    if (choices.length === 0) return section("playbook", [], NO_ACTIVE_PLAYBOOK);
    return section("playbook", [
      `${NO_ACTIVE_PLAYBOOK} Before you start on the user's request, call playbook_select: the playbook below that fits the work, or "none" when the request is small and fully specified. It returns the playbook's steps; copy them into your todo list. Match again when the user wants a different outcome, even within the same task.${choices.some((choice) => choice.id === "pickup") ? " When the user asks to resume, continue or finish earlier work, choose pickup even when the kind of work is obvious; pickup hands over to that playbook." : ""}`,
      choices.map((choice) => `- ${choice.id}${choice.label ? ` (${choice.label})` : ""}: ${shortDescription(choice.description)}`).join("\n"),
    ], "");
  }
  if (playbook.playbook === NO_PLAYBOOK) {
    return section("playbook", [
      `Direct path (${PLAYBOOK_CHOSEN_BY[playbook.source]}): answer small requests directly. Select a playbook when the requested outcome calls for one, even on the same topic.`,
    ], "");
  }
  if (!playbook.installed) {
    return section("playbook", [
      `The playbook "${playbook.playbook}" is pinned (${PLAYBOOK_CHOSEN_BY[playbook.source]}), but it is not installed on this machine. Tell the user, then match the task to an installed playbook.`,
    ], "");
  }
  const name = playbook.label ? `${playbook.playbook} ("${playbook.label}")` : playbook.playbook;
  return section("playbook", [
    `Active playbook: ${name}; ${PLAYBOOK_CHOSEN_BY[playbook.source]}. Keep it for clarifications and asides. If the user asks for a different outcome, select the method that fits before answering, including Direct for a new small goal. If it still fits and its steps aren't in the conversation, fetch them with playbook_select. Verify the work you actually complete.`,
    ...(playbook.extensions.length > 0 ? [`On this machine ${playbook.extensions.join(", ")} add steps to it; playbook_select returns them too.`] : []),
  ], "");
}

export function buildBridgeContextSections(
  deps: BridgeContextDeps,
  task: Task | null | undefined,
  groupNotes?: { groupName: string; notes: string } | null,
  playbook?: PlaybookContext,
  playbookChoices: readonly PlaybookChoice[] = [],
): BridgeContextSection[] {
  return [
    buildTaskState(deps, task),
    buildTaskNotes(task, groupNotes),
    buildKnowledgeBase(deps, task),
    buildPlaybook(playbook, playbookChoices),
  ];
}

/**
 * Start from no linked task and no KB tools. A taskless chat with KB tools receives their
 * lookup pointer once, regardless of how many pages or collections are present.
 */
export function emptyBridgeContextHashes(): Map<BridgeContextSectionName, string> {
  // With playbooks installed, the playbook section differs from this starting point, so a chat's
  // first message always says which playbooks exist.
  return new Map(buildBridgeContextSections({}, null).map((candidate) => [candidate.name, candidate.hash]));
}

export function renderBridgeContextBlock(sections: readonly BridgeContextSection[]): string | undefined {
  if (sections.length === 0) return undefined;
  return [
    "<bridge_context>",
    "Copilot Bridge added this block with the latest state; the user did not type it. Each section replaces any earlier section with the same name.",
    ...sections.map((candidate) => candidate.content),
    "</bridge_context>",
  ].join("\n");
}
