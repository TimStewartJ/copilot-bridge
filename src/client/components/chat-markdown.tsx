import type { Components } from "react-markdown";
import { parseAdoWorkReferenceUrl } from "../../shared/ado-work-reference";
import { isRecord } from "../../shared/is-record";
import { DS, cx } from "../design/tokens";
import CodeBlock from "./CodeBlock";
import ChatDocLink from "./ChatDocLink";
import ChatWorkReferencePreview from "./ChatWorkReferencePreview";
import { BridgeReferenceCard, BridgeReferenceChip, parseChatBridgeLink } from "./BridgeReference";
import { openFile, parseOutboundAttachmentLink, showImages } from "./ChatAttachments";
import { OutboundAttachment } from "./FilePreview";
import { filePreviewKind, type PreviewFile } from "./file-preview";

function extractNodeText(node: unknown): string {
  if (!isRecord(node)) return "";
  if (node.type === "text" && typeof node.value === "string") return node.value;
  if (!Array.isArray(node.children)) return "";
  return node.children.map(extractNodeText).join("");
}

function standaloneLink(node: unknown): { url: string; label: string } | null {
  if (!isRecord(node) || !Array.isArray(node.children) || node.children.length !== 1) return null;
  const link = node.children[0];
  if (!isRecord(link) || link.type !== "element" || link.tagName !== "a") return null;
  const properties = link.properties;
  if (!isRecord(properties) || typeof properties.href !== "string") return null;
  return { url: properties.href, label: extractNodeText(link) };
}

/** A paragraph containing only sent-file links becomes their cards. */
function attachmentParagraph(node: unknown): PreviewFile[] | null {
  if (!isRecord(node) || !Array.isArray(node.children)) return null;
  const files: PreviewFile[] = [];
  for (const child of node.children) {
    if (!isRecord(child)) return null;
    if (child.type === "text" && typeof child.value === "string" && !/[\p{L}\p{N}]/u.test(child.value)) continue;
    if (child.type !== "element") return null;
    if (child.tagName === "br") continue;
    const href = child.tagName === "a" && isRecord(child.properties) ? child.properties.href : null;
    const file = typeof href === "string" ? parseOutboundAttachmentLink(href) : null;
    if (!file) return null;
    files.push(file);
  }
  return files.length > 0 ? files : null;
}

function meaningfulLabel(label: string, url: string): string | undefined {
  const trimmed = label.trim();
  return trimmed && trimmed !== url.trim() ? trimmed : undefined;
}

const ChatMarkdownParagraph: NonNullable<Components["p"]> = ({ node, children, ...props }) => {
  const link = standaloneLink(node);
  const workReference = link ? parseAdoWorkReferenceUrl(link.url) : null;
  if (link && workReference) return <ChatWorkReferencePreview {...link} reference={workReference} />;
  const files = attachmentParagraph(node);
  if (files) return <>{files.map((file, index) => <OutboundAttachment key={`${file.url}-${index}`} {...file} />)}</>;
  if (link?.url.startsWith("wiki:")) return <ChatDocLink target={link.url.slice(5)} label={link.label} card />;
  const bridgeTarget = link ? parseChatBridgeLink(link.url) : null;
  if (link && bridgeTarget) return <BridgeReferenceCard target={bridgeTarget} label={meaningfulLabel(link.label, link.url)} />;
  return <p {...props}>{children}</p>;
};

const ChatMarkdownLink: NonNullable<Components["a"]> = ({ node, children, href, ...props }) => {
  if (href?.startsWith("wiki:")) return <ChatDocLink target={href.slice(5)} label={extractNodeText(node)} />;
  const bridgeTarget = parseChatBridgeLink(href);
  if (bridgeTarget) return <BridgeReferenceChip target={bridgeTarget} label={meaningfulLabel(extractNodeText(node), href ?? "")} />;
  const file = parseOutboundAttachmentLink(href);
  if (file && filePreviewKind(file.name)) {
    return (
      <button type="button" onClick={() => openFile(file)} className={cx("text-left text-accent hover:underline", DS.focus)} title={`Open ${file.name}`}>
        {extractNodeText(node) === `Download ${file.name}` ? file.name : children}
      </button>
    );
  }
  return <a href={href} {...(file ? { download: file.name } : {})} {...props}>{children}</a>;
};

const ChatMarkdownImage: NonNullable<Components["img"]> = ({ node: _node, src, alt, title }) => {
  if (typeof src !== "string" || !src) return null;
  const name = alt?.trim() || src.split(/[?#]/)[0].split("/").pop() || "image";
  const outbound = parseOutboundAttachmentLink(src);
  return (
    <button
      type="button"
      onClick={(event) => showImages([{
        src, name, alt: alt ?? name,
        ...(outbound ? { fileName: outbound.name } : {}),
        element: event.currentTarget.querySelector("img"),
      }], 0)}
      className={cx("not-prose my-1 block max-w-full cursor-zoom-in overflow-hidden rounded-2xl border border-surface-edge bg-surface-inset align-top transition-opacity hover:opacity-90", DS.focus)}
      aria-label={`Open image ${name}`}
      title={title ?? name}
    >
      <img src={src} alt={alt ?? name} loading="lazy" className="m-0 block max-h-96 w-auto max-w-full object-contain" />
    </button>
  );
};

export const MESSAGE_MARKDOWN_COMPONENTS: Components = {
  pre: CodeBlock,
  p: ChatMarkdownParagraph,
  a: ChatMarkdownLink,
  img: ChatMarkdownImage,
};
