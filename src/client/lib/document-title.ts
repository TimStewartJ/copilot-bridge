import type { MobileRouteKind } from "./mobile-route-meta";
import { getExplicitDashboardTabFromPathname } from "./dashboard-routes";

export const APP_TITLE = "Copilot Bridge";

const SEPARATOR = " - ";
const MAX_SEGMENT_LENGTH = 64;

export interface DocumentTitleInput {
  /** Route kind derived from the current pathname. */
  route: MobileRouteKind;
  /** Current pathname, used to distinguish dashboard sub-tabs. */
  pathname?: string;
  /** True while the route points at an unsent draft session. */
  isDraft?: boolean;
  /** Title of the task the route is scoped to, when known. */
  taskTitle?: string | null;
  /** Human label for the active session (summary, falling back to live intent). */
  sessionLabel?: string | null;
  /** Resolved docs page/collection title, when the docs view has loaded it. */
  docTitle?: string | null;
  /** Raw docs path from the URL, used as a fallback before the page loads. */
  docPath?: string | null;
  /** Unread session count rendered as a leading badge. */
  unreadCount?: number;
}

function cleanSegment(value: string | null | undefined): string | null {
  if (!value) return null;
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  if (collapsed.length <= MAX_SEGMENT_LENGTH) return collapsed;
  return `${collapsed.slice(0, MAX_SEGMENT_LENGTH - 1).trimEnd()}\u2026`;
}

/** Turn a docs slug like `sff-pipeline/ci-dashboard` into `Ci dashboard`. */
export function humanizeDocPath(docPath: string | null | undefined): string | null {
  if (!docPath) return null;
  const segments = docPath.split("/").filter(Boolean);
  // A `.../index` page is really the folder it lives in.
  while (segments.length > 1 && segments[segments.length - 1] === "index") segments.pop();
  const last = segments[segments.length - 1];
  if (!last || last === "index") return null;
  const words = last.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  if (!words) return null;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function getDashboardSegment(pathname: string | undefined): string {
  const tab = pathname ? getExplicitDashboardTabFromPathname(pathname) : null;
  if (tab === "checklist") return "Checklist";
  if (tab === "feed") return "Feed";
  return "Home";
}

function getSegments(input: DocumentTitleInput): (string | null | undefined)[] {
  const { route, taskTitle, sessionLabel, isDraft } = input;
  const chatSegment = isDraft ? "New chat" : cleanSegment(sessionLabel) ?? "Chat";

  switch (route) {
    case "dashboard":
      return [getDashboardSegment(input.pathname)];
    case "task-list":
      return ["Tasks"];
    case "chat-list":
      return ["Chats"];
    case "settings":
      return ["Settings"];
    case "task-cockpit":
      return [cleanSegment(taskTitle) ?? "Task"];
    case "task-dashboard":
      return ["Overview", cleanSegment(taskTitle) ?? "Task"];
    case "task-session":
      return [chatSegment, cleanSegment(taskTitle)];
    case "quick-chat":
      return [chatSegment];
    case "docs-root":
      return ["Docs"];
    case "docs-detail":
      return [cleanSegment(input.docTitle) ?? humanizeDocPath(input.docPath), "Docs"];
    default:
      return [];
  }
}

/** Build the browser tab title for the current route and its context. */
export function resolveDocumentTitle(input: DocumentTitleInput): string {
  const segments = getSegments(input)
    .map((segment) => cleanSegment(segment))
    .filter((segment): segment is string => Boolean(segment) && segment !== APP_TITLE);

  const title = [...segments, APP_TITLE].join(SEPARATOR);
  const unread = Math.trunc(input.unreadCount ?? 0);
  return unread > 0 ? `(${unread}) ${title}` : title;
}
