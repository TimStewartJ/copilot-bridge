import { createBrowserSessionTools } from "./browser-session-tools.js";
import { createComputerUseTools } from "./computer-use-tools.js";
import type { AppContext } from "./app-context.js";
import { createAttachmentTools } from "./tools/attachment-tools.js";
import { createDeferTools } from "./tools/defer-tools.js";
import { createSessionTools } from "./tools/session-tools.js";
import { createVisualTools } from "./tools/visual-tools.js";
import { requireToolHandlers } from "./tool-handler.js";

export function createBridgeTools(ctx: AppContext) {
  return requireToolHandlers([
    ...createSessionTools(ctx),
    ...createAttachmentTools(ctx),
    ...createVisualTools(ctx),
    ...createDeferTools(ctx),
    ...createBrowserSessionTools(ctx),
    ...createComputerUseTools(ctx),
  ]);
}
