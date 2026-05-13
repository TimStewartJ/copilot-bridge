import { homedir } from "node:os";
import { join } from "node:path";
import type { AppContext } from "../app-context.js";
import { inferOutboundAttachmentMimeType } from "../outbound-attachments.js";
import { resolvePublishableAttachmentSourcePath } from "../session-formatting.js";
import { err, ok, type Result } from "../tool-results.js";
import {
  publishHtmlArtifact,
  publishMermaidArtifact,
  publishVegaLiteArtifact,
  publishVisualArtifact,
  type PublishedVisualArtifact,
  type VisualArtifactOwner,
} from "../visual-artifacts.js";
import { BRIDGE_TOOLS_REPO_ROOT, getAttachmentApiBasePath } from "./helpers.js";

export interface VisualPublishArgs {
  kind?: unknown;
  title?: unknown;
  path?: unknown;
  content?: unknown;
  mimeType?: unknown;
  displayName?: unknown;
  caption?: unknown;
  altText?: unknown;
}

export function visualPublishedToolResult(artifact: PublishedVisualArtifact) {
  const noun = artifact.kind === "mermaid"
    ? "Mermaid diagram"
    : artifact.kind === "vega-lite"
      ? "Vega-Lite chart"
      : artifact.kind === "html"
        ? "HTML sandbox"
        : "Visual artifact";
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
    content: `${noun} "${artifact.title}" published as a visual card.`,
  };
}

export function emitVisualPublished(ctx: AppContext, sessionId: string | undefined, artifact: PublishedVisualArtifact): void {
  if (!sessionId) return;
  ctx.eventBusRegistry.getBus(sessionId)?.emit({
    type: "visual_published",
    artifactId: artifact.artifactId,
    kind: artifact.kind,
    title: artifact.title,
    displayName: artifact.displayName,
    mimeType: artifact.mimeType,
    size: artifact.size,
    url: artifact.url,
    downloadUrl: artifact.downloadUrl,
    ...(artifact.source ? { source: artifact.source } : {}),
    ...(artifact.caption ? { caption: artifact.caption } : {}),
    ...(artifact.altText ? { altText: artifact.altText } : {}),
  });
}

export async function publishVisualFromToolArgs(
  ctx: AppContext,
  args: VisualPublishArgs,
  owner: VisualArtifactOwner,
  defaultTitle?: string,
): Promise<Result<PublishedVisualArtifact>> {
  if (args.kind !== "image" && args.kind !== "mermaid" && args.kind !== "vega-lite" && args.kind !== "html") {
    return err("kind must be \"image\", \"mermaid\", \"vega-lite\", or \"html\"");
  }

  const copilotHome = ctx.copilotHome ?? join(homedir(), ".copilot");
  const title = typeof args.title === "string" && args.title.trim() ? args.title : (defaultTitle ?? "");
  const apiBasePath = getAttachmentApiBasePath(ctx);
  const common = {
    copilotHome,
    owner,
    title,
    ...(typeof args.displayName === "string" ? { displayName: args.displayName } : {}),
    ...(typeof args.caption === "string" ? { caption: args.caption } : {}),
    apiBasePath,
  };

  if (args.kind === "mermaid") {
    return publishMermaidArtifact({
      ...common,
      source: typeof args.content === "string" ? args.content : "",
    });
  }

  if (args.kind === "vega-lite") {
    return publishVegaLiteArtifact({
      ...common,
      spec: typeof args.content === "string"
        ? args.content
        : (args.content !== null && typeof args.content === "object" ? args.content : ""),
    });
  }

  if (args.kind === "html") {
    return publishHtmlArtifact({
      ...common,
      content: typeof args.content === "string" ? args.content : "",
    });
  }

  const rawPath = typeof args.path === "string" ? args.path.trim() : "";
  const content = typeof args.content === "string" ? args.content : undefined;
  let mimeType = typeof args.mimeType === "string" ? args.mimeType.trim() : "";
  if (!mimeType && rawPath) {
    mimeType = inferOutboundAttachmentMimeType(rawPath);
  }
  if (!mimeType) mimeType = "image/png";

  return publishVisualArtifact({
    ...common,
    kind: "image",
    mimeType,
    ...(rawPath ? { sourcePath: resolvePublishableAttachmentSourcePath(rawPath, BRIDGE_TOOLS_REPO_ROOT) } : {}),
    ...(content !== undefined ? { content } : {}),
    ...(typeof args.altText === "string" ? { altText: args.altText } : {}),
  });
}

export function stripVisualSource(artifact: PublishedVisualArtifact): Omit<PublishedVisualArtifact, "source" | "metaUrl"> {
  return {
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
  };
}
