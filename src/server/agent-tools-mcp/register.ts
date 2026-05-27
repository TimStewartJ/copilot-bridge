import { isBridgeReleaseMode } from "../distribution-mode.js";
import type { AppContext } from "../app-context.js";
import { registerChecklistTools } from "../tools/checklist-tools.js";
import { registerDocsTools } from "../tools/docs-tools.js";
import { registerFeedTools } from "../tools/feed-tools.js";
import { registerReportIntentTool } from "../tools/report-intent-tool.js";
import { registerScheduleTools } from "../tools/schedule-tools.js";
import { registerTagTools } from "../tools/tag-tools.js";
import { registerTaskTools } from "../tools/task-tools.js";
import { registerTaskGroupTools } from "../tools/task-group-tools.js";
import { BRIDGE_TOOLS_REPO_ROOT } from "../tools/helpers.js";
import type { BridgeToolsMcpServer } from "./server.js";

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
  }

  registerReportIntentTool(server, ctx);
  registerTaskTools(server, ctx, { hiddenTools });
  registerTaskGroupTools(server, ctx, { hiddenTools });
  registerTagTools(server, ctx, { hiddenTools });
  registerChecklistTools(server, ctx, { hiddenTools });
  registerFeedTools(server, ctx, { hiddenTools });
  registerScheduleTools(server, ctx, { hiddenTools });
  registerDocsTools(server, ctx, { hiddenTools });
}
