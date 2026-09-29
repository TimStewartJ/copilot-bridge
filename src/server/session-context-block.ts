import { createHash } from "node:crypto";
import type { ChecklistStore } from "./checklist-store.js";
import type { DocsIndex } from "./docs-index.js";
import type { DocsStore, DocTreeNode } from "./docs-store.js";
import type { TagStore } from "./tag-store.js";
import { PLACEHOLDER_TASK_TITLE, type Task } from "./task-store.js";
import type { TaskHistoryStore } from "./task-history-store.js";
import {
  formatLinkedPullRequest,
  formatPromptTagList,
  formatRelatedDocManifestEntry,
} from "./session-formatting.js";
import { formatTaskMomentumContext } from "./session-task-momentum.js";

/**
 * Task and knowledge-base state that changes while a chat runs. It travels at the start of user
 * messages instead of in the system prompt, so edits never invalidate the cached conversation and
 * reach cached chats on their next message. Both sections are always present, so a chat that
 * leaves its task or loses its knowledge base is told so like any other change, and each section
 * is resent only when it changes.
 */
export type BridgeContextSectionName = "task_state" | "knowledge_base";

export interface BridgeContextSection {
  name: BridgeContextSectionName;
  content: string;
  hash: string;
}

export interface BridgeContextDeps {
  checklistStore?: Pick<ChecklistStore, "listChecklistItems">;
  tagStore?: Pick<TagStore, "resolveEffectiveTags">;
  docsIndex?: Pick<DocsIndex, "findDocsByTagNames">;
  docsStore?: Pick<DocsStore, "listTree" | "readSchema">;
  taskHistoryStore?: Pick<TaskHistoryStore, "listEntries" | "countEntries">;
}

export const BRIDGE_CONTEXT_HISTORY_ENTRIES = 3;
/**
 * Lives in task_state rather than the system prompt so it disappears once the task has a real
 * title: the renamed state replaces this section, and sub-agents never receive it.
 */
export const PLACEHOLDER_TITLE_GUIDANCE = `This task still has the placeholder title "${PLACEHOLDER_TASK_TITLE}". After reading the user's message, use task_update to give it a concise, descriptive title (3-6 words). Do this silently without mentioning it to the user.`;
const HISTORY_LINE_LENGTH = 200;

export function renderDocsTree(nodes: DocTreeNode[], depth = 0): string {
  return nodes.map((n) => {
    const indent = "  ".repeat(depth);
    if (n.type === "folder") {
      const label = n.isDb
        ? `${n.name}/ (collection)`
        : n.hasIndex ? `${n.name}/ (page: docs_read "${n.path}")` : `${n.name}/`;
      const children = n.isDb ? "" : depth < 1 && n.children?.length
        ? "\n" + renderDocsTree(n.children, depth + 1)
        : n.children?.length ? ` (${n.children.length} items)` : "";
      return `${indent}- 📁 ${label}${children}`;
    }
    return `${indent}- ${n.name}`;
  }).join("\n");
}

function collectDocsDatabaseSummaries(
  docsStore: Pick<DocsStore, "readSchema">,
  nodes: DocTreeNode[],
  summaries: string[] = [],
): string[] {
  for (const n of nodes) {
    if (n.type !== "folder") continue;
    if (n.isDb) {
      const schema = docsStore.readSchema(n.path);
      if (schema) {
        const fields = schema.fields.map((f) => `${f.name} (${f.type})`).join(", ");
        summaries.push(`- ${n.path}/ "${schema.name}": ${fields}`);
      }
    }
    if (n.children?.length) collectDocsDatabaseSummaries(docsStore, n.children, summaries);
  }
  return summaries;
}

function oneLine(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

function section(name: BridgeContextSectionName, lines: string[], empty: string): BridgeContextSection {
  const body = lines.filter((line) => line.trim()).join("\n\n") || empty;
  const content = `<${name}>\n${body}\n</${name}>`;
  return { name, content, hash: createHash("sha256").update(content).digest("hex") };
}

function buildTaskState(
  deps: BridgeContextDeps,
  task: Task | null | undefined,
  groupNotes: { groupName: string; notes: string } | null | undefined,
): BridgeContextSection {
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
  if (task.notes.trim()) {
    lines.push(`Task notes (the current state of the work; any rules the user wrote here still apply):\n${task.notes.trim()}`);
  }
  if (groupNotes?.notes?.trim()) {
    lines.push(`Group notes (task group "${groupNotes.groupName}"):\n${groupNotes.notes.trim()}`);
  }
  const checklist = deps.checklistStore?.listChecklistItems(task.id) ?? [];
  if (checklist.length > 0) {
    lines.push(`Checklist:\n${checklist.map((item) => (
      `- [${item.done ? "x" : " "}] ${item.text} [id: ${item.id}]${item.deadline ? ` (due ${item.deadline})` : ""}`
    )).join("\n")}`);
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

function buildKnowledgeBase(deps: BridgeContextDeps, task: Task | null | undefined): BridgeContextSection {
  const lines: string[] = [];
  if (task && deps.tagStore && deps.docsIndex) {
    const tagNames = deps.tagStore.resolveEffectiveTags(task.id, task.groupId).tags.map((tag) => tag.name);
    const relatedDocs = tagNames.length > 0 ? deps.docsIndex.findDocsByTagNames(tagNames, 20) : [];
    if (relatedDocs.length > 0) {
      lines.push(`Docs related to this task's tags (${formatPromptTagList(tagNames)}); read them with docs_read when relevant:\n${
        relatedDocs.map((doc) => formatRelatedDocManifestEntry(doc)).join("\n")
      }`);
    }
  }
  const tree = deps.docsStore?.listTree() ?? [];
  if (tree.length > 0) {
    lines.push(`Knowledge base structure (use docs_read/docs_search). Folder entries marked as pages are readable with docs_read using the shown folder path:\n${renderDocsTree(tree)}`);
    const databases = deps.docsStore ? collectDocsDatabaseSummaries(deps.docsStore, tree) : [];
    if (databases.length > 0) {
      lines.push(`Database collections (use docs_db_query/docs_db_add; docs_db_schema for full field options):\n${databases.join("\n")}`);
    }
  }
  return section("knowledge_base", lines, "The knowledge base is empty.");
}

export function buildBridgeContextSections(
  deps: BridgeContextDeps,
  task: Task | null | undefined,
  groupNotes?: { groupName: string; notes: string } | null,
): BridgeContextSection[] {
  return [buildTaskState(deps, task, groupNotes), buildKnowledgeBase(deps, task)];
}

/**
 * What a chat knows before any block: no task and no knowledge base, which is what its system
 * prompt says too. Starting from these hashes means a taskless chat with no docs gets no block.
 */
export function emptyBridgeContextHashes(): Map<BridgeContextSectionName, string> {
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
