import { STAGING_TOOLS } from "./staging-tools.js";
import { createWebSearchTools } from "./web-search-tools.js";
import { createBrowserFetchTools } from "./browser-fetch-tools.js";
import { createBrowserExecTools } from "./browser-exec-tools.js";
import { createBrowserSessionTools } from "./browser-session-tools.js";
import { createComputerUseTools } from "./computer-use-tools.js";
import type { AppContext } from "./app-context.js";
import { createAttachmentTools } from "./tools/attachment-tools.js";
import { createChecklistTools } from "./tools/checklist-tools.js";
import { createDeferTools } from "./tools/defer-tools.js";
import { createDocsTools } from "./tools/docs-tools.js";
import { isDemoMode } from "./tools/helpers.js";
import { createScheduleTools } from "./tools/schedule-tools.js";
import { createSelfAdminTools } from "./tools/self-admin-tools.js";
import { createSessionTools } from "./tools/session-tools.js";
import { createTagTools } from "./tools/tag-tools.js";
import { createTaskGroupTools } from "./tools/task-group-tools.js";
import { createTaskTools } from "./tools/task-tools.js";
import { createVisualTools } from "./tools/visual-tools.js";

export function createBridgeTools(ctx: AppContext) {
  const demoMode = isDemoMode(ctx.runtimePaths);
  const tools = [
    ...createTaskTools(ctx),
    ...createTaskGroupTools(ctx),
    ...createTagTools(ctx),
    ...createChecklistTools(ctx),
    ...createSessionTools(ctx),
    ...createAttachmentTools(ctx),
    ...createVisualTools(ctx),
    ...createSelfAdminTools(ctx),
    ...createScheduleTools(ctx),
    ...createDeferTools(ctx),
    ...createDocsTools(ctx),
    ...(demoMode ? [] : STAGING_TOOLS),
    ...createWebSearchTools(ctx),
    ...createBrowserFetchTools(ctx),
    ...createBrowserExecTools(ctx),
    ...createBrowserSessionTools(ctx),
    ...createComputerUseTools(ctx),
  ];

  if (!demoMode) return tools;

  const hiddenTools = new Set<string>([
    "self_restart",
    "self_update",
    ...STAGING_TOOLS.map((tool) => tool.name),
  ]);
  return tools.filter((tool) => !hiddenTools.has(tool.name));
}
