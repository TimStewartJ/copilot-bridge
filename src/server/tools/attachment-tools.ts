import { homedir } from "node:os";
import { join } from "node:path";
import { publishOutboundAttachment } from "../outbound-attachments.js";
import { renderPublishedAttachment, resolvePublishableAttachmentSourcePath } from "../session-formatting.js";
import { toolFailure } from "../tool-results.js";
import type { AppContext } from "../app-context.js";
import { BRIDGE_TOOLS_REPO_ROOT, getAttachmentApiBasePath } from "./helpers.js";
import {
  defineBridgeTool,
  registerBridgeToolDefinitions,
} from "../agent-tools-mcp/adapter.js";
import type { BridgeToolDefinition, BridgeToolsMcpServer } from "../agent-tools-mcp/server.js";

export interface RegisterAttachmentToolsOptions {
  hiddenTools?: ReadonlySet<string>;
}

export function createAttachmentToolDefinitions(ctx: AppContext): BridgeToolDefinition[] {
  return [
  defineBridgeTool("send_attachment", {
    scope: "session",
    description:
      "Publish a file as an attachment the user can open or download. " +
      "Use this when the user asks you to send them a file, export, image, report, or other artifact. " +
      "Provide exactly one of `path` or `content`. When using `path`, absolute paths work best and relative paths resolve from the bridge repository root. " +
      "After calling this tool, include the returned `markdown` snippet verbatim in your next assistant response so the attachment appears in chat.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or repository-relative path of an existing file to publish." },
        content: { type: "string", description: "UTF-8 text content to write into a new attachment file." },
        displayName: { type: "string", description: "Optional filename to show the user. Required when using content." },
      },
    },
    handler: async (args: any, invocation: any) => {
      if (!invocation.sessionId) return toolFailure("sessionId is required");

      const rawPath = typeof args.path === "string" ? args.path.trim() : "";
      const content = typeof args.content === "string" ? args.content : undefined;
      const attachmentApiBasePath = getAttachmentApiBasePath(ctx);
      const published = publishOutboundAttachment({
        copilotHome: ctx.copilotHome ?? join(homedir(), ".copilot"),
        sessionId: invocation.sessionId,
        ...(rawPath ? { sourcePath: resolvePublishableAttachmentSourcePath(rawPath, BRIDGE_TOOLS_REPO_ROOT) } : {}),
        ...(content !== undefined ? { content } : {}),
        ...(typeof args.displayName === "string" ? { displayName: args.displayName } : {}),
      });
      if (!published.ok) return toolFailure(published.error);

      const attachment = published.value;
      const rendered = renderPublishedAttachment(attachmentApiBasePath, invocation.sessionId, attachment);
      const instructions =
        `Attachment "${attachment.displayName}" is ready. ` +
        `In your next response, include this markdown exactly:\n\n${rendered.recommendedMarkdown}`;
      return {
        success: true,
        content: instructions,
        message: `Attachment "${attachment.displayName}" published`,
        attachmentId: attachment.attachmentId,
        displayName: attachment.displayName,
        mimeType: attachment.mimeType,
        size: attachment.size,
        url: rendered.urlPath,
        markdown: rendered.recommendedMarkdown,
        linkMarkdown: rendered.linkMarkdown,
        ...(rendered.imageMarkdown ? { imageMarkdown: rendered.imageMarkdown } : {}),
      };
    },
  }),
  ];
}

export function registerAttachmentTools(
  server: BridgeToolsMcpServer,
  ctx: AppContext,
  options: RegisterAttachmentToolsOptions = {},
): void {
  const definitions = createAttachmentToolDefinitions(ctx)
    .filter((tool) => !options.hiddenTools?.has(tool.name));
  registerBridgeToolDefinitions(server, definitions);
}
