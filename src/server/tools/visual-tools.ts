import { toolFailure } from "../tool-results.js";
import type { AppContext } from "../app-context.js";
import { sessionVisualOwner } from "../visual-artifacts.js";
import { emitVisualPublished, publishVisualFromToolArgs, visualPublishedToolResult, VISUAL_CONTENT_TYPE_SCHEMA, VISUAL_KIND_SCHEMA } from "./visual-tool-publisher.js";
import {
  defineBridgeTool,
  defineSessionBridgeTool,
  registerBridgeToolDefinitions,
} from "../agent-tools-mcp/adapter.js";
import type { BridgeToolDefinition, BridgeToolsMcpServer } from "../agent-tools-mcp/server.js";

export interface RegisterVisualToolsOptions {
  hiddenTools?: ReadonlySet<string>;
}

export function createVisualToolDefinitions(ctx: AppContext): BridgeToolDefinition[] {
  return [
  defineSessionBridgeTool("publish_visual", {
    description:
      "Publish a visual artifact that appears as a rendered card in the chat. " +
      "Use kind \"image\" for screenshots, charts, and photos (PNG/JPEG/GIF/WebP/BMP). " +
      "Use kind \"mermaid\" for Mermaid diagram source — the client renders it in the browser. " +
      "Use kind \"vega-lite\" for Vega-Lite JSON specs — provide the spec as a JSON string in `content`. " +
      "Only inline data (data.values) is allowed for vega-lite; data.url is rejected. " +
      "For HTML, save the page to a file and use send_attachment with its path. " +
      "For images: provide exactly one of `path` (absolute path to an existing image file) or `content` (base64-encoded bytes). " +
      "For mermaid: provide `content` as plain text Mermaid diagram source (no base64). " +
      "For vega-lite: provide `content` as a JSON string (or object) containing the Vega-Lite spec. " +
      "SVG is not supported for images. " +
      "Artifacts render inline automatically — you do not need to include any markdown for them.",
    parameters: {
      type: "object",
      properties: {
        kind: { ...VISUAL_KIND_SCHEMA, description: "Visual artifact kind." },
        title: { type: "string", description: "Short title for the artifact (displayed above the card)." },
        path: { type: "string", description: "Absolute path to an existing image file to publish (image kind only)." },
        content: { ...VISUAL_CONTENT_TYPE_SCHEMA, description: "Base64-encoded image bytes, plain text Mermaid source, or a Vega-Lite JSON spec as a string or object." },
        mimeType: { type: "string", description: "MIME type of the image (e.g. image/png). Required for image with content; inferred from path extension when omitted. Not used for mermaid or vega-lite." },
        displayName: { type: "string", description: "Optional filename shown in the download link." },
        caption: { type: "string", description: "Optional caption displayed below the artifact." },
        altText: { type: "string", description: "Optional alt text for accessibility (image kind only)." },
      },
      required: ["kind", "title"],
    },
    handler: async (args: any, invocation: any) => {
      const published = await publishVisualFromToolArgs(ctx, args, sessionVisualOwner(invocation.sessionId));
      if (!published.ok) return toolFailure(published.error);

      const artifact = published.value;
      emitVisualPublished(ctx, invocation.sessionId, artifact);
      return visualPublishedToolResult(artifact);
    },
  }),
  ];
}

export function registerVisualTools(
  server: BridgeToolsMcpServer,
  ctx: AppContext,
  options: RegisterVisualToolsOptions = {},
): void {
  const definitions = createVisualToolDefinitions(ctx)
    .filter((tool) => !options.hiddenTools?.has(tool.name));
  registerBridgeToolDefinitions(server, definitions);
}
