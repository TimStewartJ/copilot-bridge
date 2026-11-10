import { open } from "node:fs/promises";
import type { AppContext } from "../app-context.js";
import { resolvePublishableAttachmentSourcePath } from "../session-formatting.js";
import { MAX_TASK_PAGE_BYTES } from "../task-page-store.js";
import { toolFailure } from "../tool-results.js";
import { BRIDGE_TOOLS_REPO_ROOT, ensureTask } from "./helpers.js";
import {
  defineSessionBridgeTool,
  registerBridgeToolDefinitions,
} from "../agent-tools-mcp/adapter.js";
import type { BridgeToolDefinition, BridgeToolsMcpServer } from "../agent-tools-mcp/server.js";

/** Reads a file of at most `max` bytes, without loading a larger one. */
async function readBounded(path: string, max: number): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch {
    return { ok: false, error: `Page file not found: ${path}` };
  }
  try {
    if (!(await handle.stat()).isFile()) return { ok: false, error: `Page path is not a file: ${path}` };
    const buffer = Buffer.alloc(max + 1);
    const { bytesRead } = await handle.read(buffer, 0, max + 1, 0);
    if (bytesRead > max) return { ok: false, error: `The page is larger than ${Math.round(max / 1024 / 1024)} MB.` };
    return { ok: true, text: buffer.subarray(0, bytesRead).toString("utf8") };
  } finally {
    await handle.close();
  }
}

export function createTaskPageToolDefinitions(ctx: AppContext): BridgeToolDefinition[] {
  return [
    defineSessionBridgeTool("task_page_publish", {
      description:
        "Publish an HTML page on a task, replacing the page it has. The user opens it from the task to see where the task stands at a glance, often on a phone. " +
        "It suits tasks with something to lay out (a trip itinerary, a tracker, applications, an event plan). " +
        "Save the page to a file and pass its `path`. It must be self-contained: inline CSS and scripts, images as data: URLs, nothing loaded from the network. " +
        "Make it readable at phone width and in light and dark mode (prefers-color-scheme). Links open in a new window. " +
        "To change a page, publish the whole page again.",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "The task ID" },
          path: { type: "string", description: "Absolute path of the HTML file to publish." },
        },
        required: ["taskId", "path"],
      },
      handler: async (args: any, invocation: any) => {
        const store = ctx.taskPageStore;
        if (!store) return toolFailure("Task pages are not available");
        const task = ensureTask(ctx, args.taskId);
        if (!task.ok) return toolFailure(task.error);
        const rawPath = typeof args.path === "string" ? args.path.trim() : "";
        if (!rawPath) return toolFailure("path is required");
        const read = await readBounded(resolvePublishableAttachmentSourcePath(rawPath, BRIDGE_TOOLS_REPO_ROOT), MAX_TASK_PAGE_BYTES);
        if (!read.ok) return toolFailure(read.error);
        if (!read.text.trim()) return toolFailure("The page is empty.");
        const page = store.publish(task.value.id, read.text, invocation.sessionId);
        ctx.globalBus.emit({ type: "task:changed", taskId: task.value.id });
        return { success: true, message: `Page published on "${task.value.title}"`, updatedAt: page.updatedAt, size: page.size };
      },
    }),
  ];
}

export function registerTaskPageTools(
  server: BridgeToolsMcpServer,
  ctx: AppContext,
  options: { hiddenTools?: ReadonlySet<string> } = {},
): void {
  registerBridgeToolDefinitions(server, createTaskPageToolDefinitions(ctx).filter((tool) => !options.hiddenTools?.has(tool.name)));
}
