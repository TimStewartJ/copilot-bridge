import { matchPath } from "react-router-dom";
import { isAllTasksPath, isDashboardRoutePath } from "./dashboard-routes";

export type MobileNavTab = "home" | "work" | "helm" | "docs" | "settings";

/** The Work tab holds the task list and the quick chats; a segment says which of the two a route belongs to. */
export type MobileWorkSegment = "tasks" | "chats";

export type MobileRouteKind =
  | "dashboard"
  | "task-list"
  | "chat-list"
  | "task-cockpit"
  | "task-dashboard"
  | "task-session"
  | "quick-chat"
  | "settings"
  | "helm"
  | "docs-root"
  | "docs-detail"
  | "search"
  | "unknown";

export interface MobileUpTarget {
  to: string;
  label: string;
}

export interface MobileDetailHeaderMeta {
  title?: string;
  metadata?: string;
}

export interface MobileRouteMeta {
  route: MobileRouteKind;
  activeTab: MobileNavTab;
  workSegment: MobileWorkSegment | null;
  showBottomNav: boolean;
  showSharedHeader: boolean;
  isRoot: boolean;
  isDetail: boolean;
  isDraft: boolean;
  isDocsRoot: boolean;
  isDocsDetail: boolean;
  taskId: string | null;
  sessionId: string | null;
  docPath: string | null;
  upTarget?: MobileUpTarget;
  detailHeader?: MobileDetailHeaderMeta;
}

export interface MobileWorkTabTarget {
  segment: MobileWorkSegment;
  /** True when the tap only switches lists, which should not add a history entry. */
  replace: boolean;
}

/**
 * Where a tap on the Work tab leads. On one of its two lists the tap flips to the other, which keeps the
 * switch within thumb reach. From inside a task it leads back to the task list, and from any other tab it
 * reopens the list that was showing last.
 */
export function resolveMobileWorkTabTarget(
  current: Pick<MobileRouteMeta, "isRoot" | "workSegment">,
  lastSegment: MobileWorkSegment,
): MobileWorkTabTarget {
  if (current.isRoot && current.workSegment) {
    return { segment: current.workSegment === "tasks" ? "chats" : "tasks", replace: true };
  }
  return { segment: current.workSegment ?? lastSegment, replace: false };
}

function normalizePathname(pathname: string): string {
  if (!pathname || pathname === "/") return "/";
  const trimmed = pathname.replace(/\/+$/, "");
  return trimmed || "/";
}

function buildMeta(overrides: Partial<MobileRouteMeta> & Pick<MobileRouteMeta, "route" | "activeTab">): MobileRouteMeta {
  return {
    workSegment: null,
    showBottomNav: false,
    showSharedHeader: false,
    isRoot: false,
    isDetail: true,
    isDraft: false,
    isDocsRoot: false,
    isDocsDetail: false,
    taskId: null,
    sessionId: null,
    docPath: null,
    detailHeader: undefined,
    ...overrides,
  };
}

export function getMobileRouteMeta(pathname: string, search = ""): MobileRouteMeta {
  const normalizedPath = normalizePathname(pathname);

  if (isAllTasksPath(normalizedPath)) {
    return buildMeta({
      route: "task-list",
      activeTab: "work",
      workSegment: "tasks",
      showBottomNav: true,
      isRoot: true,
      isDetail: false,
    });
  }

  if (isDashboardRoutePath(normalizedPath)) {
    return buildMeta({
      route: "dashboard",
      activeTab: "home",
      showBottomNav: true,
      isRoot: true,
      isDetail: false,
    });
  }

  if (normalizedPath === "/") {
    return buildMeta({
      route: "task-list",
      activeTab: "work",
      workSegment: "tasks",
      showBottomNav: true,
      isRoot: true,
      isDetail: false,
    });
  }

  if (normalizedPath === "/chats") {
    return buildMeta({
      route: "chat-list",
      activeTab: "work",
      workSegment: "chats",
      showBottomNav: true,
      isRoot: true,
      isDetail: false,
    });
  }

  if (normalizedPath === "/settings") {
    return buildMeta({
      route: "settings",
      activeTab: "settings",
      showBottomNav: true,
      isRoot: true,
      isDetail: false,
    });
  }

  if (normalizedPath === "/helm") {
    return buildMeta({
      route: "helm",
      activeTab: "helm",
      showBottomNav: true,
      isRoot: true,
      isDetail: false,
    });
  }

  if (normalizedPath === "/search") {
    return buildMeta({
      route: "search",
      activeTab: "work",
      isRoot: true,
      isDetail: false,
    });
  }

  const taskDraftMatch = matchPath("/tasks/:taskId/sessions/new", normalizedPath);
  if (taskDraftMatch) {
    return buildMeta({
      route: "task-session",
      activeTab: "work",
      workSegment: "tasks",
      showSharedHeader: true,
      isDraft: true,
      taskId: taskDraftMatch.params.taskId ?? null,
      sessionId: "new",
      upTarget: taskDraftMatch.params.taskId
        ? { to: `/tasks/${taskDraftMatch.params.taskId}`, label: "Task" }
        : undefined,
    });
  }

  const taskSessionMatch = matchPath("/tasks/:taskId/sessions/:sessionId", normalizedPath);
  if (taskSessionMatch) {
    return buildMeta({
      route: "task-session",
      activeTab: "work",
      workSegment: "tasks",
      showSharedHeader: true,
      taskId: taskSessionMatch.params.taskId ?? null,
      sessionId: taskSessionMatch.params.sessionId ?? null,
      upTarget: taskSessionMatch.params.taskId
        ? { to: `/tasks/${taskSessionMatch.params.taskId}`, label: "Task" }
        : undefined,
    });
  }

  const taskOverviewMatch = matchPath("/tasks/:taskId/overview", normalizedPath);
  if (taskOverviewMatch) {
    return buildMeta({
      route: "task-dashboard",
      activeTab: "work",
      workSegment: "tasks",
      showBottomNav: true,
      showSharedHeader: true,
      taskId: taskOverviewMatch.params.taskId ?? null,
      upTarget: taskOverviewMatch.params.taskId
        ? { to: `/tasks/${taskOverviewMatch.params.taskId}`, label: "Task" }
        : undefined,
    });
  }

  const taskCockpitMatch = matchPath("/tasks/:taskId", normalizedPath);
  if (taskCockpitMatch) {
    return buildMeta({
      route: "task-cockpit",
      activeTab: "work",
      workSegment: "tasks",
      showBottomNav: true,
      showSharedHeader: true,
      taskId: taskCockpitMatch.params.taskId ?? null,
      upTarget: { to: "/", label: "Tasks" },
    });
  }

  if (normalizedPath === "/sessions/new") {
    return buildMeta({
      route: "quick-chat",
      activeTab: "work",
      workSegment: "chats",
      showSharedHeader: true,
      isDraft: true,
      sessionId: "new",
      upTarget: { to: "/chats", label: "Chats" },
    });
  }

  const sessionMatch = matchPath("/sessions/:sessionId", normalizedPath);
  if (sessionMatch) {
    return buildMeta({
      route: "quick-chat",
      activeTab: "work",
      workSegment: "chats",
      showSharedHeader: true,
      sessionId: sessionMatch.params.sessionId ?? null,
      upTarget: { to: "/chats", label: "Chats" },
    });
  }

  if (normalizedPath === "/docs" || normalizedPath.startsWith("/docs/")) {
    const isDb = new URLSearchParams(search).has("db");
    const rawDocPath = normalizedPath.replace(/^\/docs\/?/, "") || null;
    const isDocsRoot = rawDocPath === null || (!isDb && rawDocPath === "index");

    return buildMeta({
      route: isDocsRoot ? "docs-root" : "docs-detail",
      activeTab: "docs",
      showBottomNav: true,
      // The Docs view draws its own top bar (back, title, contents, actions) on every screen
      // size, so the shared detail header would only stack a second bar above it.
      showSharedHeader: false,
      isRoot: isDocsRoot,
      isDetail: !isDocsRoot,
      isDocsRoot,
      isDocsDetail: !isDocsRoot,
      docPath: isDocsRoot ? null : rawDocPath,
      upTarget: !isDocsRoot ? { to: "/docs", label: "Docs" } : undefined,
    });
  }

  return buildMeta({
    route: "unknown",
    activeTab: "work",
    isDetail: false,
  });
}
