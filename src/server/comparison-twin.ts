// The second chat of a model comparison: its id prefix and the actions it is not allowed to take.
import { randomUUID } from "node:crypto";
import { isRecord } from "../shared/is-record.js";

/** Reserved first block of a comparison twin's id; unlisted, but never swept like scratch chats. */
export const COMPARISON_TWIN_SESSION_ID_PREFIX = "c4ec2b1d";

export function createComparisonTwinSessionId(): string {
  const uuid = randomUUID();
  return `${COMPARISON_TWIN_SESSION_ID_PREFIX}${uuid.slice(COMPARISON_TWIN_SESSION_ID_PREFIX.length)}`;
}

export function isComparisonTwinSessionId(sessionId: string): boolean {
  return sessionId.startsWith(`${COMPARISON_TWIN_SESSION_ID_PREFIX}-`);
}

/** Tools that act outside the twin's own chat, so they would happen twice. */
const OUTWARD_TOOLS: ReadonlySet<string> = new Set([
  "staging_deploy", "staging_cleanup", "self_restart", "self_update",
  "session_send", "session_start", "session_archive", "session_rename", "session_set_workspace",
  "trigger_create", "trigger_update", "trigger_run", "trigger_cancel", "trigger_delete",
  "task_create", "task_update", "task_update_momentum", "task_history_add",
  "task_link_pr", "task_unlink_pr", "task_link_work_item", "task_unlink_work_item", "task_page_publish",
  "task_group_create", "task_group_update", "task_group_delete",
  "checklist_add", "checklist_update", "checklist_remove", "action_add", "action_update", "action_remove",
  "docs_write", "docs_edit", "docs_delete", "docs_db_add", "docs_db_update", "docs_db_delete", "docs_db_create",
  "docs_snapshot_create", "docs_snapshot_restore",
  "tag_create", "tag_update", "tag_delete", "extensions_manage", "extensions_reload", "git_worktree_release",
  "calendar_event_create", "calendar_event_update", "calendar_event_delete",
  "phone_create_reminder", "phone_update_reminder", "phone_delete_reminder",
  "phone_create_calendar_event", "phone_schedule_notification",
]);

/** Tools that wait on the user, who never sees this chat. */
const USER_WAIT_TOOLS: ReadonlySet<string> = new Set(["ask_user", "browser_session_handoff", "browser_sign_in"]);
const BROWSER_CONTEXT_TOOLS: ReadonlySet<string> = new Set(["browser_fetch", "browser_exec", "browser_session_start"]);

/** MCP tools arrive as `<server>-<tool>`; Bridge tool names never contain a hyphen. */
function baseToolName(toolName: string): string {
  return toolName.slice(toolName.lastIndexOf("-") + 1);
}

export interface TwinToolDecision {
  permissionDecision: "deny";
  permissionDecisionReason: string;
}

/** Why the twin may not run this tool, or undefined when it may. */
export function decideComparisonTwinTool(toolName: string, toolArgs?: unknown): TwinToolDecision | undefined {
  const name = baseToolName(toolName);
  if (USER_WAIT_TOOLS.has(name)) {
    // A waiting question would hold restarts in a chat nobody is watching.
    return {
      permissionDecision: "deny",
      permissionDecisionReason: "Nobody answers questions in this chat. If you need an answer, end your turn with the question as your reply.",
    };
  }
  // The signed-in browser acts as the user on real sites.
  const signedIn = BROWSER_CONTEXT_TOOLS.has(name) && isRecord(toolArgs) && toolArgs.context === "authenticated";
  if (!OUTWARD_TOOLS.has(name) && !signedIn) return undefined;
  return {
    permissionDecision: "deny",
    permissionDecisionReason: "This action is turned off in this chat. Don't retry it: finish the rest, and say what you would have done.",
  };
}
