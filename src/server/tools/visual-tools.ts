import { toolFailure } from "../tool-results.js";
import type { AppContext } from "../app-context.js";
import { sessionVisualOwner } from "../visual-artifacts.js";
import { emitVisualPublished, publishVisualFromToolArgs, visualPublishedToolResult } from "./visual-tool-publisher.js";
import {
  defineBridgeTool,
  registerBridgeToolDefinitions,
} from "../agent-tools-mcp/adapter.js";
import type { BridgeToolDefinition, BridgeToolsMcpServer } from "../agent-tools-mcp/server.js";

export interface RegisterVisualToolsOptions {
  hiddenTools?: ReadonlySet<string>;
}

export function createVisualToolDefinitions(ctx: AppContext): BridgeToolDefinition[] {
  return [
  defineBridgeTool("publish_visual", {
    scope: "session",
    description:
      "Publish a visual artifact that appears as a rendered card in the chat. " +
      "Use kind \"image\" for screenshots, charts, and photos (PNG/JPEG/GIF/WebP/BMP). " +
      "Use kind \"mermaid\" for Mermaid diagram source — the client renders it in the browser. " +
      "Use kind \"vega-lite\" for Vega-Lite JSON specs — provide the spec as a JSON string in `content`. " +
      "Only inline data (data.values) is allowed for vega-lite; data.url is rejected. " +
      "Use kind \"html\" for interactive HTML content — rendered in a sandboxed iframe (no network, no same-origin). " +
      "For images: provide exactly one of `path` (absolute path to an existing image file) or `content` (base64-encoded bytes). " +
      "For mermaid: provide `content` as plain text Mermaid diagram source (no base64). " +
      "For vega-lite: provide `content` as a JSON string (or object) containing the Vega-Lite spec. " +
      "For html: provide `content` as plain text HTML (no base64). " +
      "SVG is not supported for images. " +
      "Artifacts render inline automatically — you do not need to include any markdown for them.",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["image", "mermaid", "vega-lite", "html"], description: "Visual artifact kind: \"image\", \"mermaid\", \"vega-lite\", or \"html\"." },
        title: { type: "string", description: "Short title for the artifact (displayed above the card)." },
        path: { type: "string", description: "Absolute path to an existing image file to publish (image kind only)." },
        content: { type: "string", description: "Base64-encoded image bytes (image kind), plain text Mermaid source (mermaid kind), Vega-Lite JSON spec string (vega-lite kind), or plain text HTML (html kind)." },
        mimeType: { type: "string", description: "MIME type of the image (e.g. image/png). Required for image with content; inferred from path extension when omitted. Not used for mermaid or vega-lite." },
        displayName: { type: "string", description: "Optional filename shown in the download link." },
        caption: { type: "string", description: "Optional caption displayed below the artifact." },
        altText: { type: "string", description: "Optional alt text for accessibility (image kind only)." },
      },
      required: ["kind", "title"],
    },
    handler: async (args: any, invocation: any) => {
      if (!invocation.sessionId) return toolFailure("sessionId is required");
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
