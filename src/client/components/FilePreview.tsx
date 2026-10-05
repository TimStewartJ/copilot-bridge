import { lazy, memo, Suspense, useCallback, useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ZoomIn, ZoomOut } from "lucide-react";
import CodeBlock from "./CodeBlock";
import { describeFile, FileCard, ImageGallery, PreviewCaption } from "./ChatAttachments";
import {
  fileExtension,
  filePreviewKind,
  loadedFileText,
  loadFileText,
  parseDelimitedRows,
  PREVIEW_BYTES,
  showFile,
  useOpenFile,
  type FilePreviewKind,
  type FileText,
  type PreviewFile,
} from "./file-preview";
import { LIGHTBOX_BACKDROP_ATTR, LightboxDownload, LightboxShell } from "./LightboxShell";
import type { PdfPreviewProps } from "./PdfPreview";
import { APP_PROSE } from "./shared/prose-classes";
import { HTML_SANDBOX_PERMISSIONS } from "./visualDisplay";
import { DS, cx } from "../design/tokens";
import { EmptyHint, IconButton } from "../design/primitives";

/**
 * A file shown in the chat itself. In the transcript it is a card: a glimpse of the content in a
 * frame, and a line that names it with Expand and Download. Opening it shows the whole file full
 * screen, where it scrolls, selects and (for a web page) responds. Downloading is the other option,
 * never the only one, except for formats the browser cannot show.
 */

/** Stands in when pdf.js cannot be loaded (offline, or a tab older than the running build). */
function PdfUnavailable({ onError }: Pick<PdfPreviewProps, "onError">) {
  useEffect(onError, [onError]);
  return null;
}

// A failed import would otherwise throw during render and take the whole app down with it.
const PdfPreview = lazy<ComponentType<PdfPreviewProps>>(() => import("./PdfPreview").catch(() => ({ default: PdfUnavailable })));

type DocumentKind = Exclude<FilePreviewKind, "image">;

interface FilePreviewBodyProps {
  file: PreviewFile;
  kind: DocumentKind;
  /** The full-screen viewer, where the whole file is shown; otherwise the card's glimpse. */
  viewer?: boolean;
  zoom?: number;
  /** Called when the file turns out not to be showable, so the caller can offer it another way. */
  onError: () => void;
}

const PROSE = `ds-prose max-w-none break-words text-sm leading-[1.7] text-text-primary ${APP_PROSE} prose-pre:bg-bg-surface prose-th:bg-bg-surface`;
const TABLE_ROWS = { card: 12, viewer: 500 } as const;
/** A cell is as wide as its value up to a limit and wraps beyond it; a wide table scrolls sideways. */
const TABLE_CELL = "w-max max-w-48 whitespace-pre-wrap break-words sm:max-w-80";
const PDF_ZOOM_STEPS = [1, 1.5, 2, 3];

// A file's markdown is a document, not a chat reply: its links leave the app instead of
// navigating it, and none of the chat's cards are built from them.
const FILE_MARKDOWN_COMPONENTS: Components = {
  pre: CodeBlock,
  a: ({ node: _node, children, href, ...props }) => (
    <a {...props} href={href} {...(href?.startsWith("#") ? {} : { target: "_blank", rel: "noreferrer" })}>{children}</a>
  ),
};

function Loading() {
  return <p className={cx("not-prose p-4", DS.text.empty)} role="status">Loading…</p>;
}

function TextPreview({ file, kind, viewer = false, onError }: FilePreviewBodyProps) {
  const limit = viewer ? PREVIEW_BYTES.viewer : PREVIEW_BYTES.card;
  const [loaded, setLoaded] = useState<FileText | null>(() => loadedFileText(file.url, limit));
  useEffect(() => {
    let cancelled = false;
    loadFileText(file.url, limit).then(
      (value) => { if (!cancelled) setLoaded(value); },
      () => { if (!cancelled) onError(); },
    );
    return () => { cancelled = true; };
  }, [file.url, limit, onError]);

  if (!loaded) return <Loading />;
  const { text, truncated } = loaded;
  const extension = fileExtension(file.name);
  let cut = truncated;
  let content: ReactNode;
  if (!text.trim()) {
    content = <EmptyHint className="not-prose">This file is empty.</EmptyHint>;
  } else if (kind === "markdown") {
    content = (
      <div className={PROSE}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={FILE_MARKDOWN_COMPONENTS}>{text}</ReactMarkdown>
      </div>
    );
  } else if (kind === "table") {
    const maxRows = viewer ? TABLE_ROWS.viewer : TABLE_ROWS.card;
    const [header = [], ...rows] = parseDelimitedRows(text, extension === "tsv" ? "\t" : ",", maxRows + 2);
    if (rows.length > maxRows) cut = true;
    const shown = rows.slice(0, maxRows);
    // A file may open with a title line, so the widest row sets the columns, not the first.
    const columns = Array.from({ length: Math.max(header.length, ...shown.map((row) => row.length)) }, (_, column) => column);
    content = (
      <div className={PROSE}>
        <table className="tabular-nums">
          <thead>
            <tr>{columns.map((column) => <th key={column}><div className={TABLE_CELL}>{header[column]}</div></th>)}</tr>
          </thead>
          <tbody>
            {shown.map((row, index) => (
              <tr key={index}>{columns.map((column) => <td key={column}><div className={TABLE_CELL}>{row[column]}</div></td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  } else if (viewer) {
    content = <CodeBlock><code className={`language-${extension}`}>{text}</code></CodeBlock>;
  } else {
    content = <pre className="not-prose m-0 whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-text-secondary">{text}</pre>;
  }
  return (
    // A document keeps a reading measure; a table or code uses the width it is given.
    <div className={viewer ? cx("mx-auto w-full p-4 sm:p-6", kind === "markdown" && "max-w-4xl") : "px-4 py-3"}>
      {content}
      {viewer && cut && (
        <p className="not-prose mt-4 text-xs text-text-faint">Only the start of this file is shown here. Download it for the rest.</p>
      )}
    </div>
  );
}

function FilePreviewBody(props: FilePreviewBodyProps) {
  const { file, kind, viewer = false, zoom = 1, onError } = props;
  if (kind === "audio") {
    return <audio controls preload="metadata" src={file.url} onError={onError} className="not-prose block w-full" />;
  }
  if (kind === "video") {
    return (
      <video
        controls
        playsInline
        preload="metadata"
        src={file.url}
        onError={onError}
        // A fixed shape in the transcript, so the reply does not jump when the video's size arrives.
        className={cx("not-prose block w-full bg-surface-inset", viewer ? "max-h-full" : "aspect-video rounded-2xl border border-surface-edge")}
      />
    );
  }
  if (kind === "html") {
    // The card shows the page at half size, as a picture of itself; the viewer shows it for use.
    return (
      <iframe
        src={`${file.url}${file.url.includes("?") ? "&" : "?"}inline=1`}
        sandbox={HTML_SANDBOX_PERMISSIONS}
        title={file.name}
        loading="lazy"
        scrolling={viewer ? undefined : "no"}
        className={cx("not-prose block border-0 bg-white", viewer ? "h-full w-full" : "h-[36rem] w-[200%] origin-top-left scale-50")}
      />
    );
  }
  if (kind === "pdf") return <PdfBody {...props} />;
  return <TextPreview {...props} />;
}

/** A PDF, with pdf.js fetched when the file first comes near the screen, not when its chat opens. */
function PdfBody({ file, viewer = false, zoom = 1, onError }: FilePreviewBodyProps) {
  const holderRef = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(viewer);
  useEffect(() => {
    const holder = holderRef.current;
    if (near || !holder) return;
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => { if (entry.isIntersecting) setNear(true); }, { rootMargin: "100% 0px" });
    observer.observe(holder);
    return () => observer.disconnect();
  }, [near]);
  return (
    <div ref={holderRef} className="not-prose h-full min-h-px">
      {near && (
        <Suspense fallback={<Loading />}>
          <PdfPreview url={file.url} viewer={viewer} zoom={zoom} onError={onError} />
        </Suspense>
      )}
    </div>
  );
}

const isPlayer = (kind: DocumentKind) => kind === "audio" || kind === "video";
const isPage = (kind: DocumentKind) => kind === "html" || kind === "pdf";

/** A file the agent sent, as it appears in a reply. */
export const OutboundAttachment = memo(function OutboundAttachment({ url, name }: PreviewFile) {
  const kind = filePreviewKind(name);
  const [failed, setFailed] = useState(false);
  const fail = useCallback(() => setFailed(true), []);

  if (kind === "image") {
    return (
      <div className="not-prose my-2 flex min-w-0">
        <ImageGallery images={[{ src: url, name, downloadUrl: url }]} />
      </div>
    );
  }
  if (!kind || failed) {
    return (
      <div className="not-prose my-2">
        <FileCard name={name} href={url} />
      </div>
    );
  }

  const file = { url, name };
  const open = () => showFile(file);
  const { Icon, kind: label } = describeFile(name);
  return (
    // The reply's prose styles space a figure like a pull quote; a file sits as close as a paragraph.
    <figure className="my-2! flex min-w-0 max-w-2xl flex-col gap-2">
      {isPlayer(kind) ? (
        <FilePreviewBody file={file} kind={kind} onError={fail} />
      ) : (
        <div
          className={cx(
            "relative overflow-hidden rounded-2xl border border-surface-edge",
            isPage(kind) ? "h-72 bg-white" : "max-h-72 bg-surface-group",
          )}
        >
          <div inert><FilePreviewBody file={file} kind={kind} onError={fail} /></div>
          {/* Sits where a full-height glimpse ends, so a file shorter than the frame shows no fade. */}
          {!isPage(kind) && (
            <div className="pointer-events-none absolute inset-x-0 top-[15.5rem] h-10 bg-gradient-to-t from-surface-group to-transparent" aria-hidden />
          )}
          <button
            type="button"
            onClick={open}
            className={cx("absolute inset-0 h-full w-full cursor-zoom-in rounded-2xl focus-visible:ring-inset", DS.focus)}
            aria-label={`Open ${name}`}
            title={`Open ${name}`}
          />
        </div>
      )}
      <PreviewCaption
        Icon={Icon}
        title={name}
        meta={label}
        onExpand={isPlayer(kind) ? undefined : open}
        downloadUrl={url}
        downloadName={name}
        className="not-prose"
      />
    </figure>
  );
});

function FileViewer({ file }: { file: PreviewFile }) {
  const kind = filePreviewKind(file.name);
  const [zoomStep, setZoomStep] = useState(0);
  const [failed, setFailed] = useState(false);
  const fail = useCallback(() => setFailed(true), []);
  const shown = kind && kind !== "image" && !failed ? kind : null;

  return (
    <LightboxShell
      title={file.name}
      subtitle={describeFile(file.name).kind}
      onClose={() => showFile(null)}
      actions={(
        <>
          {shown === "pdf" && (
            <>
              <IconButton label="Zoom out" disabled={zoomStep === 0} onClick={() => setZoomStep(zoomStep - 1)}>
                <ZoomOut size={16} aria-hidden />
              </IconButton>
              <IconButton label="Zoom in" disabled={zoomStep === PDF_ZOOM_STEPS.length - 1} onClick={() => setZoomStep(zoomStep + 1)}>
                <ZoomIn size={16} aria-hidden />
              </IconButton>
            </>
          )}
          <LightboxDownload href={file.url} fileName={file.name} />
        </>
      )}
    >
      <div className="flex min-h-0 flex-1 flex-col px-2 pb-2 sm:px-6 sm:pb-6" {...{ [LIGHTBOX_BACKDROP_ATTR]: "" }}>
        {shown ? (
          <div
            className={cx(
              "min-h-0 flex-1 overflow-auto rounded-xl",
              isPlayer(shown) && "flex items-center justify-center",
              // Code brings its own box and a player has none; everything else is a page on the backdrop.
              shown !== "text" && !isPlayer(shown) && "border border-surface-edge",
              shown === "html" && "bg-white",
              (shown === "markdown" || shown === "table") && "bg-surface-group",
            )}
            {...(isPlayer(shown) ? { [LIGHTBOX_BACKDROP_ATTR]: "" } : {})}
          >
            <FilePreviewBody file={file} kind={shown} viewer zoom={PDF_ZOOM_STEPS[zoomStep]} onError={fail} />
          </div>
        ) : (
          <div className="m-auto flex flex-col items-center gap-3">
            <EmptyHint>This file cannot be shown here.</EmptyHint>
            <FileCard name={file.name} href={file.url} />
          </div>
        )}
      </div>
    </LightboxShell>
  );
}

/** The one full-screen file viewer, mounted at the app's root. Anything opens it with `showFile`. */
export function FileViewerHost() {
  const file = useOpenFile();
  return file ? <FileViewer key={file.url} file={file} /> : null;
}
