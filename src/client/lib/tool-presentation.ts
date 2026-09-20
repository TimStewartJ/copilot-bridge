import type { ToolArgs, ToolCall } from "../api";
import type { ToolCallStatus } from "./tool-call-status";
import { summarizeToolArgs } from "./tool-args";

/**
 * Turns a raw tool call ("powershell", `{"command": "git status", ...}`) into the short sentence a
 * person would say about it ("Ran git status"). The raw name and arguments stay available in the
 * row's details; this only decides what the collapsed row reads as.
 */

export type ToolIconName =
  | "terminal"
  | "file"
  | "file-plus"
  | "file-pen"
  | "search"
  | "folder-search"
  | "globe"
  | "sparkles"
  | "database"
  | "question"
  | "agent"
  | "book"
  | "tasks"
  | "clock"
  | "pointer"
  | "image"
  | "paperclip"
  | "rocket"
  | "tool";

export interface ToolPresentation {
  /** Verb phrase already in the tense that matches the status. */
  verb: string;
  /** What the call acted on. */
  target?: string;
  /** Whether the target is literal input (a command, path or pattern) rather than prose. */
  mono: boolean;
  icon: ToolIconName;
}

interface ToolTarget {
  /** Replaces the verb when the call carries its own description of what it is for. */
  label?: string;
  text?: string;
  mono?: boolean;
}

interface ToolVerb {
  active: string;
  done: string;
  icon: ToolIconName;
  /** Picks the target; falls back to the generic argument summary when it yields nothing. */
  target?: (args: Record<string, ToolArgs>) => ToolTarget | undefined;
}

function isArgObject(args: ToolArgs | undefined): args is Record<string, ToolArgs> {
  return typeof args === "object" && args !== null && !Array.isArray(args);
}

function stringArg(args: Record<string, ToolArgs>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0]?.replace(/\s+/g, " ").trim() ?? "";
}

/** The last segments of a path, which is what identifies a file in a transcript. */
export function shortenPath(path: string, segments = 2): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.length <= segments ? parts.join("/") : parts.slice(-segments).join("/");
}

function describeUrl(value: string): string {
  try {
    const url = new URL(value);
    const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
    return `${url.hostname.replace(/^www\./, "")}${path}`;
  } catch {
    return value;
  }
}

function pathTarget(args: Record<string, ToolArgs>): { text?: string; mono: boolean } | undefined {
  const path = stringArg(args, "path", "file_path", "filePath", "file");
  if (!path) return undefined;
  const range = args.view_range;
  const lines = Array.isArray(range) && range.length === 2 && range.every((part) => typeof part === "number")
    ? ` · lines ${range[0]}–${range[1] === -1 ? "end" : range[1]}`
    : "";
  return { text: `${shortenPath(path)}${lines}`, mono: true };
}

/** A shell call says what it is for; that reads better than "Ran", with the command beside it. */
function commandTarget(args: Record<string, ToolArgs>): ToolTarget | undefined {
  const description = stringArg(args, "description");
  const command = stringArg(args, "command", "cmd", "script");
  if (!description && !command) return undefined;
  return {
    ...(description ? { label: description } : {}),
    ...(command ? { text: firstLine(command), mono: true } : {}),
  };
}

/** Where a search looked, when it was narrowed to one place: " in src/shared". */
function searchScope(args: Record<string, ToolArgs>): string {
  const paths = args.paths ?? args.path;
  const first = typeof paths === "string"
    ? paths
    : Array.isArray(paths) && paths.length === 1 && typeof paths[0] === "string"
      ? paths[0]
      : undefined;
  if (!first?.trim()) return Array.isArray(paths) && paths.length > 1 ? ` in ${paths.length} places` : "";
  return ` in ${shortenPath(first.trim())}`;
}

function searchTarget(args: Record<string, ToolArgs>): ToolTarget | undefined {
  const pattern = stringArg(args, "pattern", "query");
  return pattern ? { text: `${pattern}${searchScope(args)}`, mono: true } : undefined;
}

const SHELL: ToolVerb = { active: "Running", done: "Ran", icon: "terminal", target: commandTarget };
const READ_FILE: ToolVerb = { active: "Reading", done: "Read", icon: "file", target: pathTarget };
const EDIT_FILE: ToolVerb = { active: "Editing", done: "Edited", icon: "file-pen", target: pathTarget };
const WEB_PAGE: ToolVerb = {
  active: "Fetching",
  done: "Fetched",
  icon: "globe",
  target: (args) => {
    const url = stringArg(args, "url");
    return url ? { text: describeUrl(url), mono: false } : undefined;
  },
};
const WEB_SEARCH: ToolVerb = {
  active: "Searching the web",
  done: "Searched the web",
  icon: "globe",
  target: (args) => ({ text: stringArg(args, "query", "q"), mono: false }),
};

const TOOL_VERBS: Record<string, ToolVerb> = {
  powershell: SHELL,
  bash: SHELL,
  shell: SHELL,
  read_powershell: { active: "Reading output", done: "Read output", icon: "terminal", target: (args) => ({ text: stringArg(args, "shellId"), mono: true }) },
  read_bash: { active: "Reading output", done: "Read output", icon: "terminal", target: (args) => ({ text: stringArg(args, "shellId"), mono: true }) },
  stop_powershell: { active: "Stopping", done: "Stopped", icon: "terminal", target: (args) => ({ text: stringArg(args, "shellId"), mono: true }) },
  stop_bash: { active: "Stopping", done: "Stopped", icon: "terminal", target: (args) => ({ text: stringArg(args, "shellId"), mono: true }) },
  write_powershell: { active: "Sending input", done: "Sent input", icon: "terminal", target: (args) => ({ text: stringArg(args, "shellId"), mono: true }) },
  write_bash: { active: "Sending input", done: "Sent input", icon: "terminal", target: (args) => ({ text: stringArg(args, "shellId"), mono: true }) },
  list_powershell: { active: "Listing shells", done: "Listed shells", icon: "terminal" },
  list_bash: { active: "Listing shells", done: "Listed shells", icon: "terminal" },
  management_job_status: { active: "Checking job", done: "Checked job", icon: "rocket", target: (args) => ({ text: stringArg(args, "jobId"), mono: true }) },
  view: READ_FILE,
  read_file: READ_FILE,
  create: { active: "Creating", done: "Created", icon: "file-plus", target: pathTarget },
  edit: EDIT_FILE,
  str_replace_editor: EDIT_FILE,
  apply_patch: EDIT_FILE,
  grep: { active: "Searching", done: "Searched", icon: "search", target: searchTarget },
  // The same search under the name GPT models call it by.
  rg: { active: "Searching", done: "Searched", icon: "search", target: searchTarget },
  glob: { active: "Finding files", done: "Found files", icon: "folder-search", target: searchTarget },
  web_fetch: WEB_PAGE,
  browser_fetch: WEB_PAGE,
  web_search: WEB_SEARCH,
  browser_web_search: WEB_SEARCH,
  skill: {
    active: "Loading skill",
    done: "Loaded skill",
    icon: "sparkles",
    target: (args) => ({ text: stringArg(args, "skill", "name"), mono: false }),
  },
  sql: {
    active: "Querying",
    done: "Queried",
    icon: "database",
    target: (args) => {
      const description = stringArg(args, "description");
      const query = stringArg(args, "query");
      if (!description && !query) return undefined;
      return {
        ...(description ? { label: description } : {}),
        ...(query ? { text: firstLine(query), mono: true } : {}),
      };
    },
  },
  ask_user: {
    active: "Asking you",
    done: "Asked you",
    icon: "question",
    target: (args) => {
      const message = stringArg(args, "message", "question");
      return message ? { text: firstLine(message), mono: false } : undefined;
    },
  },
  publish_visual: {
    active: "Publishing",
    done: "Published",
    icon: "image",
    target: (args) => ({ text: stringArg(args, "title", "displayName"), mono: false }),
  },
  send_attachment: {
    active: "Attaching",
    done: "Attached",
    icon: "paperclip",
    target: (args) => {
      const name = stringArg(args, "displayName", "path");
      return name ? { text: shortenPath(name, 1), mono: false } : undefined;
    },
  },
  read_agent: { active: "Checking agent", done: "Checked agent", icon: "agent", target: (args) => ({ text: stringArg(args, "agent_id"), mono: true }) },
  write_agent: { active: "Messaging agent", done: "Messaged agent", icon: "agent", target: (args) => ({ text: stringArg(args, "agent_id"), mono: true }) },
  list_agents: { active: "Listing agents", done: "Listed agents", icon: "agent" },
  // A delegation before its agent has reported in; afterwards the row is the agent's own.
  task: {
    active: "Delegating",
    done: "Delegated",
    icon: "agent",
    target: (args) => ({ text: stringArg(args, "description", "name"), mono: false }),
  },
};

/** Tool families named `<family>_<action>`; the action becomes the label. */
const TOOL_FAMILIES: Array<{ prefix: string; icon: ToolIconName; noun: string }> = [
  { prefix: "docs_", icon: "book", noun: "Docs" },
  { prefix: "task_", icon: "tasks", noun: "Task" },
  { prefix: "action_", icon: "tasks", noun: "Action" },
  { prefix: "checklist_", icon: "tasks", noun: "Checklist" },
  { prefix: "decision_", icon: "tasks", noun: "Decision" },
  { prefix: "alert_", icon: "tasks", noun: "Alert" },
  { prefix: "event_", icon: "tasks", noun: "Event" },
  { prefix: "focus_", icon: "tasks", noun: "Focus" },
  { prefix: "schedule_", icon: "clock", noun: "Schedule" },
  { prefix: "defer_", icon: "clock", noun: "Defer" },
  { prefix: "staging_", icon: "rocket", noun: "Staging" },
  { prefix: "browser_", icon: "globe", noun: "Browser" },
  { prefix: "computer-use-", icon: "pointer", noun: "Computer" },
];

function humanize(value: string): string {
  const words = value.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : value;
}

/** Trailing ellipsis is added by CSS truncation; this only keeps pathological inputs bounded. */
function bound(value: string | undefined, maxLength = 240): string | undefined {
  if (!value) return undefined;
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

export function describeToolCall(
  toolCall: Pick<ToolCall, "name" | "args" | "isSubAgent">,
  status: ToolCallStatus | null,
): ToolPresentation {
  // Bridge tools reached through MCP carry the server's name in front of their own.
  const name = toolCall.name.trim().replace(/^bridge-tools-(?:session-)?/i, "");
  const args = isArgObject(toolCall.args) ? toolCall.args : undefined;
  const running = status === "running";
  if (toolCall.isSubAgent) {
    return {
      verb: name.replace(/^🤖\s*/, "") || "Agent",
      target: bound(args ? stringArg(args, "description") : undefined),
      mono: false,
      icon: "agent",
    };
  }
  const verb = TOOL_VERBS[name.toLowerCase()];
  if (verb) {
    const picked = args ? verb.target?.(args) : undefined;
    // A verb with no target of its own ("Listed agents") says everything already.
    const fallback = verb.target && !picked?.text && !picked?.label ? summarizeToolArgs(toolCall.args) : "";
    return {
      verb: picked?.label ?? (running ? verb.active : verb.done),
      target: bound(picked?.text ?? (fallback || undefined)),
      mono: picked?.text ? picked.mono === true : Boolean(fallback),
      icon: verb.icon,
    };
  }

  const family = TOOL_FAMILIES.find((candidate) => name.toLowerCase().startsWith(candidate.prefix));
  const summary = summarizeToolArgs(toolCall.args);
  if (family) {
    const action = humanize(name.slice(family.prefix.length)).toLowerCase();
    return {
      verb: `${family.noun} ${action}`.trim(),
      target: bound(summary || undefined),
      mono: false,
      icon: family.icon,
    };
  }
  return { verb: humanize(name), target: bound(summary || undefined), mono: false, icon: "tool" };
}

/**
 * "420ms", "3.2s", "2m 14s", "1h 04m" — compact enough to sit at the end of a row. A clock that is
 * still ticking passes `wholeSeconds`, because "7.0s" turning into "8.0s" is noise.
 */
export function formatDuration(ms: number, options: { wholeSeconds?: boolean } = {}): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (options.wholeSeconds && ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`;
  const totalSeconds = ms / 1000;
  if (totalSeconds < 10) return `${totalSeconds.toFixed(1)}s`;
  const seconds = Math.round(totalSeconds);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function getToolDurationMs(toolCall: Pick<ToolCall, "startedAt" | "completedAt">): number | undefined {
  if (!toolCall.startedAt || !toolCall.completedAt) return undefined;
  const ms = Date.parse(toolCall.completedAt) - Date.parse(toolCall.startedAt);
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}
