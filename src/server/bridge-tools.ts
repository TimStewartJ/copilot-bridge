import { STAGING_TOOLS } from "./staging-tools.js";
import { createWebSearchTools } from "./web-search-tools.js";
import { createBrowserFetchTools } from "./browser-fetch-tools.js";
import { createBrowserExecTools } from "./browser-exec-tools.js";
import { createBrowserSessionTools } from "./browser-session-tools.js";
import { createComputerUseTools } from "./computer-use-tools.js";
import { isBridgeReleaseMode } from "./distribution-mode.js";
import type { AppContext } from "./app-context.js";
import { createAttachmentTools } from "./tools/attachment-tools.js";
import { createDeferTools } from "./tools/defer-tools.js";
import { BRIDGE_TOOLS_REPO_ROOT } from "./tools/helpers.js";
import { createSelfAdminTools } from "./tools/self-admin-tools.js";
import { createSessionTools } from "./tools/session-tools.js";
import { createVisualTools } from "./tools/visual-tools.js";
import { requireToolHandlers } from "./tool-handler.js";

function isReleaseMode(ctx: AppContext): boolean {
  return ctx.runtimePaths?.distributionMode === "release" || isBridgeReleaseMode(process.env, BRIDGE_TOOLS_REPO_ROOT);
}

export function createBridgeTools(ctx: AppContext) {
  const releaseMode = isReleaseMode(ctx);
  const tools = requireToolHandlers([
    ...createSessionTools(ctx),
    ...createAttachmentTools(ctx),
    ...createVisualTools(ctx),
    ...createSelfAdminTools(ctx),
    ...createDeferTools(ctx),
    ...(releaseMode ? [] : STAGING_TOOLS),
    ...createWebSearchTools(ctx),
    ...createBrowserFetchTools(ctx),
    ...createBrowserExecTools(ctx),
    ...createBrowserSessionTools(ctx),
    ...createComputerUseTools(ctx),
  ]);

  const hiddenTools = new Set<string>();
  if (releaseMode) {
    hiddenTools.add("self_update");
    for (const tool of STAGING_TOOLS) hiddenTools.add(tool.name);
  }
  if (!hiddenTools.size) return tools;
  return tools.filter((tool) => !hiddenTools.has(tool.name));
}
