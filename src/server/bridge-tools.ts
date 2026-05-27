import { createBrowserSessionToolDefinitions } from "./browser-session-tools.js";
import { createComputerUseSessionTools, createStatelessComputerUseTools } from "./computer-use-tools.js";
import type { AppContext } from "./app-context.js";
import { createAttachmentToolDefinitions } from "./tools/attachment-tools.js";
import { createChecklistToolDefinitions } from "./tools/checklist-tools.js";
import { createDeferToolDefinitions } from "./tools/defer-tools.js";
import { createDocsToolDefinitions } from "./tools/docs-tools.js";
import { createFeedToolDefinitions } from "./tools/feed-tools.js";
import { createReportIntentToolDefinitions } from "./tools/report-intent-tool.js";
import { createScheduleToolDefinitions } from "./tools/schedule-tools.js";
import { createSelfAdminToolDefinitions } from "./tools/self-admin-tools.js";
import { createSessionToolDefinitions } from "./tools/session-tools.js";
import { createTagToolDefinitions } from "./tools/tag-tools.js";
import { createTaskGroupToolDefinitions } from "./tools/task-group-tools.js";
import { createTaskToolDefinitions } from "./tools/task-tools.js";
import { createVisualToolDefinitions } from "./tools/visual-tools.js";
import { createStagingToolDefinitions } from "./staging-tools.js";
import { createWebSearchTools } from "./web-search-tools.js";
import { createBrowserFetchTools } from "./browser-fetch-tools.js";
import { createBrowserExecTools } from "./browser-exec-tools.js";
import type { BridgeToolDefinition } from "./agent-tools-mcp/index.js";

/** Compatibility helper for direct tool-definition tests during the MCP migration. */
export function createBridgeTools(ctx: AppContext): BridgeToolDefinition[] {
  return [
    ...createReportIntentToolDefinitions(ctx),
    ...createTaskToolDefinitions(ctx),
    ...createTaskGroupToolDefinitions(ctx),
    ...createTagToolDefinitions(ctx),
    ...createChecklistToolDefinitions(ctx),
    ...createSessionToolDefinitions(ctx),
    ...createAttachmentToolDefinitions(ctx),
    ...createVisualToolDefinitions(ctx),
    ...createFeedToolDefinitions(ctx),
    ...createScheduleToolDefinitions(ctx),
    ...createDeferToolDefinitions(ctx),
    ...createDocsToolDefinitions(ctx),
    ...createSelfAdminToolDefinitions(ctx),
    ...createStagingToolDefinitions(),
    ...createWebSearchTools(ctx),
    ...createBrowserFetchTools(ctx),
    ...createBrowserExecTools(ctx),
    ...createBrowserSessionToolDefinitions(ctx),
    ...createStatelessComputerUseTools(),
    ...createComputerUseSessionTools(ctx),
  ];
}
