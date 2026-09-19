/**
 * Pure helpers behind the Docs view: tree indexing, navigation, link resolution, headings,
 * collection sorting/filtering and formatting. Nothing here touches React or the DOM.
 */
import type { DbEntry, DbSchema, DocTreeNode } from "../../api";

// ── Tree ──────────────────────────────────────────────────────────

export type DocsNodeKind = "page" | "folder" | "collection";

/** A place the reader can land on: a page, a folder overview or a collection. */
export interface DocsTarget {
  path: string;
  kind: DocsNodeKind;
}

export interface DocsPageRef {
  path: string;
  title: string;
  description?: string;
  tags: string[];
  modified?: string;
  /** Folder that contains the page ("" at the root). */
  folder: string;
  /** True for entries of a database collection. */
  isEntry: boolean;
}

export interface DocsTreeIndex {
  roots: DocTreeNode[];
  folders: Map<string, DocTreeNode>;
  files: Map<string, DocTreeNode>;
  /** Every page in tree order: folder index pages, plain pages and collection entries. */
  pages: DocsPageRef[];
  pageByPath: Map<string, DocsPageRef>;
  stats: { pages: number; folders: number; collections: number; entries: number };
}

export function nodeKey(node: Pick<DocTreeNode, "type" | "path">): string {
  return `${node.type}:${node.path}`;
}

/** The label shown for a node: its title when the index knows one, otherwise its slug. */
export function nodeLabel(node: Pick<DocTreeNode, "title" | "name">): string {
  return node.title?.trim() || node.name;
}

export function parentPath(path: string): string {
  const index = path.lastIndexOf("/");
  return index >= 0 ? path.slice(0, index) : "";
}

export function lastSegment(path: string): string {
  const index = path.lastIndexOf("/");
  return index >= 0 ? path.slice(index + 1) : path;
}

/** Folder paths that must be open for `path` to be visible: "a/b/c" → ["a", "a/b"]. */
export function ancestorFolderPaths(path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  const ancestors: string[] = [];
  for (let i = 1; i < parts.length; i++) ancestors.push(parts.slice(0, i).join("/"));
  return ancestors;
}

export function buildTreeIndex(roots: DocTreeNode[]): DocsTreeIndex {
  const folders = new Map<string, DocTreeNode>();
  const files = new Map<string, DocTreeNode>();
  const pages: DocsPageRef[] = [];
  const stats = { pages: 0, folders: 0, collections: 0, entries: 0 };

  const toRef = (node: DocTreeNode, isEntry: boolean): DocsPageRef => ({
    path: node.path,
    title: nodeLabel(node),
    ...(node.description ? { description: node.description } : {}),
    tags: node.tags ?? [],
    ...(node.modified ? { modified: node.modified } : {}),
    folder: node.type === "folder" ? node.path : parentPath(node.path),
    isEntry,
  });

  const walk = (node: DocTreeNode, insideCollection: boolean) => {
    if (node.type === "file") {
      files.set(node.path, node);
      pages.push(toRef(node, insideCollection));
      if (insideCollection) stats.entries += 1;
      else stats.pages += 1;
      return;
    }
    folders.set(node.path, node);
    if (node.isDb) stats.collections += 1;
    else stats.folders += 1;
    // A leaf page and a folder can share a path; the leaf already owns it.
    if (node.hasIndex && !node.isDb && !files.has(node.path)) {
      pages.push(toRef(node, false));
      stats.pages += 1;
    }
    node.children?.forEach((child) => walk(child, Boolean(node.isDb)));
  };
  roots.forEach((node) => walk(node, false));

  const pageByPath = new Map<string, DocsPageRef>();
  for (const page of pages) if (!pageByPath.has(page.path)) pageByPath.set(page.path, page);

  return { roots, folders, files, pages, pageByPath, stats };
}

export interface DocsTreeRow {
  key: string;
  node: DocTreeNode;
  /** Label for the tree, where the parent folder is already visible as context. */
  label: string;
  depth: number;
  kind: DocsNodeKind;
  expanded: boolean;
  hasChildren: boolean;
  parentKey: string | null;
}

export function nodeKind(node: DocTreeNode): DocsNodeKind {
  if (node.type === "file") return "page";
  return node.isDb ? "collection" : "folder";
}

const TITLE_SEPARATORS = [" — ", " – ", " - ", ": ", " | "];

function lettersOnly(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * Pages are often titled "Project — Topic" and filed under a "project" folder. Inside the tree
 * that prefix only repeats the folder above it and pushes the useful half of the title out of
 * view, so it is dropped there. The full title is still used everywhere else.
 */
export function compactTreeLabel(label: string, folderLabels: readonly string[]): string {
  const folders = folderLabels.map(lettersOnly).filter((folder) => folder.length >= 3);
  if (folders.length === 0) return label;
  for (const separator of TITLE_SEPARATORS) {
    const at = label.indexOf(separator);
    if (at <= 0) continue;
    const prefix = lettersOnly(label.slice(0, at));
    const rest = label.slice(at + separator.length).trim();
    if (!rest) continue;
    const repeatsFolder = folders.some((folder) => (
      prefix.length >= Math.max(4, folder.length / 2) && (folder.startsWith(prefix) || prefix.endsWith(folder))
    ));
    if (repeatsFolder) return rest;
  }
  return label;
}

/**
 * Rows currently visible in the sidebar, in order, for rendering and arrow-key navigation.
 * Collections are leaves here: their entries are browsed (filtered, sorted) in the table view,
 * which keeps a thousand-entry collection from flooding the tree.
 */
export function flattenVisibleTree(roots: DocTreeNode[], expanded: ReadonlySet<string>): DocsTreeRow[] {
  const rows: DocsTreeRow[] = [];
  const walk = (node: DocTreeNode, depth: number, parent: DocTreeNode | null) => {
    const key = nodeKey(node);
    const hasChildren = node.type === "folder" && !node.isDb && (node.children?.length ?? 0) > 0;
    const isExpanded = hasChildren && expanded.has(node.path);
    const label = parent ? compactTreeLabel(nodeLabel(node), [parent.name, nodeLabel(parent)]) : nodeLabel(node);
    rows.push({ key, node, label, depth, kind: nodeKind(node), expanded: isExpanded, hasChildren, parentKey: parent ? nodeKey(parent) : null });
    if (isExpanded) node.children!.forEach((child) => walk(child, depth + 1, node));
  };
  roots.forEach((node) => walk(node, 0, null));
  return rows;
}

/** Where selecting a tree node should take the reader. */
export function targetForNode(node: DocTreeNode): DocsTarget {
  return { path: node.path, kind: nodeKind(node) };
}

export function docsRoute(target: DocsTarget | string, hash = ""): string {
  const resolved = typeof target === "string" ? { path: target, kind: "page" as const } : target;
  const encoded = resolved.path.split("/").map(encodeURIComponent).join("/");
  const base = encoded ? `/docs/${encoded}` : "/docs";
  return `${base}${resolved.kind === "collection" ? "?db" : ""}${hash}`;
}

// ── Breadcrumbs and neighbours ────────────────────────────────────

export interface DocsCrumb {
  label: string;
  /** Null for the current location. */
  target: DocsTarget | null;
}

/**
 * Breadcrumbs for a location. Every ancestor is navigable: a folder without an index page still
 * has an overview, and a collection opens its table.
 */
export function buildBreadcrumbs(path: string, index: DocsTreeIndex, currentLabel?: string): DocsCrumb[] {
  const parts = path.split("/").filter(Boolean);
  const crumbs: DocsCrumb[] = [];
  for (let i = 0; i < parts.length; i++) {
    const crumbPath = parts.slice(0, i + 1).join("/");
    const isLast = i === parts.length - 1;
    const folder = index.folders.get(crumbPath);
    if (isLast) {
      const label = currentLabel?.trim()
        || index.pageByPath.get(crumbPath)?.title
        || (folder ? nodeLabel(folder) : parts[i]);
      crumbs.push({ label, target: null });
      continue;
    }
    crumbs.push({
      label: folder ? nodeLabel(folder) : parts[i],
      target: { path: crumbPath, kind: folder?.isDb ? "collection" : folder ? "folder" : "page" },
    });
  }
  return crumbs;
}

export interface DocsNeighbours {
  previous: DocsPageRef | null;
  next: DocsPageRef | null;
}

/** Previous and next page within the same folder; neighbouring folders are unrelated projects. */
export function findNeighbours(index: DocsTreeIndex, path: string): DocsNeighbours {
  const current = index.pageByPath.get(path);
  if (!current || current.isEntry || index.folders.has(path)) return { previous: null, next: null };
  const siblings = index.pages.filter((page) => !page.isEntry && !index.folders.has(page.path) && page.folder === current.folder);
  const position = siblings.findIndex((page) => page.path === path);
  return {
    previous: position > 0 ? siblings[position - 1] : null,
    next: position >= 0 && position < siblings.length - 1 ? siblings[position + 1] : null,
  };
}

function timeValue(value: string | undefined): number {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** Recently changed pages. Collection entries are rows of data; a bulk import must not bury the pages. */
export function recentPages(index: DocsTreeIndex, limit: number): DocsPageRef[] {
  return index.pages
    .filter((page) => !page.isEntry && timeValue(page.modified) > 0)
    .sort((a, b) => timeValue(b.modified) - timeValue(a.modified))
    .slice(0, limit);
}

export interface DocsFolderSummary {
  node: DocTreeNode;
  label: string;
  kind: "folder" | "collection";
  itemCount: number;
  modified?: string;
}

function latestModified(node: DocTreeNode): string | undefined {
  let latest = node.modified;
  for (const child of node.children ?? []) {
    const candidate = latestModified(child);
    if (timeValue(candidate) > timeValue(latest)) latest = candidate;
  }
  return latest;
}

function countPages(node: DocTreeNode): number {
  if (node.type === "file") return 1;
  const own = node.hasIndex && !node.isDb ? 1 : 0;
  return own + (node.children ?? []).reduce((total, child) => total + countPages(child), 0);
}

export function summarizeFolders(nodes: DocTreeNode[]): DocsFolderSummary[] {
  return nodes
    .filter((node) => node.type === "folder")
    .map((node) => ({
      node,
      label: nodeLabel(node),
      kind: node.isDb ? "collection" as const : "folder" as const,
      itemCount: countPages(node),
      modified: latestModified(node),
    }));
}

/** Non-collection folder paths, for choosing where a new page goes. */
export function listPageFolders(index: DocsTreeIndex): string[] {
  const result: string[] = [];
  const walk = (node: DocTreeNode) => {
    if (node.type !== "folder" || node.isDb) return;
    result.push(node.path);
    node.children?.forEach(walk);
  };
  index.roots.forEach(walk);
  return result;
}

/** The folder a new page should default to, given where the reader currently is. */
export function defaultNewPageFolder(index: DocsTreeIndex, currentPath: string | null): string {
  if (!currentPath) return "";
  const folder = index.folders.get(currentPath);
  if (folder && !folder.isDb && !index.files.has(currentPath)) return currentPath;
  let candidate = parentPath(currentPath);
  while (candidate && index.folders.get(candidate)?.isDb) candidate = parentPath(candidate);
  return candidate;
}

/** The collection a path belongs to, when it is a collection or one of its entries. */
export function owningCollection(index: DocsTreeIndex, path: string | null): DocTreeNode | null {
  if (!path) return null;
  const self = index.folders.get(path);
  if (self?.isDb) return self;
  const parent = index.folders.get(parentPath(path));
  return parent?.isDb ? parent : null;
}

// ── Instant title search ──────────────────────────────────────────

function normalizeForMatch(value: string): string {
  return value.toLowerCase().replace(/[-_/]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Title and path matches from the already-loaded tree. Full-text search only matches whole
 * words, so this is what makes a half-typed title find its page immediately.
 */
export function matchPagesByTitle(index: DocsTreeIndex, query: string, limit = 8): DocsPageRef[] {
  const needle = normalizeForMatch(query);
  if (!needle) return [];
  const words = needle.split(" ");
  const scored: { page: DocsPageRef; score: number }[] = [];
  for (const page of index.pages) {
    const title = normalizeForMatch(page.title);
    const path = normalizeForMatch(page.path);
    if (!words.every((word) => title.includes(word) || path.includes(word))) continue;
    const score = title === needle ? 0
      : title.startsWith(needle) ? 1
      : title.includes(needle) ? 2
      : words.every((word) => title.includes(word)) ? 3
      : 4;
    scored.push({ page, score });
  }
  return scored
    .sort((a, b) => a.score - b.score || a.page.title.localeCompare(b.page.title))
    .slice(0, limit)
    .map((entry) => entry.page);
}

export interface SnippetSegment {
  text: string;
  highlighted: boolean;
}

/** Snippets are raw page source; markup characters are noise in a two-line preview. */
function tidySnippetText(text: string): string {
  return text
    .replace(/^[ \t]*>+[ \t]?/gm, "")
    .replace(/[*`#|]+|\[\[|\]\]/g, " ")
    .replace(/\s+/g, " ");
}

/**
 * Splits a search snippet on the server's `<mark>` markers. Everything else is kept as literal
 * text, so page content that happens to contain markup is never interpreted as HTML.
 */
export function parseSnippet(snippet: string): SnippetSegment[] {
  const segments: SnippetSegment[] = [];
  const pattern = /<mark>([\s\S]*?)<\/mark>/g;
  let cursor = 0;
  for (const match of snippet.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > cursor) segments.push({ text: snippet.slice(cursor, start), highlighted: false });
    if (match[1]) segments.push({ text: match[1], highlighted: true });
    cursor = start + match[0].length;
  }
  if (cursor < snippet.length) segments.push({ text: snippet.slice(cursor), highlighted: false });
  return segments
    .map((segment) => ({ ...segment, text: tidySnippetText(segment.text) }))
    .filter((segment) => segment.text.length > 0);
}

// ── Links ─────────────────────────────────────────────────────────

/** Resolves a relative markdown link against the page (or folder index) it appears in. */
export function resolveRelativeDocPath(currentPath: string, href: string, currentIsDirectory: boolean): string {
  const hashIdx = href.indexOf("#");
  const rawPath = hashIdx >= 0 ? href.slice(0, hashIdx) : href;
  const fragment = hashIdx >= 0 ? href.slice(hashIdx) : "";
  let decoded = rawPath;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    // Keep the literal text when it is not valid percent-encoding.
  }
  const clean = decoded.replace(/\.md$/i, "");
  if (!clean) return currentPath + fragment;
  if (clean.startsWith("/")) return clean.slice(1).replace(/\/+$/, "") + fragment;
  const parts = currentIsDirectory ? currentPath.split("/") : currentPath.split("/").slice(0, -1);
  for (const segment of clean.split("/")) {
    if (segment === "..") parts.pop();
    else if (segment && segment !== ".") parts.push(segment);
  }
  return parts.filter(Boolean).join("/") + fragment;
}

/** `folder/index` and `folder` are the same page; links should land on the canonical one. */
export function canonicalDocPath(path: string, index: DocsTreeIndex): string {
  if (!path.endsWith("/index")) return path;
  const folderPath = path.slice(0, -"/index".length);
  const folder = index.folders.get(folderPath);
  return folder?.hasIndex && !index.files.has(folderPath) ? folderPath : path;
}

export function isExternalHref(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//");
}

export function extractWikilinkTargets(markdown: string): string[] {
  const targets = new Set<string>();
  for (const match of markdown.matchAll(/\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]/g)) {
    const target = match[1].trim();
    if (target) targets.add(target);
  }
  return [...targets].sort();
}

// ── Headings ──────────────────────────────────────────────────────

export interface DocHeading {
  id: string;
  text: string;
  level: number;
  /** 1-based source line, which is how rendered headings find their id. */
  line: number;
}

function stripEmphasis(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g, (_match, target: string, label?: string) => label ?? lastSegment(target))
    .replace(/<[^>]+>/g, "")
    .replace(/[*~]+/g, "")
    // Underscores only mark emphasis at a word edge; snake_case keeps its underscores.
    .replace(/(^|[\s(\[{"'])_+(?=\S)/g, "$1")
    .replace(/(\S)_+(?=$|[\s)\]}"'.,;:!?])/g, "$1");
}

/** Plain text of an inline markdown run. Code spans are kept verbatim, minus their backticks. */
export function stripMarkdownInline(text: string): string {
  return text
    .split("`")
    .map((part, index) => (index % 2 === 1 ? part : stripEmphasis(part)))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

/** GitHub-style heading slugs, because that is the convention authors (and agents) link by. */
export function slugifyHeading(text: string): string {
  return stripMarkdownInline(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-") || "section";
}

function normalizeAnchor(value: string): string {
  return value.toLowerCase().replace(/-+/g, "-").replace(/^-|-$/g, "");
}

/** Finds the heading a URL fragment points at, tolerating collapsed or doubled hyphens. */
export function findHeadingByAnchor(headings: DocHeading[], anchor: string): DocHeading | null {
  if (!anchor) return null;
  const exact = headings.find((heading) => heading.id === anchor);
  if (exact) return exact;
  const normalized = normalizeAnchor(anchor);
  return headings.find((heading) => normalizeAnchor(heading.id) === normalized) ?? null;
}

const FENCE_PATTERN = /^\s{0,3}(```+|~~~+)/;

export function extractHeadings(markdown: string): DocHeading[] {
  const headings: DocHeading[] = [];
  const counts = new Map<string, number>();
  let fence: string | null = null;

  markdown.split(/\r?\n/).forEach((line, lineIndex) => {
    const fenceMatch = line.match(FENCE_PATTERN);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (!fence) fence = marker;
      else if (fence === marker) fence = null;
      return;
    }
    if (fence) return;
    const match = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (!match) return;
    const text = stripMarkdownInline(match[2]);
    if (!text) return;
    const baseId = slugifyHeading(text);
    const count = counts.get(baseId) ?? 0;
    counts.set(baseId, count + 1);
    headings.push({
      level: match[1].length,
      text,
      id: count === 0 ? baseId : `${baseId}-${count}`,
      line: lineIndex + 1,
    });
  });
  return headings;
}

const LEADING_TITLE_PATTERN = /^\s{0,3}#\s+(.+?)\s*#*\s*$/;

function leadingTitleLine(lines: string[]): number {
  let first = 0;
  while (first < lines.length && !lines[first].trim()) first += 1;
  return first < lines.length && LEADING_TITLE_PATTERN.test(lines[first]) ? first : -1;
}

/** Text of the H1 a page opens with, if it opens with one. */
export function leadingTitle(markdown: string): string | null {
  const lines = markdown.split(/\r?\n/);
  const index = leadingTitleLine(lines);
  if (index < 0) return null;
  return stripMarkdownInline(lines[index].match(LEADING_TITLE_PATTERN)![1]) || null;
}

/**
 * The page header already shows the title, and nearly every page opens by restating it as an
 * H1. Drop that leading H1 so the title is not printed twice.
 */
export function stripLeadingTitle(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const index = leadingTitleLine(lines);
  if (index < 0) return markdown;
  let rest = index + 1;
  while (rest < lines.length && !lines[rest].trim()) rest += 1;
  return lines.slice(rest).join("\n");
}

/** Headings worth listing in "On this page": the top three levels that actually occur. */
export function tocHeadings(headings: DocHeading[]): DocHeading[] {
  if (headings.length === 0) return [];
  const top = Math.min(...headings.map((heading) => heading.level));
  return headings.filter((heading) => heading.level <= top + 2);
}

export function estimateReadingMinutes(markdown: string): number {
  const words = markdown.replace(/```[\s\S]*?```/g, " ").split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 220));
}

// ── Formatting ────────────────────────────────────────────────────

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}(?:T00:00:00(?:\.0+)?Z)?$/;

export function formatDocDate(value: string | undefined | null): string {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  // A calendar date ("2026-09-17", or YAML's midnight-UTC reading of one) names a day, not an
  // instant. Formatting it in local time would show the day before anywhere west of Greenwich.
  const timeZone = DATE_ONLY_PATTERN.test(value) ? "UTC" : undefined;
  return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone });
}

export function formatRelativeTime(value: string | undefined | null, now: number = Date.now()): string {
  if (!value) return "";
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return "";
  const seconds = Math.round((now - time) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  if (days < 35) return `${Math.round(days / 7)}w ago`;
  return formatDocDate(value);
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

// ── New pages ─────────────────────────────────────────────────────

/** Mirrors the server's slug rule so the path preview matches what gets created. */
export function slugifyPageName(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function joinDocPath(folder: string, slug: string): string {
  return [...folder.split("/"), slug].map((part) => part.trim()).filter(Boolean).join("/");
}

const RESERVED_PATH_CHARS = /[<>:"|?*\\]/;
const RESERVED_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

/** Returns why a new page path is unusable, or null when it is fine. */
export function validateNewPagePath(path: string, index: DocsTreeIndex): string | null {
  const segments = path.split("/").map((part) => part.trim());
  if (segments.length === 0 || segments.some((part) => !part)) return "Enter a name for the page.";
  for (const segment of segments) {
    if (segment === "." || segment === "..") return "A path cannot contain . or .. segments.";
    if (segment.startsWith("_")) return "Names starting with _ are reserved.";
    if (RESERVED_PATH_CHARS.test(segment)) return 'A name cannot contain < > : " | ? * or \\.';
    if (segment.endsWith(".") || segment.endsWith(" ")) return "A name cannot end with a dot or a space.";
    if (RESERVED_DEVICE_NAME.test(segment)) return `"${segment}" is a reserved name on Windows.`;
  }
  const normalized = segments.join("/");
  if (index.files.has(normalized) || index.folders.get(normalized)?.hasIndex) {
    return "A page already exists at this path.";
  }
  for (const ancestor of [...ancestorFolderPaths(normalized), normalized]) {
    if (index.folders.get(ancestor)?.isDb) return "That folder is a collection. Add an entry to it instead.";
    if (ancestor !== normalized && index.files.has(ancestor) && !index.folders.has(ancestor)) {
      return `"${ancestor}" is a page, not a folder.`;
    }
  }
  return null;
}

// ── Collections ───────────────────────────────────────────────────

export interface DbSortState {
  field: string;
  order: "asc" | "desc";
}

export const DEFAULT_DB_SORT: DbSortState = { field: "modified", order: "desc" };

export type DbField = DbSchema["fields"][number];

/** Schema fields other than the title, which every view renders on its own. */
export function visibleDbFields(schema: DbSchema): DbField[] {
  return schema.fields.filter((field) => field.name !== "title");
}

export function dbFieldLabel(name: string): string {
  const words = name.replace(/[-_]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : name;
}

function entryValue(entry: DbEntry, field: string): unknown {
  if (field === "title") return entry.title;
  if (field === "modified") return entry.modified;
  if (field === "created") return entry.created;
  return entry.fields[field];
}

function isBlank(value: unknown): boolean {
  return value == null || value === "";
}

function compareValues(a: unknown, b: unknown, asDate: boolean): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  const left = String(a);
  const right = String(b);
  if (asDate) {
    const leftTime = new Date(left).getTime();
    const rightTime = new Date(right).getTime();
    if (!Number.isNaN(leftTime) && !Number.isNaN(rightTime)) return leftTime - rightTime;
  }
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (!Number.isNaN(leftNumber) && !Number.isNaN(rightNumber)) return leftNumber - rightNumber;
  return left.localeCompare(right, undefined, { sensitivity: "base", numeric: true });
}

/** Sorts entries; blank values always sink to the bottom regardless of direction. */
export function sortDbEntries(entries: DbEntry[], sort: DbSortState, schema?: DbSchema | null): DbEntry[] {
  const fieldType = schema?.fields.find((field) => field.name === sort.field)?.type;
  const asDate = fieldType === "date" || sort.field === "modified" || sort.field === "created";
  const direction = sort.order === "asc" ? 1 : -1;
  return [...entries].sort((a, b) => {
    const left = entryValue(a, sort.field);
    const right = entryValue(b, sort.field);
    if (isBlank(left) && isBlank(right)) return 0;
    if (isBlank(left)) return 1;
    if (isBlank(right)) return -1;
    return compareValues(left, right, asDate) * direction;
  });
}

export function nextDbSort(current: DbSortState, field: string): DbSortState {
  if (current.field !== field) return { field, order: field === "title" ? "asc" : "desc" };
  return { field, order: current.order === "asc" ? "desc" : "asc" };
}

export interface DbFilterState {
  text: string;
  /** Selected option per select field; an absent key means "any". */
  selects: Record<string, string>;
}

export const EMPTY_DB_FILTER: DbFilterState = { text: "", selects: {} };

export function isDbFilterActive(filter: DbFilterState): boolean {
  return Boolean(filter.text.trim()) || Object.values(filter.selects).some(Boolean);
}

export function filterDbEntries(entries: DbEntry[], schema: DbSchema, filter: DbFilterState): DbEntry[] {
  const words = filter.text.toLowerCase().split(/\s+/).filter(Boolean);
  const selects = Object.entries(filter.selects).filter(([, value]) => Boolean(value));
  if (words.length === 0 && selects.length === 0) return entries;
  const fieldNames = schema.fields.map((field) => field.name);
  return entries.filter((entry) => {
    for (const [field, value] of selects) {
      if (String(entry.fields[field] ?? "") !== value) return false;
    }
    if (words.length === 0) return true;
    const haystack = [entry.title, ...(entry.tags ?? []), ...fieldNames.map((name) => {
      const value = entry.fields[name];
      return isBlank(value) ? "" : String(value);
    })].join(" ").toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

/** Option values for a select filter: the schema's options plus any stray values in use. */
export function selectFilterOptions(field: DbField, entries: DbEntry[]): string[] {
  const options = [...(field.options ?? [])];
  const seen = new Set(options);
  for (const entry of entries) {
    const value = entry.fields[field.name];
    if (isBlank(value)) continue;
    const text = String(value);
    if (!seen.has(text)) {
      seen.add(text);
      options.push(text);
    }
  }
  return options;
}

// ── Entry forms ───────────────────────────────────────────────────

export type EntryFormValues = Record<string, string | boolean>;

function toDateInputValue(value: unknown): string {
  if (isBlank(value)) return "";
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString().slice(0, 10);
}

/** Editable form state for an entry's schema fields. */
export function entryFormValues(schema: DbSchema, source: Record<string, unknown>): EntryFormValues {
  const values: EntryFormValues = {};
  for (const field of visibleDbFields(schema)) {
    const value = source[field.name];
    if (field.type === "boolean") values[field.name] = value === true || value === "true";
    else if (field.type === "date") values[field.name] = toDateInputValue(value);
    else values[field.name] = isBlank(value) ? "" : String(value);
  }
  return values;
}

/**
 * Turns form state into the fields payload. Creating omits blanks; updating sends `null` for a
 * cleared field, which the server stores as empty rather than rejecting an empty string.
 */
export function entryFieldsPayload(
  schema: DbSchema,
  values: EntryFormValues,
  mode: "create" | "update",
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const field of visibleDbFields(schema)) {
    const value = values[field.name];
    if (field.type === "boolean") {
      payload[field.name] = value === true;
      continue;
    }
    const text = typeof value === "string" ? value.trim() : "";
    if (!text) {
      if (mode === "update") payload[field.name] = null;
      continue;
    }
    payload[field.name] = field.type === "number" ? Number(text) : text;
  }
  return payload;
}

/** Client-side checks that mirror the server's, so problems show next to the field. */
export function validateEntryForm(schema: DbSchema, title: string, values: EntryFormValues): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!title.trim()) errors.title = "A title is required.";
  for (const field of visibleDbFields(schema)) {
    const value = values[field.name];
    const text = typeof value === "string" ? value.trim() : "";
    if (field.type === "boolean") continue;
    if (!text) {
      if (field.required) errors[field.name] = "This field is required.";
      continue;
    }
    if (field.type === "number" && Number.isNaN(Number(text))) errors[field.name] = "Enter a number.";
    if (field.type === "date" && Number.isNaN(Date.parse(text))) errors[field.name] = "Enter a valid date.";
    if (field.type === "url") {
      try {
        new URL(text);
      } catch {
        errors[field.name] = "Enter a full URL, including https://.";
      }
    }
  }
  return errors;
}

// ── Page editing ──────────────────────────────────────────────────

export interface PageDraftFields {
  title: string;
  description: string;
  tags: string[];
  body: string;
}

const MANAGED_FRONTMATTER_KEYS = new Set(["title", "description", "tags"]);

function readTags(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((tag): tag is string => typeof tag === "string" && Boolean(tag.trim()));
  return typeof value === "string" && value.trim() ? [value.trim()] : [];
}

export function pageDraftFromFrontmatter(frontmatter: Record<string, unknown>, body: string, fallbackTitle: string): PageDraftFields {
  return {
    title: typeof frontmatter.title === "string" && frontmatter.title.trim() ? frontmatter.title : fallbackTitle,
    description: typeof frontmatter.description === "string" ? frontmatter.description : "",
    tags: readTags(frontmatter.tags),
    body,
  };
}

/** Merges edited fields into the page's frontmatter, leaving every other key exactly as it was. */
export function mergePageFrontmatter(
  original: Record<string, unknown>,
  draft: Pick<PageDraftFields, "title" | "description" | "tags">,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  const title = draft.title.trim();
  const description = draft.description.trim();
  if (title) merged.title = title;
  if (description) merged.description = description;
  if (draft.tags.length > 0) merged.tags = draft.tags;
  for (const [key, value] of Object.entries(original)) {
    if (!MANAGED_FRONTMATTER_KEYS.has(key)) merged[key] = value;
  }
  return merged;
}

/** Tag names are free-form and matched case-insensitively, so only tidy what was typed. */
export function normalizeTag(value: string): string {
  return value.trim().replace(/^#+/, "").replace(/,+$/, "").replace(/\s+/g, " ").trim();
}

export function tagsMatch(a: string, b: string): boolean {
  return a.normalize("NFC").toUpperCase() === b.normalize("NFC").toUpperCase();
}

export function arePageDraftsEqual(a: PageDraftFields, b: PageDraftFields): boolean {
  return a.title === b.title
    && a.description === b.description
    && a.body === b.body
    && a.tags.length === b.tags.length
    && a.tags.every((tag, index) => tag === b.tags[index]);
}

/** Why a page draft cannot be saved yet, or null. Mirrors the server's tagged-doc rule. */
export function validatePageDraft(draft: PageDraftFields): string | null {
  if (!draft.title.trim()) return "Give the page a title.";
  if (draft.tags.length > 0 && !draft.description.trim()) {
    return "Tagged pages need a description, so agents can tell when the page is relevant.";
  }
  return null;
}
