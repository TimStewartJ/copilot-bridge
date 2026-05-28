import { isBridgeReleaseMode } from "../distribution-mode.js";
import type { AppContext } from "../app-context.js";
import { registerAttachmentTools } from "../tools/attachment-tools.js";
import { registerBrowserSessionTools } from "../browser-session-tools.js";
import { registerChecklistTools } from "../tools/checklist-tools.js";
import { registerDocsTools } from "../tools/docs-tools.js";
import { registerDeferTools } from "../tools/defer-tools.js";
import { registerFeedTools } from "../tools/feed-tools.js";
import { registerReportIntentTool } from "../tools/report-intent-tool.js";
import { registerManagementJobTools } from "../tools/management-job-tools.js";
import { registerScheduleTools } from "../tools/schedule-tools.js";
import { registerSelfAdminTools } from "../tools/self-admin-tools.js";
import { registerSessionTools } from "../tools/session-tools.js";
import { registerTagTools } from "../tools/tag-tools.js";
import { registerTaskTools } from "../tools/task-tools.js";
import { registerTaskGroupTools } from "../tools/task-group-tools.js";
import { registerVisualTools } from "../tools/visual-tools.js";
import { BRIDGE_TOOLS_REPO_ROOT } from "../tools/helpers.js";
import { registerStagingTools, STAGING_TOOLS } from "../staging-tools.js";
import { registerWebSearchTools } from "../web-search-tools.js";
import { registerBrowserFetchTools } from "../browser-fetch-tools.js";
import { registerBrowserExecTools } from "../browser-exec-tools.js";
import { registerComputerUseSessionTools, registerComputerUseStatelessTools } from "../computer-use-tools.js";
import type { BridgeToolDefinition, BridgeToolsMcpServer } from "./server.js";

export interface RegisterAllBridgeToolsOptions {
  excludedToolNames?: Iterable<string>;
}

function isReleaseMode(ctx: AppContext): boolean {
  return ctx.runtimePaths?.distributionMode === "release" || isBridgeReleaseMode(process.env, BRIDGE_TOOLS_REPO_ROOT);
}

export function registerAllBridgeTools(
  server: BridgeToolsMcpServer,
  ctx: AppContext,
  options: RegisterAllBridgeToolsOptions = {},
): void {
  const hiddenTools = new Set<string>(options.excludedToolNames ?? []);
  if (isReleaseMode(ctx)) {
    hiddenTools.add("self_update");
    for (const tool of STAGING_TOOLS) hiddenTools.add(tool.name);
  }

  registerReportIntentTool(server, ctx);
  registerManagementJobTools(server, ctx, { hiddenTools });
  registerTaskTools(server, ctx, { hiddenTools });
  registerTaskGroupTools(server, ctx, { hiddenTools });
  registerTagTools(server, ctx, { hiddenTools });
  registerChecklistTools(server, ctx, { hiddenTools });
  registerFeedTools(server, ctx, { hiddenTools });
  registerScheduleTools(server, ctx, { hiddenTools });
  registerDocsTools(server, ctx, { hiddenTools });
  registerSelfAdminTools(server, ctx, { hiddenTools });
  registerStagingTools(server, ctx, { hiddenTools });
  registerWebSearchTools(server, ctx);
  registerBrowserFetchTools(server, ctx);
  registerBrowserExecTools(server, ctx);
  registerComputerUseStatelessTools(server, ctx);
  registerSessionTools(server, ctx, { hiddenTools });
  registerAttachmentTools(server, ctx, { hiddenTools });
  registerVisualTools(server, ctx, { hiddenTools });
  registerDeferTools(server, ctx, { hiddenTools });
  registerBrowserSessionTools(server, ctx, { hiddenTools });
  registerComputerUseSessionTools(server, ctx);
}

export function getBridgeToolDefinitions(
  ctx: AppContext,
  options: RegisterAllBridgeToolsOptions = {},
): BridgeToolDefinition[] {
  const definitions: BridgeToolDefinition[] = [];
  const collector = {
    registerTool(definition: BridgeToolDefinition): void {
      definitions.push(definition);
    },
  };
  registerAllBridgeTools(collector as BridgeToolsMcpServer, ctx, options);
  return definitions;
}
