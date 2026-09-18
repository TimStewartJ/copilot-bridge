// Links to Bridge's own concepts (sessions, tasks, docs). Agents write them as
// `bridge://session/<id>` so they survive any deployment base path; the client renders
// them natively and resolves them to in-app routes.

export type BridgeLinkTarget =
  | { kind: "session"; sessionId: string; taskId?: string }
  | { kind: "task"; taskId: string; view?: "overview" }
  | { kind: "doc"; path: string }
  | { kind: "helm" };

export type BridgeLinkKind = BridgeLinkTarget["kind"];

export const BRIDGE_LINK_PROTOCOL = "bridge:";

/** Session refs are full ids or the 8-character prefixes agents see in tool results. */
const SESSION_REF_RE = /^[0-9a-z][0-9a-z-]{3,63}$/i;
const ENTITY_ID_RE = /^[\w.-]{1,128}$/;

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function decodeSegments(path: string): string[] | null {
  const segments: string[] = [];
  for (const raw of path.split("/").filter(Boolean)) {
    const decoded = decodeSegment(raw);
    if (decoded === null || decoded === "." || decoded === "..") return null;
    segments.push(decoded);
  }
  return segments;
}

function sessionTarget(sessionId: string | undefined, taskId?: string): BridgeLinkTarget | null {
  if (!sessionId || sessionId === "new" || !SESSION_REF_RE.test(sessionId)) return null;
  if (taskId !== undefined && !ENTITY_ID_RE.test(taskId)) return null;
  return { kind: "session", sessionId: sessionId.toLowerCase(), ...(taskId ? { taskId } : {}) };
}

function taskTarget(taskId: string | undefined, view?: "overview"): BridgeLinkTarget | null {
  if (!taskId || !ENTITY_ID_RE.test(taskId)) return null;
  return { kind: "task", taskId, ...(view ? { view } : {}) };
}

function docTarget(segments: string[]): BridgeLinkTarget | null {
  const path = segments.join("/");
  return path ? { kind: "doc", path } : null;
}

function parseSchemeSegments(segments: string[]): BridgeLinkTarget | null {
  const [kind, ...rest] = segments;
  switch (kind?.toLowerCase()) {
    case "session":
    case "sessions":
    case "chat":
      return rest.length === 1 ? sessionTarget(rest[0]) : null;
    case "task":
    case "tasks":
      if (rest.length === 1) return taskTarget(rest[0]);
      if (rest.length === 2 && rest[1] === "overview") return taskTarget(rest[0], "overview");
      if (rest.length === 3 && rest[1] === "sessions") return sessionTarget(rest[2], rest[0]);
      return null;
    case "doc":
    case "docs":
      return docTarget(rest);
    case "helm":
      return rest.length === 0 ? { kind: "helm" } : null;
    default:
      return null;
  }
}

/** Parses an in-app route such as `/tasks/<id>/sessions/<id>` (without any deployment base path). */
export function parseBridgeAppPath(pathname: string): BridgeLinkTarget | null {
  const segments = decodeSegments(pathname);
  if (!segments || segments.length === 0) return null;
  const [root, ...rest] = segments;
  switch (root) {
    case "sessions":
      return rest.length === 1 ? sessionTarget(rest[0]) : null;
    case "tasks":
      if (rest.length === 1) return taskTarget(rest[0]);
      if (rest.length === 2 && rest[1] === "overview") return taskTarget(rest[0], "overview");
      if (rest.length === 3 && rest[1] === "sessions") return sessionTarget(rest[2], rest[0]);
      return null;
    case "docs":
      return docTarget(rest);
    case "helm":
      return rest.length === 0 ? { kind: "helm" } : null;
    default:
      return null;
  }
}

export interface ParseBridgeLinkOptions {
  /** Origin of the running Bridge UI; absolute links to it are treated as in-app links. */
  origin?: string;
  /** Deployment base path such as `/staging/<prefix>`; stripped before route matching. */
  basePath?: string;
}

function stripBasePath(pathname: string, basePath: string | undefined): string | null {
  const base = (basePath ?? "").replace(/\/+$/, "");
  if (!base) return pathname;
  if (pathname === base) return "/";
  return pathname.startsWith(`${base}/`) ? pathname.slice(base.length) : null;
}

/**
 * Recognizes `bridge://…` links, root-relative app routes, and absolute URLs that point
 * at this Bridge. Returns null for anything else so ordinary links keep rendering normally.
 */
export function parseBridgeLink(href: string | null | undefined, options: ParseBridgeLinkOptions = {}): BridgeLinkTarget | null {
  const value = href?.trim();
  if (!value) return null;

  if (value.toLowerCase().startsWith(BRIDGE_LINK_PROTOCOL)) {
    const rest = value.slice(BRIDGE_LINK_PROTOCOL.length).replace(/^\/+/, "");
    const [path = ""] = rest.split(/[?#]/);
    const segments = decodeSegments(path);
    return segments ? parseSchemeSegments(segments) : null;
  }

  if (value.startsWith("/") && !value.startsWith("//")) {
    const [path = ""] = value.split(/[?#]/);
    const stripped = stripBasePath(path, options.basePath);
    return stripped === null ? null : parseBridgeAppPath(stripped);
  }

  if (options.origin && /^https?:\/\//i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return null;
    }
    if (url.origin !== options.origin) return null;
    const stripped = stripBasePath(url.pathname, options.basePath);
    return stripped === null ? null : parseBridgeAppPath(stripped);
  }

  return null;
}

function encodePath(path: string): string {
  return path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

export function formatBridgeLink(target: BridgeLinkTarget): string {
  switch (target.kind) {
    case "session":
      return `bridge://session/${encodeURIComponent(target.sessionId)}`;
    case "task":
      return `bridge://task/${encodeURIComponent(target.taskId)}${target.view ? `/${target.view}` : ""}`;
    case "doc":
      return `bridge://doc/${encodePath(target.path)}`;
    case "helm":
      return "bridge://helm";
  }
}

/** In-app route for a link target, without any deployment base path. */
export function bridgeLinkToAppPath(target: BridgeLinkTarget): string {
  switch (target.kind) {
    case "session":
      return target.taskId
        ? `/tasks/${encodeURIComponent(target.taskId)}/sessions/${encodeURIComponent(target.sessionId)}`
        : `/sessions/${encodeURIComponent(target.sessionId)}`;
    case "task":
      return `/tasks/${encodeURIComponent(target.taskId)}${target.view ? `/${target.view}` : ""}`;
    case "doc":
      return `/docs/${encodePath(target.path)}`;
    case "helm":
      return "/helm";
  }
}

export function isBridgeSchemeLink(href: string | null | undefined): boolean {
  return typeof href === "string" && href.trim().toLowerCase().startsWith(BRIDGE_LINK_PROTOCOL);
}
