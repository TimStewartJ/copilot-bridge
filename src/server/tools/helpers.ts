import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { ok, err, type Result } from "../tool-results.js";
import type { AppContext } from "../app-context.js";
import type { GlobalBus } from "../global-bus.js";
import type { EventBusRegistry } from "../event-bus.js";
import type { Task } from "../task-store.js";
import type { ChecklistStore } from "../checklist-store.js";
import type { TagStore } from "../tag-store.js";
import type { TaskGroupStore } from "../task-group-store.js";
import type { SessionTitlesStore } from "../session-titles.js";
import type { RuntimePaths } from "../runtime-paths.js";

export const BRIDGE_TOOLS_REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export function isDemoMode(runtimePaths?: RuntimePaths): boolean {
  return runtimePaths?.demoMode ?? false;
}

export function ensureTask(ctx: AppContext, taskId: string): Result<Task> {
  const task = ctx.taskStore.getTask(taskId);
  return task ? ok(task) : err(`Task ${taskId} not found`);
}

export function ensureTaskGroup(
  ctx: AppContext,
  groupId: string,
): Result<NonNullable<ReturnType<TaskGroupStore["getGroup"]>>> {
  const group = ctx.taskGroupStore.getGroup(groupId);
  return group ? ok(group) : err(`Group ${groupId} not found`);
}

export function ensureTagStore(ctx: AppContext): Result<TagStore> {
  return ctx.tagStore ? ok(ctx.tagStore) : err("Tags not available");
}

export function ensureTag(ctx: AppContext, tagId: string): Result<NonNullable<ReturnType<TagStore["getTag"]>>> {
  const tagStore = ensureTagStore(ctx);
  if (!tagStore.ok) return tagStore;
  const tag = tagStore.value.getTag(tagId);
  return tag ? ok(tag) : err(`Tag ${tagId} not found`);
}

export function ensureChecklistItem(ctx: AppContext, checklistItemId: string): Result<NonNullable<ReturnType<ChecklistStore["getChecklistItem"]>>> {
  const checklistItem = ctx.checklistStore.getChecklistItem(checklistItemId);
  return checklistItem ? ok(checklistItem) : err(`Checklist item ${checklistItemId} not found`);
}

export function getAttachmentApiBasePath(ctx: AppContext): string {
  const explicitBasePath = ctx.apiBasePath?.trim();
  if (explicitBasePath) {
    return explicitBasePath;
  }
  if (ctx.isStaging) {
    const stagingRootName = ctx.runtimePaths?.dataDir
      ? basename(dirname(ctx.runtimePaths.dataDir))
      : basename(BRIDGE_TOOLS_REPO_ROOT);
    const prefix = `${stagingRootName}${ctx.runtimePaths?.demoMode ? "-demo" : ""}`;
    return `/staging/${prefix}/api`;
  }
  return "/api";
}

export function storeSessionTitle(
  sessionTitles: SessionTitlesStore,
  eventBusRegistry: EventBusRegistry,
  globalBus: GlobalBus,
  sessionId: string,
  title: string,
): void {
  sessionTitles.setTitle(sessionId, title);
  eventBusRegistry.getBus(sessionId)?.emit({ type: "title_changed", title });
  globalBus.emit({ type: "session:title", sessionId, title });
}

export function resolveDemoWorkspaceDir(runtimePaths?: RuntimePaths): string | undefined {
  if (!isDemoMode(runtimePaths)) return undefined;
  return runtimePaths?.workspaceDir ?? (runtimePaths ? join(resolve(runtimePaths.dataDir), "workspace") : undefined);
}
