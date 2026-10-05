import { useSyncExternalStore } from "react";

/**
 * What the chat can show of a file in place, and how it reads the file to do so. The components
 * are in FilePreview.tsx; this module has no markup so the rules can be tested by themselves.
 */

export interface PreviewFile {
  url: string;
  name: string;
}

export type FilePreviewKind = "image" | "markdown" | "table" | "html" | "pdf" | "audio" | "video" | "text";

const KIND_BY_EXTENSION: Record<string, FilePreviewKind> = {
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", bmp: "image", svg: "image", avif: "image",
  md: "markdown", markdown: "markdown",
  csv: "table", tsv: "table",
  html: "html", htm: "html",
  pdf: "pdf",
  mp3: "audio", wav: "audio", m4a: "audio", ogg: "audio",
  mp4: "video", webm: "video", mov: "video",
};

/** Formats known to hold no readable text, so the chat does not fetch them to find that out. */
const OPAQUE_EXTENSIONS = new Set([
  "zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar", "cab", "jar", "iso", "dmg",
  "doc", "docx", "xls", "xlsx", "ods", "odt", "ppt", "pptx", "rtf",
  "exe", "dll", "so", "bin", "msi", "apk", "wasm", "class", "db", "sqlite",
  "ttf", "otf", "woff", "woff2", "ico", "psd", "heic", "tiff", "tif",
  "flac", "aac", "avi", "mkv", "wmv",
]);

export function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : "";
}

/**
 * How a file is shown in the chat, or null when all the chat can do is offer it for download.
 * Any extension not listed is tried as text; reading it settles whether it is.
 */
/** True for a vector image, which may state no size of its own and is usually drawn for a light page. */
export function isVectorImage(src: string): boolean {
  return /\.svg(?:[?#]|$)/i.test(src);
}

export function filePreviewKind(name: string): FilePreviewKind | null {
  const ext = fileExtension(name);
  return KIND_BY_EXTENSION[ext] ?? (OPAQUE_EXTENSIONS.has(ext) ? null : "text");
}

export interface FileText {
  text: string;
  /** True when the file is longer than what was read. */
  truncated: boolean;
}

/** How much of a file is read: enough for the card's glimpse, and for the viewer. */
export const PREVIEW_BYTES = { card: 16 * 1024, viewer: 512 * 1024 } as const;

const MAX_CACHED_TEXTS = 24;
const textCache = new Map<string, { loading: Promise<FileText>; loaded?: FileText }>();
const textKey = (url: string, limit: number) => `${limit} ${url}`;

async function readFileText(url: string, limit: number): Promise<FileText> {
  const response = await fetch(url, { headers: { Range: `bytes=0-${limit - 1}` } });
  // An empty file has no first byte to serve, so the server refuses the range.
  if (response.status === 416) return { text: "", truncated: false };
  if (!response.ok || !response.body) throw new Error(`The file could not be read (${response.status}).`);

  // Read no more than the limit even when something on the way ignored the range.
  const reader = response.body.getReader();
  const bytes = new Uint8Array(limit);
  let size = 0;
  let ended = false;
  while (size < limit) {
    const { done, value } = await reader.read();
    if (done) {
      ended = true;
      break;
    }
    const chunk = value.subarray(0, limit - size);
    bytes.set(chunk, size);
    size += chunk.length;
  }
  if (!ended) void reader.cancel().catch(() => {});

  const content = bytes.subarray(0, size);
  if (content.includes(0)) throw new Error("The file is not text.");
  const total = Number(/\/(\d+)$/.exec(response.headers.get("Content-Range") ?? "")?.[1]);
  const truncated = Number.isFinite(total) ? total > size : !ended;
  // A cut can fall inside a character; streaming mode leaves the partial one out.
  const text = new TextDecoder().decode(content, { stream: truncated });
  // A cut in the middle of a line is dropped back to the last whole line.
  const lastLine = truncated ? text.lastIndexOf("\n") : -1;
  return { text: lastLine > 0 ? text.slice(0, lastLine) : text, truncated };
}

/** The start of a file as text. Rejects when the file cannot be read or is not text. */
export function loadFileText(url: string, limit: number): Promise<FileText> {
  const key = textKey(url, limit);
  let entry = textCache.get(key);
  if (!entry) {
    const created: { loading: Promise<FileText>; loaded?: FileText } = { loading: readFileText(url, limit) };
    entry = created;
    textCache.set(key, created);
    created.loading.then(
      (loaded) => { created.loaded = loaded; },
      () => { if (textCache.get(key) === created) textCache.delete(key); },
    );
    if (textCache.size > MAX_CACHED_TEXTS) textCache.delete(textCache.keys().next().value!);
  }
  return entry.loading;
}

/**
 * What an earlier read of the same part of a file returned. The transcript draws a reply's card
 * again when the reply finishes streaming, and this lets it show its text at once.
 */
export function loadedFileText(url: string, limit: number): FileText | null {
  return textCache.get(textKey(url, limit))?.loaded ?? null;
}

/** Rows of a CSV or TSV file, with quoted fields, doubled quotes and line breaks inside quotes. */
export function parseDelimitedRows(text: string, delimiter: string, maxRows: number): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const endRow = () => {
    row.push(field);
    if (row.length > 1 || row[0] !== "") rows.push(row);
    row = [];
    field = "";
  };
  for (let i = 0; i < text.length && rows.length < maxRows; i++) {
    const char = text[i];
    if (quoted) {
      if (char !== '"') field += char;
      else if (text[i + 1] === '"') { field += '"'; i++; }
      else quoted = false;
    } else if (char === '"' && field === "") quoted = true;
    else if (char === delimiter) { row.push(field); field = ""; }
    else if (char === "\n") endRow();
    else if (char !== "\r") field += char;
  }
  if (rows.length < maxRows && (field !== "" || row.length > 0)) endRow();
  return rows;
}

/**
 * How many canvas pixels to draw per CSS pixel for a PDF page of the given size: as sharp as the
 * screen, up to twice, and never more pixels in total than the device can hold in one canvas.
 */
export function pdfCanvasScale(cssWidth: number, cssHeight: number, devicePixelRatio: number, maxPixels: number): number {
  return Math.min(devicePixelRatio || 1, 2, Math.sqrt(maxPixels / (cssWidth * cssHeight)));
}

// The one file open in the full-screen viewer. A single viewer is mounted at the app's root
// (FileViewerHost), outside any message, so the styles and touch handling of the message a file
// was opened from do not reach it.
let shownFile: PreviewFile | null = null;
let openedFrom: Element | null = null;
const listeners = new Set<() => void>();

/** Opens a file in the viewer, or closes the viewer with null and returns focus to what opened it. */
export function showFile(file: PreviewFile | null): void {
  if (file && !shownFile) openedFrom = document.activeElement;
  shownFile = file;
  for (const listener of listeners) listener();
  if (!file) {
    (openedFrom as HTMLElement | null)?.focus?.();
    openedFrom = null;
  }
}

export function useOpenFile(): PreviewFile | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    () => shownFile,
  );
}
