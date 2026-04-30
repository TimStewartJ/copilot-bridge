import { defineTool } from "@github/copilot-sdk";
import { homedir } from "node:os";
import { join } from "node:path";
import { publishHtmlArtifact, publishMermaidArtifact, publishVegaLiteArtifact, publishVisualArtifact } from "../visual-artifacts.js";
import { resolvePublishableAttachmentSourcePath } from "../session-formatting.js";
import { toolFailure } from "../tool-results.js";
import type { AppContext } from "../app-context.js";
import { BRIDGE_TOOLS_REPO_ROOT, getAttachmentApiBasePath } from "./helpers.js";

export function createVisualTools(ctx: AppContext) {
  return [
  defineTool("publish_visual", {
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
      if (args.kind !== "image" && args.kind !== "mermaid" && args.kind !== "vega-lite" && args.kind !== "html") {
        return toolFailure("kind must be \"image\", \"mermaid\", \"vega-lite\", or \"html\"");
      }

      const copilotHome = ctx.copilotHome ?? join(homedir(), ".copilot");
      const title = typeof args.title === "string" ? args.title : "";

      if (args.kind === "mermaid") {
        const source = typeof args.content === "string" ? args.content : "";
        const published = publishMermaidArtifact({
          copilotHome,
          sessionId: invocation.sessionId,
          title,
          source,
          ...(typeof args.displayName === "string" ? { displayName: args.displayName } : {}),
          ...(typeof args.caption === "string" ? { caption: args.caption } : {}),
          apiBasePath: getAttachmentApiBasePath(ctx),
        });
        if (!published.ok) return toolFailure(published.error);

        const artifact = published.value;
        ctx.eventBusRegistry.getBus(invocation.sessionId)?.emit({
          type: "visual_published",
          artifactId: artifact.artifactId,
          kind: artifact.kind,
          title: artifact.title,
          displayName: artifact.displayName,
          mimeType: artifact.mimeType,
          size: artifact.size,
          url: artifact.url,
          downloadUrl: artifact.downloadUrl,
          source: artifact.source,
          ...(artifact.caption ? { caption: artifact.caption } : {}),
        });

        return {
          __kind: "visual.published",
          success: true,
          artifactId: artifact.artifactId,
          kind: artifact.kind,
          title: artifact.title,
          displayName: artifact.displayName,
          mimeType: artifact.mimeType,
          size: artifact.size,
          url: artifact.url,
          downloadUrl: artifact.downloadUrl,
          ...(artifact.caption ? { caption: artifact.caption } : {}),
          content: `Mermaid diagram "${artifact.title}" published as a visual card.`,
        };
      }

      if (args.kind === "vega-lite") {
        // Accept spec as a JSON string or a pre-parsed object (some tool-call paths pass objects)
        const spec: string | object = typeof args.content === "string"
          ? args.content
          : (args.content !== null && typeof args.content === "object" ? args.content : "");
        const published = publishVegaLiteArtifact({
          copilotHome,
          sessionId: invocation.sessionId,
          title,
          spec,
          ...(typeof args.displayName === "string" ? { displayName: args.displayName } : {}),
          ...(typeof args.caption === "string" ? { caption: args.caption } : {}),
          apiBasePath: getAttachmentApiBasePath(ctx),
        });
        if (!published.ok) return toolFailure(published.error);

        const artifact = published.value;
        ctx.eventBusRegistry.getBus(invocation.sessionId)?.emit({
          type: "visual_published",
          artifactId: artifact.artifactId,
          kind: artifact.kind,
          title: artifact.title,
          displayName: artifact.displayName,
          mimeType: artifact.mimeType,
          size: artifact.size,
          url: artifact.url,
          downloadUrl: artifact.downloadUrl,
          source: artifact.source,
          ...(artifact.caption ? { caption: artifact.caption } : {}),
        });

        return {
          __kind: "visual.published",
          success: true,
          artifactId: artifact.artifactId,
          kind: artifact.kind,
          title: artifact.title,
          displayName: artifact.displayName,
          mimeType: artifact.mimeType,
          size: artifact.size,
          url: artifact.url,
          downloadUrl: artifact.downloadUrl,
          ...(artifact.caption ? { caption: artifact.caption } : {}),
          content: `Vega-Lite chart "${artifact.title}" published as a visual card.`,
        };
      }

      if (args.kind === "html") {
        const htmlContent = typeof args.content === "string" ? args.content : "";
        const published = publishHtmlArtifact({
          copilotHome,
          sessionId: invocation.sessionId,
          title,
          content: htmlContent,
          ...(typeof args.displayName === "string" ? { displayName: args.displayName } : {}),
          ...(typeof args.caption === "string" ? { caption: args.caption } : {}),
          apiBasePath: getAttachmentApiBasePath(ctx),
        });
        if (!published.ok) return toolFailure(published.error);

        const artifact = published.value;
        ctx.eventBusRegistry.getBus(invocation.sessionId)?.emit({
          type: "visual_published",
          artifactId: artifact.artifactId,
          kind: artifact.kind,
          title: artifact.title,
          displayName: artifact.displayName,
          mimeType: artifact.mimeType,
          size: artifact.size,
          url: artifact.url,
          downloadUrl: artifact.downloadUrl,
          source: artifact.source,
          ...(artifact.caption ? { caption: artifact.caption } : {}),
        });

        return {
          __kind: "visual.published",
          success: true,
          artifactId: artifact.artifactId,
          kind: artifact.kind,
          title: artifact.title,
          displayName: artifact.displayName,
          mimeType: artifact.mimeType,
          size: artifact.size,
          url: artifact.url,
          downloadUrl: artifact.downloadUrl,
          ...(artifact.caption ? { caption: artifact.caption } : {}),
          content: `HTML sandbox "${artifact.title}" published as a visual card.`,
        };
      }

      // kind === "image"
      const rawPath = typeof args.path === "string" ? args.path.trim() : "";
      const content = typeof args.content === "string" ? args.content : undefined;

      // Infer mimeType from path extension when not provided
      let mimeType = typeof args.mimeType === "string" ? args.mimeType.trim() : "";
      if (!mimeType && rawPath) {
        const { inferOutboundAttachmentMimeType } = await import("../outbound-attachments.js");
        mimeType = inferOutboundAttachmentMimeType(rawPath);
      }
      if (!mimeType) mimeType = "image/png";

      const published = publishVisualArtifact({
        copilotHome,
        sessionId: invocation.sessionId,
        kind: "image",
        title,
        mimeType,
        ...(rawPath ? { sourcePath: resolvePublishableAttachmentSourcePath(rawPath, BRIDGE_TOOLS_REPO_ROOT) } : {}),
        ...(content !== undefined ? { content } : {}),
        ...(typeof args.displayName === "string" ? { displayName: args.displayName } : {}),
        ...(typeof args.caption === "string" ? { caption: args.caption } : {}),
        ...(typeof args.altText === "string" ? { altText: args.altText } : {}),
        apiBasePath: getAttachmentApiBasePath(ctx),
      });
      if (!published.ok) return toolFailure(published.error);

      const artifact = published.value;
      // Emit visual_published to the session event bus so live SSE clients get a visual card
      ctx.eventBusRegistry.getBus(invocation.sessionId)?.emit({
        type: "visual_published",
        artifactId: artifact.artifactId,
        kind: artifact.kind,
        title: artifact.title,
        displayName: artifact.displayName,
        mimeType: artifact.mimeType,
        size: artifact.size,
        url: artifact.url,
        downloadUrl: artifact.downloadUrl,
        ...(artifact.caption ? { caption: artifact.caption } : {}),
        ...(artifact.altText ? { altText: artifact.altText } : {}),
      });

      return {
        __kind: "visual.published",
        success: true,
        artifactId: artifact.artifactId,
        kind: artifact.kind,
        title: artifact.title,
        displayName: artifact.displayName,
        mimeType: artifact.mimeType,
        size: artifact.size,
        url: artifact.url,
        downloadUrl: artifact.downloadUrl,
        ...(artifact.caption ? { caption: artifact.caption } : {}),
        ...(artifact.altText ? { altText: artifact.altText } : {}),
        content: `Visual artifact "${artifact.title}" published as a visual card.`,
      };
    },
  }),
  ];
}
