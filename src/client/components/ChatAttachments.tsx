import { useRef, useState, type ComponentType } from "react";
import {
  Download,
  File as FileIcon,
  FileArchive,
  FileAudio,
  FileCode2,
  FileImage,
  FileJson,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Loader2,
  X,
} from "lucide-react";
import { API_BASE, type Attachment } from "../api";
import { DS, cx } from "../design/tokens";
import type { ViewerImage } from "./image-viewer";

/**
 * How files and images look wherever a chat shows them: in the composer before sending, on a sent
 * prompt, and when the agent hands a file back with send_attachment. One look for all three so a
 * file reads as the same object on its way in and on its way out.
 */

type IconComponent = ComponentType<{ size?: number; className?: string; "aria-hidden"?: boolean }>;

interface FileDescription {
  Icon: IconComponent;
  /** A short word for the kind of file: "PDF", "CSV", "Image". */
  kind: string;
}

const CODE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "cs", "java", "go", "rs", "rb", "php", "c", "h", "cpp",
  "hpp", "swift", "kt", "sh", "ps1", "psm1", "bat", "cmd", "sql", "html", "htm", "css", "scss", "vue",
]);
const DATA_EXTENSIONS = new Set(["json", "jsonl", "yaml", "yml", "xml", "toml", "ini"]);
const SHEET_EXTENSIONS = new Set(["csv", "tsv", "xls", "xlsx", "ods"]);
const ARCHIVE_EXTENSIONS = new Set(["zip", "tar", "gz", "tgz", "7z", "rar", "cab"]);
const TEXT_EXTENSIONS = new Set(["txt", "md", "log", "rtf", "doc", "docx", "pdf", "pptx", "ppt"]);
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif"]);

export function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : "";
}

export function isImageFileName(name: string): boolean {
  return IMAGE_EXTENSIONS.has(fileExtension(name));
}

export function describeFile(name: string, mimeType?: string): FileDescription {
  const ext = fileExtension(name);
  const mime = (mimeType ?? "").toLowerCase();
  const kind = ext ? ext.toUpperCase() : "File";
  if (mime.startsWith("image/") || IMAGE_EXTENSIONS.has(ext)) return { Icon: FileImage, kind: ext ? kind : "Image" };
  if (mime.startsWith("audio/")) return { Icon: FileAudio, kind: ext ? kind : "Audio" };
  if (mime.startsWith("video/")) return { Icon: FileVideo, kind: ext ? kind : "Video" };
  if (SHEET_EXTENSIONS.has(ext)) return { Icon: FileSpreadsheet, kind };
  if (DATA_EXTENSIONS.has(ext) || mime === "application/json") return { Icon: FileJson, kind };
  if (CODE_EXTENSIONS.has(ext)) return { Icon: FileCode2, kind };
  if (ARCHIVE_EXTENSIONS.has(ext)) return { Icon: FileArchive, kind };
  if (TEXT_EXTENSIONS.has(ext) || mime.startsWith("text/") || mime === "application/pdf") return { Icon: FileText, kind };
  return { Icon: FileIcon, kind };
}

export function formatFileSize(bytes: number | undefined): string | null {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** Decoded size of base64 content, so a pasted file can say how big it is. */
export function base64ByteLength(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

export function attachmentName(att: Attachment): string {
  if (att.displayName) return att.displayName;
  if (att.type === "file") return att.path.split(/[\\/]/).pop() || "file";
  return "file";
}

/** Where the server keeps a file attached to a prompt in this session. */
export function sessionFileUrl(sessionId: string, fileName: string): string {
  return `${API_BASE}/api/sessions/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(fileName)}`;
}

/** True when a recorded file path is a direct child of the session's files/ folder. */
function isSessionUpload(path: string, sessionId: string): boolean {
  const parts = path.split(/[\\/]/).filter(Boolean);
  const n = parts.length;
  return n >= 4
    && parts[n - 2] === "files"
    && parts[n - 3].toLowerCase() === sessionId.toLowerCase()
    && parts[n - 4] === "session-state";
}

/**
 * The URL an attachment can be shown from, when it is an image. The CLI records a sent image
 * without its bytes, so history images come from the copy the upload left in the session.
 */
export function attachmentImageSrc(att: Attachment, sessionId?: string): string | null {
  if (att.type === "blob" && att.mimeType.startsWith("image/")) {
    if (att.data) return `data:${att.mimeType};base64,${att.data}`;
    if (sessionId && att.displayName) return sessionFileUrl(sessionId, att.displayName);
    return null;
  }
  if (att.type === "uploaded" && att.previewUrl) return att.previewUrl;
  if (att.type === "file" && sessionId && isImageFileName(att.path) && isSessionUpload(att.path, sessionId)) {
    return sessionFileUrl(sessionId, attachmentName(att));
  }
  return null;
}

/** A download link for a sent file, when the server still has it. */
function attachmentDownloadUrl(att: Attachment, sessionId?: string): string | undefined {
  if (!sessionId || att.type !== "file" || !isSessionUpload(att.path, sessionId)) return undefined;
  return `${sessionFileUrl(sessionId, att.path.split(/[\\/]/).pop() ?? attachmentName(att))}?download=1`;
}

function attachmentMeta(att: Attachment): { mimeType?: string; size?: number } {
  if (att.type === "blob") return { mimeType: att.mimeType, size: att.data ? base64ByteLength(att.data) : undefined };
  if (att.type === "uploaded") return { mimeType: att.mimeType, size: att.size };
  return {};
}

/** Small round control in the corner of a tile. Shown on hover, focus, and always on touch. */
export const TILE_CORNER_BUTTON = cx(
  "absolute -right-1.5 -top-1.5 z-10 flex h-6 w-6 items-center justify-center rounded-full border border-surface-edge bg-surface-overlay text-text-secondary transition-opacity hover:text-text-primary",
  "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100",
  DS.surface.lift,
  DS.focus,
);

interface FileCardProps {
  name: string;
  mimeType?: string;
  size?: number;
  /** When set, the card downloads the file. */
  href?: string;
  /** The shorter card used in the composer tray, where it sits beside 56px thumbnails. */
  compact?: boolean;
}

/** A file as one object: its kind as an icon, its name, and what it is. */
export function FileCard({ name, mimeType, size, href, compact = false }: FileCardProps) {
  const { Icon, kind } = describeFile(name, mimeType);
  const meta = [kind, formatFileSize(size)].filter(Boolean).join(" · ");
  const body = (
    <>
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-surface-selected text-text-secondary">
        <Icon size={18} aria-hidden />
      </span>
      <span className="min-w-0 flex-1 text-left">
        <span className="block truncate text-[13px] font-medium leading-5 text-text-primary">{name}</span>
        <span className="block truncate text-xs leading-4 text-text-faint">{meta}</span>
      </span>
      {href && (
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-faint transition-colors group-hover/file:text-text-primary">
          <Download size={15} aria-hidden />
        </span>
      )}
    </>
  );
  const frame = cx(
    "group/file flex max-w-full min-w-0 items-center gap-3 rounded-xl border border-surface-edge bg-surface-group p-2 pr-2.5",
    compact ? "h-14 w-60" : "w-72",
  );
  if (href) {
    return (
      <a
        href={href}
        download={name}
        className={cx(frame, "transition-colors hover:bg-surface-selected", DS.focus)}
        aria-label={`Download ${name}`}
        title={`Download ${name}`}
      >
        {body}
      </a>
    );
  }
  return (
    <div className={cx(frame, "relative")} title={name}>
      {body}
    </div>
  );
}

export interface GalleryImage {
  src: string;
  name: string;
  /** Where Download points; the image's own source when omitted. */
  downloadUrl?: string;
  alt?: string;
}

/** Open images full screen. The viewer is loaded on first use. */
export function showImages(images: ViewerImage[], index: number): void {
  void import("./image-viewer")
    .then(({ openImageViewer }) => openImageViewer(images, index))
    .catch((error) => console.error("[image-viewer] failed to open", error));
}

interface ImageGalleryProps {
  images: GalleryImage[];
  /** Which edge the gallery hugs: a prompt sits on the right, a reply on the left. */
  align?: "start" | "end";
}

/**
 * Images sent with a message, shown as a chat app shows them: one image at a readable size, several
 * as a tidy grid of square tiles. Any of them opens full screen, growing out of its thumbnail.
 */
export function ImageGallery({ images, align = "start" }: ImageGalleryProps) {
  const thumbRefs = useRef<Array<HTMLImageElement | null>>([]);
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const shown = images.filter((image) => !failed.has(image.src));
  const missing = images.filter((image) => failed.has(image.src));
  if (images.length === 0) return null;
  const single = shown.length === 1;
  const open = (index: number) => {
    showImages(
      shown.map((image, i) => ({ ...image, element: thumbRefs.current[i], cropped: !single })),
      index,
    );
  };
  const markFailed = (src: string) => setFailed((current) => new Set(current).add(src));
  return (
    <>
    {shown.length > 0 && (
    <div
      className={cx(
        single ? "flex" : "grid gap-1.5",
        !single && (shown.length === 2 || shown.length === 4 ? "grid-cols-2" : "grid-cols-3"),
        align === "end" ? "justify-end self-end" : "justify-start self-start",
      )}
    >
      {shown.map((image, index) => (
        <button
          key={`${image.src.slice(0, 64)}-${index}`}
          type="button"
          onClick={() => open(index)}
          className={cx(
            "block cursor-zoom-in overflow-hidden rounded-2xl border border-surface-edge bg-surface-inset transition-opacity hover:opacity-90",
            DS.focus,
          )}
          aria-label={`Open image ${image.name}`}
          title={image.name}
        >
          <img
            ref={(element) => { thumbRefs.current[index] = element; }}
            src={image.src}
            alt={image.alt ?? image.name}
            loading="lazy"
            onError={() => markFailed(image.src)}
            className={single
              ? "block max-h-80 w-auto max-w-[min(100%,22rem)] object-contain"
              : "block h-28 w-28 object-cover sm:h-32 sm:w-32"}
          />
        </button>
      ))}
    </div>
    )}
    {missing.map((image) => (
      <FileCard key={`missing-${image.src.slice(0, 64)}`} name={image.name} mimeType="image/*" />
    ))}
    </>
  );
}

/** Attachments on a sent prompt: images as a gallery, other files as cards, both above the text. */
export function MessageAttachments({
  attachments,
  align = "end",
  sessionId,
}: {
  attachments: Attachment[];
  align?: "start" | "end";
  /** Lets history images and files load from the session's copy on the server. */
  sessionId?: string;
}) {
  const images: GalleryImage[] = [];
  const files: Attachment[] = [];
  for (const att of attachments) {
    const src = attachmentImageSrc(att, sessionId);
    if (src) images.push({ src, name: attachmentName(att) });
    else files.push(att);
  }
  return (
    <div className={cx("flex min-w-0 flex-col gap-1.5", align === "end" ? "items-end" : "items-start")}>
      <ImageGallery images={images} align={align} />
      {files.length > 0 && (
        <div className={cx("flex max-w-full flex-wrap gap-1.5", align === "end" ? "justify-end" : "justify-start")}>
          {files.map((att, index) => (
            <FileCard
              key={`${attachmentName(att)}-${index}`}
              name={attachmentName(att)}
              href={attachmentDownloadUrl(att, sessionId)}
              {...attachmentMeta(att)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface ComposerAttachmentTrayProps {
  attachments: Attachment[];
  uploadingCount: number;
  onRemove: (index: number) => void;
}

/** What is about to be sent, inside the composer: thumbnails for images, cards for files. */
export function ComposerAttachmentTray({ attachments, uploadingCount, onRemove }: ComposerAttachmentTrayProps) {
  if (attachments.length === 0 && uploadingCount === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 px-3 pb-1 pt-3" aria-label="Attachments">
      {attachments.map((att, index) => {
        const name = attachmentName(att);
        const src = attachmentImageSrc(att);
        const removeButton = (
          <button
            type="button"
            onClick={() => onRemove(index)}
            className={TILE_CORNER_BUTTON}
            aria-label={`Remove attachment ${name}`}
            title={`Remove ${name}`}
          >
            <X size={12} strokeWidth={2.5} aria-hidden />
          </button>
        );
        return (
          <div key={`${name}-${index}`} className="group relative">
            {src ? (
              <img
                src={src}
                alt={name}
                title={name}
                className="block h-14 w-14 rounded-xl border border-surface-edge bg-surface-inset object-cover"
              />
            ) : (
              <FileCard name={name} {...attachmentMeta(att)} compact />
            )}
            {removeButton}
          </div>
        );
      })}
      {Array.from({ length: uploadingCount }, (_, index) => (
        <div
          key={`uploading-${index}`}
          className="flex h-14 w-14 items-center justify-center rounded-xl border border-surface-edge bg-surface-inset text-text-faint"
          role="status"
          aria-label="Uploading attachment"
        >
          <Loader2 size={18} className="animate-spin motion-reduce:animate-none" aria-hidden />
        </div>
      ))}
    </div>
  );
}

const OUTBOUND_ATTACHMENT_PATH_RE = /\/api\/sessions\/[a-f0-9-]{36}\/attachments\/([^/?#]+)$/i;

/** A file the agent handed back with send_attachment, recognised from the link it wrote. */
export function parseOutboundAttachmentLink(href: string | null | undefined): { url: string; name: string } | null {
  if (!href) return null;
  let pathname: string;
  try {
    const base = typeof window === "undefined" ? "http://localhost" : window.location?.origin ?? "http://localhost";
    const parsed = new URL(href, base);
    if (typeof window !== "undefined" && window.location?.origin && parsed.origin !== window.location.origin) return null;
    pathname = parsed.pathname;
  } catch {
    return null;
  }
  const match = OUTBOUND_ATTACHMENT_PATH_RE.exec(pathname);
  if (!match) return null;
  let name: string;
  try {
    name = decodeURIComponent(match[1]);
  } catch {
    name = match[1];
  }
  return { url: href, name };
}

/** A file from the agent: a preview when it is an image, otherwise a card that downloads it. */
export function OutboundAttachment({ url, name }: { url: string; name: string }) {
  if (isImageFileName(name) && fileExtension(name) !== "svg") {
    return (
      <div className="not-prose my-2 flex min-w-0">
        <ImageGallery images={[{ src: url, name, downloadUrl: url }]} />
      </div>
    );
  }
  return (
    <div className="not-prose my-2">
      <FileCard name={name} href={url} />
    </div>
  );
}
