import type { MobileRouteMeta } from "./mobile-route-meta";

export const BRIDGE_MOBILE_SCROLL_RESTORE_STATE = "bridgeMobileScrollRestore" as const;

export type MobileScrollRestorationKey =
  | "mobile:dashboard"
  | "mobile:tasks:list"
  | "mobile:chats:list"
  | `mobile:task-dashboard:${string}`;

export type MobileScrollNavigationType = "POP" | "PUSH" | "REPLACE";

export interface BridgeMobileScrollRestoreState {
  [BRIDGE_MOBILE_SCROLL_RESTORE_STATE]: true;
}

export interface MobileScrollRestorationPolicy {
  key: MobileScrollRestorationKey;
  restore: boolean;
}

export interface MobileScrollRestorationOptions {
  navigationType?: MobileScrollNavigationType | null;
  isPopNavigation?: boolean;
  locationState?: unknown;
  suppressTaskDashboardRestore?: boolean;
}

const ROOT_ROUTE_KEYS = {
  dashboard: "mobile:dashboard",
  "task-list": "mobile:tasks:list",
  "chat-list": "mobile:chats:list",
} as const satisfies Partial<Record<MobileRouteMeta["route"], MobileScrollRestorationKey>>;

type MobileRootScrollRoute = keyof typeof ROOT_ROUTE_KEYS;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isMobileRootScrollRoute(route: MobileRouteMeta["route"]): route is MobileRootScrollRoute {
  return Object.prototype.hasOwnProperty.call(ROOT_ROUTE_KEYS, route);
}

export function createBridgeMobileScrollRestoreState(
  state?: Readonly<Record<string, unknown>> | null,
): BridgeMobileScrollRestoreState & Record<string, unknown> {
  return {
    ...(state ?? {}),
    [BRIDGE_MOBILE_SCROLL_RESTORE_STATE]: true,
  };
}

export function hasBridgeMobileScrollRestoreState(state: unknown): boolean {
  return isRecord(state) && state[BRIDGE_MOBILE_SCROLL_RESTORE_STATE] === true;
}

export function hasTaskDashboardFocusParams(search: string | URLSearchParams): boolean {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  return params.has("section") || params.has("checklistItem");
}

function isPopNavigation({ navigationType, isPopNavigation }: MobileScrollRestorationOptions): boolean {
  return isPopNavigation ?? navigationType === "POP";
}

export function getMobileScrollRestorationPolicy(
  routeMeta: MobileRouteMeta,
  options: MobileScrollRestorationOptions = {},
): MobileScrollRestorationPolicy | null {
  if (isMobileRootScrollRoute(routeMeta.route)) {
    return { key: ROOT_ROUTE_KEYS[routeMeta.route], restore: true };
  }

  if (routeMeta.route !== "task-dashboard" || !routeMeta.taskId) {
    return null;
  }

  const restore = !options.suppressTaskDashboardRestore
    && (isPopNavigation(options) || hasBridgeMobileScrollRestoreState(options.locationState));

  return {
    key: `mobile:task-dashboard:${routeMeta.taskId}`,
    restore,
  };
}
