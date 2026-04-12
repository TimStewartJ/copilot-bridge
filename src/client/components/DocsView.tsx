import {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
  useId,
  type ComponentPropsWithoutRef,
  type MouseEvent,
  type ReactNode,
} from "react";
import { useNavigate, useLocation } from "react-router-dom";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import {
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Database,
  ExternalLink,
  FileText,
  Folder,
  FolderOpen,
  List,
  Pencil,
  Plus,
  Save,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { setLastViewedDoc } from "../last-viewed";
import { useIsMobile } from "../useIsMobile";
import remarkWikilink from "../lib/remark-wikilink";
import CodeBlock from "./CodeBlock";
import {
  fetchDocsTree,
  fetchDocPage,
  writeDocPage,
  deleteDocPage,
  searchDocs,
  fetchDbSchema,
  fetchDbEntries,
  resolveWikilinks,
  type DocTreeNode,
  type DocPage,
  type DocSearchResult,
  type DbSchema,
  type DbEntry,
} from "../api";
import { TAG_COLOR_BG, TAG_COLOR_TEXT } from "../tag-colors";

const EXPANDED_KEY = "bridge-docs-expanded";
const DB_SORT_KEY = "bridge-docs-db-sort";
const DEFAULT_DB_SORT = { field: "modified", order: "desc" } as const;
const MOBILE_SHEET_SAFE_AREA = { paddingBottom: "env(safe-area-inset-bottom)" };

type DbSortState = { field: string; order: "asc" | "desc" };
type DocHeading = { id: string; text: string; level: number };
type DocCrumb = { label: string; path: string | null };
type DocsSheetProps = { title: string; onClose: () => void; children: ReactNode };

const DOCS_MARKDOWN_CLASSNAME = `
  prose prose-invert max-w-none text-text-primary
  prose-headings:scroll-mt-28 prose-headings:font-semibold prose-headings:tracking-tight prose-headings:text-text-primary
  prose-h1:text-3xl prose-h1:mt-0 prose-h1:mb-5
  prose-h2:text-2xl prose-h2:mt-10 prose-h2:mb-4 prose-h2:border-t prose-h2:border-border prose-h2:pt-6
  prose-h3:text-xl prose-h3:mt-8 prose-h3:mb-3
  prose-h4:text-lg prose-h4:mt-6 prose-h4:mb-2
  prose-p:my-4 prose-p:leading-7 prose-p:text-text-primary/95
  prose-li:my-1.5 prose-li:text-text-primary/95
  prose-ul:my-4 prose-ol:my-4
  prose-hr:border-border prose-hr:my-8
  prose-blockquote:my-6 prose-blockquote:rounded-2xl prose-blockquote:border prose-blockquote:border-border prose-blockquote:bg-bg-secondary/70 prose-blockquote:px-5 prose-blockquote:py-4 prose-blockquote:text-text-secondary
  prose-a:text-accent prose-a:no-underline hover:prose-a:underline
  prose-strong:text-text-primary prose-code:text-text-primary prose-code:bg-bg-secondary prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded-md prose-code:before:content-none prose-code:after:content-none
  prose-pre:bg-transparent prose-pre:border-0 prose-pre:p-0
  prose-table:my-6 prose-table:w-full
  prose-th:border prose-th:border-border prose-th:bg-bg-secondary prose-th:px-3 prose-th:py-2 prose-th:text-left prose-th:text-text-secondary
  prose-td:border prose-td:border-border prose-td:px-3 prose-td:py-2
  prose-img:rounded-2xl prose-img:border prose-img:border-border prose-img:shadow-sm
  [&_table]:block [&_table]:overflow-x-auto [&_table]:max-w-full
  [&_thead]:bg-bg-secondary/70
  [&_h1+a]:mt-0 [&_h2+a]:mt-0 [&_h3+a]:mt-0
`;

const SELECT_BADGE_COLORS = [
  { bg: "bg-blue-500/15", text: "text-blue-400" },
  { bg: "bg-emerald-500/15", text: "text-emerald-400" },
  { bg: "bg-amber-500/15", text: "text-amber-400" },
  { bg: "bg-purple-500/15", text: "text-purple-400" },
  { bg: "bg-rose-500/15", text: "text-rose-400" },
  { bg: "bg-cyan-500/15", text: "text-cyan-400" },
  { bg: "bg-orange-500/15", text: "text-orange-400" },
  { bg: "bg-indigo-500/15", text: "text-indigo-400" },
];

function getExpandedFolders(): Set<string> {
  try {
    const raw = localStorage.getItem(EXPANDED_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set<string>();
  } catch {
    return new Set<string>();
  }
}

function saveExpandedFolders(set: Set<string>) {
  localStorage.setItem(EXPANDED_KEY, JSON.stringify([...set]));
}

function getDbSort(folder: string): DbSortState {
  try {
    const raw = localStorage.getItem(DB_SORT_KEY);
    if (!raw) return DEFAULT_DB_SORT;
    const map = JSON.parse(raw) as Record<string, DbSortState>;
    return map[folder] ?? DEFAULT_DB_SORT;
  } catch {
    return DEFAULT_DB_SORT;
  }
}

function saveDbSort(folder: string, sort: DbSortState) {
  try {
    const raw = localStorage.getItem(DB_SORT_KEY);
    const map = raw ? JSON.parse(raw) as Record<string, DbSortState> : {};
    map[folder] = sort;
    localStorage.setItem(DB_SORT_KEY, JSON.stringify(map));
  } catch {
    // ignore local storage failures
  }
}

function sanitizeSnippet(html: string): string {
  return html
    .replace(/<(?!\/?mark\b)[^>]*>/gi, "")
    .replace(/&(?!amp;|lt;|gt;|quot;|#\d+;)/g, "&amp;");
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);

  useEffect(() => {
    const media = window.matchMedia(query);
    const onChange = (event: MediaQueryListEvent) => setMatches(event.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}

function resolveRelativePath(currentPath: string, href: string, currentIsDirectory: boolean): string {
  const hashIdx = href.indexOf("#");
  const rawPath = hashIdx >= 0 ? href.slice(0, hashIdx) : href;
  const fragment = hashIdx >= 0 ? href.slice(hashIdx) : "";
  const clean = rawPath.replace(/\.md$/, "");
  if (!clean) return currentPath + fragment;
  if (clean.startsWith("/")) return clean.slice(1) + fragment;
  const parts = currentPath.includes("/")
    ? currentIsDirectory ? currentPath.split("/") : currentPath.split("/").slice(0, -1)
    : currentIsDirectory ? [currentPath] : [];
  for (const seg of clean.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== ".") parts.push(seg);
  }
  return parts.filter(Boolean).join("/") + fragment;
}

function wikiUrlTransform(url: string): string {
  if (url.startsWith("wiki:")) return url;
  return defaultUrlTransform(url);
}

function hashString(s: string): number {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

function getBadgeColor(value: string, options?: string[]) {
  const idx = options?.indexOf(value);
  const colorIdx = idx != null && idx >= 0 ? idx : hashString(value);
  return SELECT_BADGE_COLORS[colorIdx % SELECT_BADGE_COLORS.length];
}

function formatDocDate(value: string): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function stripMarkdownInline(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_`~>#]/g, "")
    .trim();
}

function slugifyHeading(text: string): string {
  return stripMarkdownInline(text)
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-") || "section";
}

function extractNodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (!node) return "";
  if (Array.isArray(node)) return node.map(extractNodeText).join("");
  if (typeof node === "object" && "props" in node) {
    const props = (node as { props?: { children?: ReactNode } }).props;
    return extractNodeText(props?.children);
  }
  return "";
}

function extractHeadings(markdown: string): DocHeading[] {
  const headings: DocHeading[] = [];
  const counts = new Map<string, number>();
  let inFence = false;

  for (const line of markdown.split("\n")) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (!match) continue;
    const level = match[1].length;
    const text = stripMarkdownInline(match[2]);
    if (!text) continue;
    const baseId = slugifyHeading(text);
    const count = counts.get(baseId) ?? 0;
    counts.set(baseId, count + 1);
    headings.push({
      level,
      text,
      id: count === 0 ? baseId : `${baseId}-${count + 1}`,
    });
  }

  return headings;
}

function buildBreadcrumbs(path: string): DocCrumb[] {
  const parts = path.split("/").filter(Boolean);
  const crumbs: DocCrumb[] = [{ label: "Docs", path: "" }];
  for (let i = 0; i < parts.length; i++) {
    crumbs.push({
      label: parts[i],
      path: parts.slice(0, i + 1).join("/"),
    });
  }
  if (crumbs.length > 1) {
    crumbs[crumbs.length - 1] = { ...crumbs[crumbs.length - 1], path: null };
  }
  return crumbs;
}

function collectFolderIndexPaths(nodes: DocTreeNode[]): Set<string> {
  const paths = new Set<string>();
  const walk = (node: DocTreeNode) => {
    if (node.type === "folder") {
      if (node.hasIndex) paths.add(node.path);
      node.children?.forEach(walk);
    }
  };
  nodes.forEach(walk);
  return paths;
}

function collectFilePaths(nodes: DocTreeNode[]): Set<string> {
  const paths = new Set<string>();
  const walk = (node: DocTreeNode) => {
    if (node.type === "file") {
      paths.add(node.path);
      return;
    }
    node.children?.forEach(walk);
  };
  nodes.forEach(walk);
  return paths;
}

function collectNavigablePaths(nodes: DocTreeNode[]): string[] {
  const paths: string[] = [];
  const walk = (node: DocTreeNode) => {
    if (node.type === "folder") {
      if (node.hasIndex && !node.isDb) paths.push(node.path);
      node.children?.forEach(walk);
      return;
    }
    paths.push(node.path);
  };
  nodes.forEach(walk);
  return paths;
}

function deriveRelatedDocs(page: DocPage | null, tree: DocTreeNode[]): string[] {
  if (!page) return [];
  const folder = page.folder;
  const allPaths = collectNavigablePaths(tree).filter((path) => path !== page.path);
  const siblingPaths = allPaths.filter((path) => {
    const idx = path.lastIndexOf("/");
    return (idx >= 0 ? path.slice(0, idx) : "") === folder;
  });
  const tagMatches = allPaths.filter((path) => {
    const parts = path.split("/");
    return page.tags.some((tag) => parts.some((part) => part.toLowerCase() === tag.toLowerCase()));
  });
  return [...new Set([...siblingPaths, ...tagMatches])].slice(0, 8);
}

function DocsSheet({ title, onClose, children }: DocsSheetProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusables = [...dialogRef.current.querySelectorAll<HTMLElement>(
        'button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])',
      )].filter((el) => !el.hasAttribute("disabled") && el.tabIndex !== -1);

      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previousFocus?.focus();
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-start md:justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative flex max-h-[88vh] w-full flex-col rounded-t-3xl border border-border bg-bg-primary shadow-2xl md:mt-12 md:max-h-[80vh] md:max-w-2xl md:rounded-3xl"
        style={MOBILE_SHEET_SAFE_AREA}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="mx-auto h-1.5 w-12 rounded-full bg-border" />
        </div>
        <div className="flex items-center justify-between px-4 pb-3 pt-1">
          <h2 id={titleId} className="text-sm font-semibold text-text-primary">{title}</h2>
          <button
            ref={closeButtonRef}
            onClick={onClose}
            className="rounded-full p-2 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">{children}</div>
      </div>
    </div>
  );
}

function InfoPill({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center rounded-full border border-border bg-bg-primary px-2.5 py-1 text-[11px] font-medium text-text-secondary">
      {label}
    </span>
  );
}

function DbCell({ field, value }: { field: { name: string; type: string; options?: string[] }; value: unknown }) {
  if (value == null || value === "") return <span className="text-text-faint">—</span>;

  switch (field.type) {
    case "select": {
      const s = String(value);
      const c = getBadgeColor(s, field.options);
      return (
        <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-medium ${c.bg} ${c.text}`}>
          {s}
        </span>
      );
    }
    case "boolean":
      return value === true || value === "true"
        ? <Check size={13} className="text-emerald-400" />
        : <X size={13} className="text-text-faint" />;
    case "date":
      return <span className="whitespace-nowrap">{formatDocDate(String(value))}</span>;
    case "number":
      return <span className="tabular-nums">{String(value)}</span>;
    case "url":
      return (
        <a
          href={String(value)}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="inline-flex max-w-[220px] items-center gap-1 truncate text-accent hover:underline"
        >
          {String(value).replace(/^https?:\/\/(www\.)?/, "").slice(0, 40)}
          <ExternalLink size={10} className="shrink-0" />
        </a>
      );
    default:
      return <span>{String(value)}</span>;
  }
}

function TreeNode({
  node,
  depth,
  selectedPath,
  onSelect,
  expandedFolders,
  onToggleExpanded,
}: {
  node: DocTreeNode;
  depth: number;
  selectedPath: string | null;
  onSelect: (path: string, isDb?: boolean) => void;
  expandedFolders: Set<string>;
  onToggleExpanded: (path: string, expanded: boolean) => void;
}) {
  const isFolder = node.type === "folder";
  const isSelected = node.path === selectedPath;
  const expanded = isFolder && expandedFolders.has(node.path);

  const toggleExpand = useCallback(() => {
    onToggleExpanded(node.path, !expanded);
  }, [node.path, expanded, onToggleExpanded]);

  if (isFolder) {
    return (
      <div>
        <div
          className={`flex w-full items-center gap-1.5 rounded-xl px-2 py-1.5 text-sm transition-colors ${
            isSelected
              ? "bg-accent/10 text-text-primary"
              : "text-text-muted hover:bg-bg-hover hover:text-text-primary"
          }`}
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
        >
          <button
            onClick={(e) => {
              e.stopPropagation();
              toggleExpand();
            }}
            className="shrink-0 rounded-md p-1 transition-colors hover:bg-bg-primary"
            aria-label={expanded ? "Collapse folder" : "Expand folder"}
          >
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
          <button
            onClick={() => {
              if (node.isDb) onSelect(node.path, true);
              else if (node.hasIndex) {
                onToggleExpanded(node.path, true);
                onSelect(node.path);
              } else {
                toggleExpand();
              }
            }}
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
          >
            {node.isDb ? (
              <Database size={15} className="shrink-0 text-accent" />
            ) : expanded ? (
              <FolderOpen size={15} className="shrink-0 text-text-secondary" />
            ) : (
              <Folder size={15} className="shrink-0 text-text-secondary" />
            )}
            <span className="truncate">{node.name}</span>
          </button>
        </div>
        {expanded && node.children && (
          <div className="space-y-0.5 py-0.5">
            {node.children.map((child) => (
              <TreeNode
                key={child.path}
                node={child}
                depth={depth + 1}
                selectedPath={selectedPath}
                onSelect={onSelect}
                expandedFolders={expandedFolders}
                onToggleExpanded={onToggleExpanded}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <button
      onClick={() => onSelect(node.path)}
      className={`flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left text-sm transition-colors ${
        isSelected
          ? "bg-accent/10 text-text-primary"
          : "text-text-muted hover:bg-bg-hover hover:text-text-primary"
      }`}
      style={{ paddingLeft: `${depth * 16 + 28}px` }}
    >
      <FileText size={15} className="shrink-0 text-text-secondary" />
      <span className="truncate">{node.name}</span>
    </button>
  );
}

export default function DocsView() {
  const navigate = useNavigate();
  const location = useLocation();
  const isMobile = useIsMobile();
  const showDesktopInspector = useMediaQuery("(min-width: 1280px)");
  const newPagePathInputId = useId();
  const newPageContentInputId = useId();
  const editorContentInputId = useId();

  const urlDocPath = location.pathname.replace(/^\/docs\/?/, "").replace(/\/+$/, "") || null;
  const isDbFromUrl = new URLSearchParams(location.search).has("db");
  const selectedPath = urlDocPath;

  const [tree, setTree] = useState<DocTreeNode[]>([]);
  const [treeLoading, setTreeLoading] = useState(true);
  const [hasRootIndex, setHasRootIndex] = useState(false);

  const [page, setPage] = useState<DocPage | null>(null);
  const [pageLoading, setPageLoading] = useState(false);
  const [dbItemSchema, setDbItemSchema] = useState<DbSchema | null>(null);
  const [editing, setEditing] = useState(false);
  const [editorContent, setEditorContent] = useState("");
  const [creatingNew, setCreatingNew] = useState(false);
  const [newPagePath, setNewPagePath] = useState("");
  const [newPageContent, setNewPageContent] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<DocSearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [navigatorOpen, setNavigatorOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [dbSchema, setDbSchema] = useState<DbSchema | null>(null);
  const [dbEntries, setDbEntries] = useState<DbEntry[]>([]);
  const [dbTotal, setDbTotal] = useState<number | null>(null);
  const [dbFolder, setDbFolder] = useState<string | null>(null);
  const [dbSort, setDbSort] = useState<DbSortState>(DEFAULT_DB_SORT);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => getExpandedFolders());
  const [resolvedLinks, setResolvedLinks] = useState<Record<string, { path: string; title: string } | null>>({});
  const [activeHeadingId, setActiveHeadingId] = useState<string | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pageScrollRef = useRef<HTMLDivElement | null>(null);
  const renderedHeadingIndexRef = useRef(0);

  renderedHeadingIndexRef.current = 0;

  useEffect(() => {
    if (dbFolder) setDbSort(getDbSort(dbFolder));
  }, [dbFolder]);

  const handleToggleExpanded = useCallback((path: string, expanded: boolean) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (expanded) next.add(path);
      else next.delete(path);
      saveExpandedFolders(next);
      return next;
    });
  }, []);

  const loadTree = useCallback(async () => {
    setTreeLoading(true);
    try {
      const data = await fetchDocsTree();
      setTree(data.tree);
      setHasRootIndex(data.hasRootIndex);
      setExpandedFolders((prev) => {
        if (prev.size > 0) return prev;
        const topFolders = data.tree
          .filter((n) => n.type === "folder")
          .map((n) => n.path);
        if (topFolders.length === 0) return prev;
        const next = new Set(topFolders);
        saveExpandedFolders(next);
        return next;
      });
    } catch {
      setTree([]);
      setHasRootIndex(false);
    } finally {
      setTreeLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTree();
  }, [loadTree]);

  useEffect(() => {
    if (!treeLoading && hasRootIndex && !selectedPath) {
      navigate(`/docs/index${location.hash}`, { replace: true });
    }
  }, [treeLoading, hasRootIndex, selectedPath, navigate, location.hash]);

  useEffect(() => {
    if (!selectedPath) {
      setPage(null);
      setDbFolder(null);
      setDbSchema(null);
      return;
    }

    let cancelled = false;
    setEditing(false);
    setCreatingNew(false);
    setPageLoading(true);
    setNavigatorOpen(false);
    setInspectorOpen(false);
    setDbItemSchema(null);

    if (isDbFromUrl) {
      setPage(null);
      setDbFolder(selectedPath);
      Promise.all([fetchDbSchema(selectedPath), fetchDbEntries(selectedPath)])
        .then(([schema, data]) => {
          if (cancelled) return;
          setDbSchema(schema);
          setDbEntries(data.entries);
          setDbTotal(data.total);
        })
        .catch(() => {
          if (cancelled) return;
          setDbSchema(null);
          setDbEntries([]);
          setDbTotal(null);
        })
        .finally(() => {
          if (!cancelled) setPageLoading(false);
        });
    } else {
      setDbFolder(null);
      setDbSchema(null);
      setPage(null);
      fetchDocPage(selectedPath)
        .then((p) => {
          if (!cancelled) setPage(p);
        })
        .catch(() => {
          if (!cancelled) setPage(null);
        })
        .finally(() => {
          if (!cancelled) setPageLoading(false);
        });
    }

    setLastViewedDoc(isDbFromUrl ? `${selectedPath}?db` : selectedPath);

    return () => {
      cancelled = true;
    };
  }, [selectedPath, isDbFromUrl]);

  const sortedDbEntries = useMemo(() => {
    if (!dbEntries.length || !dbSort) return dbEntries;
    const { field, order } = dbSort;
    return [...dbEntries].sort((a, b) => {
      let va: unknown;
      let vb: unknown;
      if (field === "title") {
        va = a.title;
        vb = b.title;
      } else if (field === "modified") {
        va = a.modified;
        vb = b.modified;
      } else if (field === "created") {
        va = a.created;
        vb = b.created;
      } else {
        va = a.fields[field];
        vb = b.fields[field];
      }
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === "number" && typeof vb === "number") return order === "asc" ? va - vb : vb - va;
      if (typeof va === "boolean" && typeof vb === "boolean") {
        return order === "asc" ? Number(va) - Number(vb) : Number(vb) - Number(va);
      }
      const sa = String(va);
      const sb = String(vb);
      if (field === "modified" || field === "created") {
        const da = new Date(sa).getTime();
        const db = new Date(sb).getTime();
        if (!Number.isNaN(da) && !Number.isNaN(db)) return order === "asc" ? da - db : db - da;
      }
      const na = Number(sa);
      const nb = Number(sb);
      if (!Number.isNaN(na) && !Number.isNaN(nb) && sa !== "" && sb !== "") {
        return order === "asc" ? na - nb : nb - na;
      }
      const cmp = sa.localeCompare(sb, undefined, { sensitivity: "base" });
      return order === "asc" ? cmp : -cmp;
    });
  }, [dbEntries, dbSort]);

  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchResults(null);
      return;
    }
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(async () => {
      setSearching(true);
      try {
        const data = await searchDocs(searchQuery);
        setSearchResults(data.results);
      } catch {
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    }, 250);

    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [searchQuery]);

  const handleSelectNode = useCallback((path: string, isDb?: boolean) => {
    const url = isDb ? `/docs/${path}?db` : `/docs/${path}`;
    setNavigatorOpen(false);
    setInspectorOpen(false);
    navigate(url);
  }, [navigate]);

  const handleSave = useCallback(async () => {
    if (!selectedPath) return;
    try {
      await writeDocPage(selectedPath, editorContent);
      const nextPage = await fetchDocPage(selectedPath);
      setPage(nextPage);
      setEditing(false);
    } catch (err) {
      console.error("Save failed:", err);
    }
  }, [selectedPath, editorContent]);

  const handleDelete = useCallback(async () => {
    if (!selectedPath) return;
    if (!confirm("Delete this page?")) return;
    try {
      await deleteDocPage(selectedPath);
      setPage(null);
      loadTree();
      navigate("/docs", { replace: true });
    } catch (err) {
      console.error("Delete failed:", err);
    }
  }, [selectedPath, loadTree, navigate]);

  const handleCreateNew = useCallback(async () => {
    if (!newPagePath.trim()) return;
    try {
      await writeDocPage(newPagePath, newPageContent || "---\ntitle: New Page\n---\n\n");
      setCreatingNew(false);
      setNewPagePath("");
      setNewPageContent("");
      await loadTree();
      handleSelectNode(newPagePath);
    } catch (err) {
      console.error("Create failed:", err);
    }
  }, [newPagePath, newPageContent, loadTree, handleSelectNode]);

  const startEdit = useCallback(() => {
    if (!page) return;
    const frontmatter = Object.keys(page.frontmatter).length
      ? `---\n${Object.entries(page.frontmatter)
          .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
          .join("\n")}\n---\n\n`
      : "";
    setEditorContent(frontmatter + page.body);
    setEditing(true);
  }, [page]);

  const handleGoHome = useCallback(() => {
    if (hasRootIndex) {
      navigate("/docs/index");
      return;
    }
    setPage(null);
    setEditing(false);
    setCreatingNew(false);
    setDbFolder(null);
    setDbSchema(null);
    navigate("/docs");
  }, [hasRootIndex, navigate]);

  useEffect(() => {
    if (!page?.body) return;
    const re = /\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]/g;
    const targets = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = re.exec(page.body)) !== null) targets.add(match[1].trim());
    if (targets.size === 0) {
      setResolvedLinks({});
      return;
    }

    let cancelled = false;
    resolveWikilinks([...targets]).then((result) => {
      if (!cancelled) setResolvedLinks(result);
    }).catch(() => {
      if (!cancelled) setResolvedLinks({});
    });

    return () => {
      cancelled = true;
    };
  }, [page?.body]);

  useEffect(() => {
    if (!page?.folder || !page.isDbItem) {
      setDbItemSchema(null);
      return;
    }

    let cancelled = false;
    setDbItemSchema(null);
    fetchDbSchema(page.folder)
      .then((schema) => {
        if (!cancelled) setDbItemSchema(schema);
      })
      .catch(() => {
        if (!cancelled) setDbItemSchema(null);
      });

    return () => {
      cancelled = true;
    };
  }, [page?.path, page?.folder, page?.isDbItem]);

  const pageHeadings = useMemo(() => extractHeadings(page?.body ?? ""), [page?.body]);
  const breadcrumbs = useMemo(() => (page ? buildBreadcrumbs(page.path) : []), [page]);
  const relatedDocs = useMemo(() => deriveRelatedDocs(page, tree), [page, tree]);
  const navigablePaths = useMemo(() => new Set(collectNavigablePaths(tree)), [tree]);
  const folderIndexPaths = useMemo(() => collectFolderIndexPaths(tree), [tree]);
  const filePaths = useMemo(() => collectFilePaths(tree), [tree]);
  const selectedPathIsDirectory = useMemo(
    () => {
      if (!selectedPath) return false;
      if (page?.path === selectedPath) return page.isFolderIndex;
      return folderIndexPaths.has(selectedPath);
    },
    [folderIndexPaths, selectedPath, page],
  );
  const normalizeResolvedDocPath = useCallback((docPath: string) => {
    if (!docPath.endsWith("/index")) return docPath;
    const folderPath = docPath.slice(0, -"/index".length);
    return folderIndexPaths.has(folderPath) && !filePaths.has(folderPath) ? folderPath : docPath;
  }, [folderIndexPaths, filePaths]);

  useEffect(() => {
    setActiveHeadingId(pageHeadings[0]?.id ?? null);
  }, [pageHeadings]);

  useEffect(() => {
    if (!pageHeadings.length) return;

    const scrollContainer = pageScrollRef.current;
    if (!scrollContainer) return;

    const updateActiveHeading = () => {
      const headingElements = pageHeadings
        .map((heading) => document.getElementById(heading.id))
        .filter((el): el is HTMLElement => !!el);
      if (headingElements.length === 0) return;

      const containerRect = scrollContainer.getBoundingClientRect();
      let visible: HTMLElement | null = null;
      for (const heading of headingElements) {
        const relativeTop = heading.getBoundingClientRect().top - containerRect.top;
        if (relativeTop <= 72) visible = heading;
      }
      setActiveHeadingId(visible?.id ?? headingElements[0].id);
    };

    updateActiveHeading();
    scrollContainer.addEventListener("scroll", updateActiveHeading, { passive: true });
    window.addEventListener("resize", updateActiveHeading);
    return () => {
      scrollContainer.removeEventListener("scroll", updateActiveHeading);
      window.removeEventListener("resize", updateActiveHeading);
    };
  }, [pageHeadings, page?.path]);

  useEffect(() => {
    if (!page) return;
    const frameId = requestAnimationFrame(() => {
      if (!selectedPath || page.path !== selectedPath) return;
      const container = pageScrollRef.current;
      if (!container) return;
      if (!location.hash) {
        container.scrollTo({ top: 0, behavior: "auto" });
        return;
      }
      const id = decodeURIComponent(location.hash.slice(1));
      const heading = document.getElementById(id);
      if (!heading) {
        container.scrollTo({ top: 0, behavior: "auto" });
        return;
      }
      const containerRect = container.getBoundingClientRect();
      const headingRect = heading.getBoundingClientRect();
      const top = headingRect.top - containerRect.top + container.scrollTop - 24;
      container.scrollTo({ top: Math.max(top, 0), behavior: "auto" });
    });
    return () => cancelAnimationFrame(frameId);
  }, [page?.path, selectedPath, location.hash]);

  const updateHash = useCallback((id: string) => {
    const nextUrl = `${location.pathname}${location.search}#${encodeURIComponent(id)}`;
    window.history.replaceState(window.history.state, "", nextUrl);
  }, [location.pathname, location.search]);

  const scrollToHeading = useCallback((id: string, behavior: ScrollBehavior = "smooth") => {
    const container = pageScrollRef.current;
    const heading = document.getElementById(id);
    if (!container || !heading) return;
    const containerRect = container.getBoundingClientRect();
    const headingRect = heading.getBoundingClientRect();
    const top = headingRect.top - containerRect.top + container.scrollTop - 24;
    container.scrollTo({ top: Math.max(top, 0), behavior });
    setActiveHeadingId(id);
  }, []);

  const remarkPlugins = useMemo(() => [remarkGfm, remarkBreaks, remarkWikilink], []);

  const markdownComponents = useMemo(() => {
    const renderHeading = (level: number) => {
      return ({ children, ...props }: ComponentPropsWithoutRef<"h2">) => {
        const fallbackText = extractNodeText(children);
        const fallbackId = slugifyHeading(fallbackText);
        const nextHeading = pageHeadings[renderedHeadingIndexRef.current];
        const id = nextHeading?.level === level ? nextHeading.id : fallbackId;
        if (nextHeading?.level === level) renderedHeadingIndexRef.current += 1;
        return (
          <div className="group relative">
            <a
              href={`#${id}`}
              className="absolute -left-6 top-1 hidden rounded-md px-1 text-text-faint transition-colors hover:text-accent group-hover:inline-flex"
              onClick={(e) => {
                e.preventDefault();
                scrollToHeading(id);
                updateHash(id);
              }}
              aria-label={`Link to ${fallbackText}`}
            >
              #
            </a>
            {level === 1 && <h1 id={id} {...props}>{children}</h1>}
            {level === 2 && <h2 id={id} {...props}>{children}</h2>}
            {level === 3 && <h3 id={id} {...props}>{children}</h3>}
            {level === 4 && <h4 id={id} {...props}>{children}</h4>}
            {level === 5 && <h5 id={id} {...props}>{children}</h5>}
            {level === 6 && <h6 id={id} {...props}>{children}</h6>}
          </div>
        );
      };
    };

    return {
      pre: CodeBlock,
      h1: renderHeading(1),
      h2: renderHeading(2),
      h3: renderHeading(3),
      h4: renderHeading(4),
      h5: renderHeading(5),
      h6: renderHeading(6),
      a: ({ href, children, node: _node, ...props }: { href?: string; children?: ReactNode; node?: unknown }) => {
        if (href?.startsWith("wiki:")) {
          const target = href.slice(5);
          const resolved = resolvedLinks[target];
          const isBroken = resolvedLinks[target] === null && target in resolvedLinks;
          return (
            <a
              {...props}
              href="#"
              onClick={(e: MouseEvent<HTMLAnchorElement>) => {
                e.preventDefault();
                if (resolved) navigate(`/docs/${resolved.path}`);
              }}
              className={isBroken ? "cursor-not-allowed text-red-400 opacity-70" : undefined}
              title={isBroken ? `Page not found: ${target}` : resolved?.title || target}
            >
              {children}
            </a>
          );
        }

        if (href && /^[a-z][a-z0-9+.-]*:/i.test(href)) {
          return <a {...props} href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
        }

        if (!href) {
          return <a {...props} href={href}>{children}</a>;
        }

        if (href.startsWith("#")) {
          return (
            <a
              {...props}
              href={href}
              onClick={(e: MouseEvent<HTMLAnchorElement>) => {
                e.preventDefault();
                const id = decodeURIComponent(href.slice(1));
                scrollToHeading(id);
                updateHash(id);
              }}
            >
              {children}
            </a>
          );
        }

        if (selectedPath) {
          const resolvedPath = resolveRelativePath(selectedPath, href, selectedPathIsDirectory);
          const fragmentIndex = resolvedPath.indexOf("#");
          const rawResolvedDocPath = fragmentIndex >= 0 ? resolvedPath.slice(0, fragmentIndex) : resolvedPath;
          const resolvedFragment = fragmentIndex >= 0 ? resolvedPath.slice(fragmentIndex) : "";
          const resolvedDocPath = normalizeResolvedDocPath(rawResolvedDocPath);
          const routeTarget = resolvedDocPath === selectedPath
            ? `${location.pathname}${location.search}${resolvedFragment}`
            : `/docs/${resolvedDocPath}${resolvedFragment}`;
          return (
            <a
              {...props}
              href={routeTarget}
              onClick={(e: MouseEvent<HTMLAnchorElement>) => {
                e.preventDefault();
                navigate(routeTarget);
              }}
            >
              {children}
            </a>
          );
        }

        return <a {...props} href={href}>{children}</a>;
      },
    };
  }, [pageHeadings, resolvedLinks, selectedPath, selectedPathIsDirectory, navigate, scrollToHeading, updateHash]);

  const handleBreadcrumbSelect = useCallback((crumbPath: string) => {
    if (!page) {
      handleSelectNode(crumbPath);
      return;
    }
    if (crumbPath === "") {
      handleGoHome();
      return;
    }
    if (page.isDbItem && crumbPath === page.folder) {
      handleSelectNode(crumbPath, true);
      return;
    }
    if (navigablePaths.has(crumbPath)) {
      handleSelectNode(crumbPath);
    }
  }, [page, handleGoHome, handleSelectNode, navigablePaths]);

  const openCreatePage = useCallback(() => {
    setCreatingNew(true);
    setEditing(false);
    setPage(null);
    setDbFolder(null);
    setNavigatorOpen(false);
    setNewPagePath("");
    setNewPageContent("---\ntitle: \ntags: []\n---\n\n");
    navigate("/docs");
  }, [navigate]);

  const sidebar = (
    <div className="flex h-full flex-col bg-bg-secondary">
      <div className="border-b border-border px-4 py-4">
        <button
          onClick={handleGoHome}
          className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-text-primary transition-colors hover:bg-bg-hover"
        >
          <BookOpen size={16} className="shrink-0 text-accent" />
          <div className="min-w-0">
            <div className="text-sm font-semibold">Docs</div>
            <div className="truncate text-xs text-text-faint">Knowledge base and collections</div>
          </div>
        </button>
      </div>

      <div className="border-b border-border px-3 py-3">
        <div className="relative">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-faint" />
          <input
            type="text"
            placeholder="Search docs..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            aria-label="Search docs"
            className="w-full rounded-xl border border-border bg-bg-primary py-2 pl-9 pr-9 text-sm text-text-primary placeholder:text-text-faint focus:outline-none focus:ring-1 focus:ring-accent"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1 text-text-faint transition-colors hover:bg-bg-hover hover:text-text-primary"
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {searchResults !== null ? (
          searching ? (
            <div className="px-3 py-6 text-center text-sm text-text-faint">Searching...</div>
          ) : searchResults.length === 0 ? (
            <div className="px-3 py-6 text-center text-sm text-text-faint">No results</div>
          ) : (
            <div className="space-y-1">
              {searchResults.map((result) => (
                <button
                  key={result.path}
                  onClick={() => {
                    setSearchQuery("");
                    setSearchResults(null);
                    handleSelectNode(result.path);
                  }}
                  className={`w-full rounded-2xl px-3 py-2.5 text-left transition-colors ${
                    result.path === selectedPath ? "bg-accent/10" : "hover:bg-bg-hover"
                  }`}
                >
                  <div className="truncate text-sm font-medium text-text-primary">{result.title}</div>
                  <div className="truncate text-[11px] text-text-faint">{result.path}</div>
                  {result.snippet && (
                    <div
                      className="mt-1 line-clamp-2 text-[11px] text-text-muted"
                      dangerouslySetInnerHTML={{ __html: sanitizeSnippet(result.snippet) }}
                    />
                  )}
                </button>
              ))}
            </div>
          )
        ) : treeLoading ? (
          <div className="px-3 py-6 text-center text-sm text-text-faint">Loading...</div>
        ) : tree.length === 0 ? (
          <div className="px-3 py-6 text-center text-sm text-text-faint">No docs yet</div>
        ) : (
          <div className="space-y-0.5">
            {tree.map((node) => (
              <TreeNode
                key={node.path}
                node={node}
                depth={0}
                selectedPath={selectedPath}
                onSelect={handleSelectNode}
                expandedFolders={expandedFolders}
                onToggleExpanded={handleToggleExpanded}
              />
            ))}
          </div>
        )}
      </div>

      <div className="border-t border-border px-3 py-3">
        <button
          onClick={openCreatePage}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-bg-primary px-3 py-2.5 text-sm font-medium text-text-primary transition-colors hover:bg-bg-hover"
        >
          <Plus size={14} />
          New page
        </button>
      </div>
    </div>
  );

  const pageMetaCard = page ? (
    <div className="rounded-2xl border border-border bg-bg-secondary/70 p-4">
      <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-text-faint">Page info</div>
      <dl className="mt-3 space-y-3 text-sm">
        <div>
          <dt className="text-xs text-text-faint">Path</dt>
          <dd className="mt-1 break-all text-text-primary">{page.path}</dd>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <dt className="text-xs text-text-faint">Created</dt>
            <dd className="mt-1 text-text-primary">{formatDocDate(page.created)}</dd>
          </div>
          <div>
            <dt className="text-xs text-text-faint">Updated</dt>
            <dd className="mt-1 text-text-primary">{formatDocDate(page.modified)}</dd>
          </div>
        </div>
        {page.tags.length > 0 && (
          <div>
            <dt className="text-xs text-text-faint">Tags</dt>
            <dd className="mt-2 flex flex-wrap gap-1.5">
              {page.tags.map((tag) => {
                const bg = TAG_COLOR_BG[tag] ?? "bg-bg-hover";
                const text = TAG_COLOR_TEXT[tag] ?? "text-text-muted";
                return (
                  <span key={tag} className={`rounded-full px-2 py-1 text-[11px] font-medium ${bg} ${text}`}>
                    {tag}
                  </span>
                );
              })}
            </dd>
          </div>
        )}
      </dl>
    </div>
  ) : null;

  const tocCard = pageHeadings.length > 0 ? (
    <div className="rounded-2xl border border-border bg-bg-secondary/70 p-4">
      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-text-faint">
        <List size={14} />
        Contents
      </div>
      <nav className="mt-3 space-y-1">
        {pageHeadings.map((heading) => (
          <button
            key={heading.id}
            onClick={() => {
              setInspectorOpen(false);
              scrollToHeading(heading.id);
              updateHash(heading.id);
            }}
            className={`w-full rounded-xl px-2 py-1.5 text-left text-sm transition-colors ${
              activeHeadingId === heading.id
                ? "bg-accent/10 text-text-primary"
                : "text-text-muted hover:bg-bg-hover hover:text-text-primary"
            }`}
            style={{ paddingLeft: `${heading.level * 10}px` }}
          >
            {heading.text}
          </button>
        ))}
      </nav>
    </div>
  ) : null;

  const relatedDocsCard = relatedDocs.length > 0 ? (
    <div className="rounded-2xl border border-border bg-bg-secondary/70 p-4">
      <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-text-faint">Related docs</div>
      <div className="mt-3 space-y-1.5">
        {relatedDocs.map((path) => (
          <button
            key={path}
            onClick={() => handleSelectNode(path)}
            className="flex w-full items-center justify-between rounded-xl px-2 py-2 text-left text-sm text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
          >
            <span className="truncate">{path}</span>
            <ChevronRight size={14} className="shrink-0" />
          </button>
        ))}
      </div>
    </div>
  ) : null;

  const rightRail = page && showDesktopInspector ? (
    <aside className="w-[300px] shrink-0 overflow-hidden">
      <div className="sticky top-0 flex h-full flex-col gap-4 overflow-y-auto px-4 py-6">
        {tocCard}
        {pageMetaCard}
        {relatedDocsCard}
      </div>
    </aside>
  ) : null;

  const pageHeader = page ? (
    <div className="shrink-0 border-b border-border bg-gradient-to-b from-bg-secondary to-bg-primary">
      <div className="mx-auto max-w-4xl px-5 py-6 sm:px-8">
        <div className="flex flex-wrap items-center gap-2 text-xs text-text-faint">
          {breadcrumbs.map((crumb, index) => (
            <div key={`${crumb.label}-${crumb.path ?? "current"}`} className="flex items-center gap-2">
              {index > 0 && <ChevronRight size={12} />}
              {crumb.path !== null && (crumb.path === "" || navigablePaths.has(crumb.path) || (page.isDbItem && crumb.path === page.folder)) ? (
                <button
                  onClick={() => handleBreadcrumbSelect(crumb.path)}
                  className="max-w-[180px] truncate rounded-md px-1.5 py-0.5 transition-colors hover:bg-bg-hover hover:text-text-primary"
                >
                  {crumb.label}
                </button>
              ) : (
                <span className="max-w-[200px] truncate text-text-secondary">{crumb.label}</span>
              )}
            </div>
          ))}
        </div>
        <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h1 className="text-3xl font-semibold tracking-tight text-text-primary sm:text-4xl">{page.title}</h1>
            <div className="mt-3 flex flex-wrap gap-2">
              <InfoPill label={`Updated ${formatDocDate(page.modified)}`} />
              {page.created && <InfoPill label={`Created ${formatDocDate(page.created)}`} />}
              {page.isDbItem && <InfoPill label="Database entry" />}
            </div>
            {page.tags.length > 0 && (
              <div className="mt-4 flex flex-wrap gap-2">
                {page.tags.map((tag) => {
                  const bg = TAG_COLOR_BG[tag] ?? "bg-bg-hover";
                  const text = TAG_COLOR_TEXT[tag] ?? "text-text-muted";
                  return (
                    <span key={tag} className={`rounded-full px-2.5 py-1 text-xs font-medium ${bg} ${text}`}>
                      {tag}
                    </span>
                  );
                })}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2 self-start">
            {!showDesktopInspector && (
              <button
                onClick={() => setInspectorOpen(true)}
                className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary transition-colors hover:bg-bg-hover xl:hidden"
              >
                <List size={14} />
                Details
              </button>
            )}
            <button
              onClick={startEdit}
              className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary transition-colors hover:bg-bg-hover"
            >
              <Pencil size={14} />
              Edit
            </button>
            <button
              onClick={handleDelete}
              className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-red-300 transition-colors hover:bg-red-500/10 hover:text-red-200"
            >
              <Trash2 size={14} />
              Delete
            </button>
          </div>
        </div>
      </div>
      {isMobile && (
        <div className="border-t border-border/70 px-4 py-2">
          <div className="flex gap-2 overflow-x-auto pb-1">
            <button
              onClick={() => setNavigatorOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
            >
              <BookOpen size={14} />
              Browse
            </button>
            {!showDesktopInspector && (
              <button
                onClick={() => setInspectorOpen(true)}
                className="inline-flex items-center gap-1.5 rounded-full border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
              >
                <List size={14} />
                Contents
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  ) : null;

  const pageContent = page ? (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div ref={pageScrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {pageHeader}
          {dbItemSchema?.fields.filter((field) => field.name !== "title").length ? (
            <div className="shrink-0 border-b border-border bg-bg-secondary/50">
              <div className="mx-auto max-w-4xl px-5 py-4 sm:px-8">
                <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-text-faint">Properties</div>
                <dl className="mt-3 grid gap-x-6 gap-y-3 sm:grid-cols-[minmax(0,160px)_minmax(0,1fr)]">
                  {dbItemSchema?.fields.filter((field) => field.name !== "title").map((field) => (
                    <div key={field.name} className="grid gap-1 sm:contents">
                      <dt className="text-sm text-text-muted">{field.name}</dt>
                      <dd className="min-w-0 text-sm text-text-primary">
                        <DbCell field={field} value={page.frontmatter[field.name]} />
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            </div>
          ) : null}
          <article className="mx-auto max-w-4xl px-5 py-8 sm:px-8 sm:py-10">
            <div className={`${DOCS_MARKDOWN_CLASSNAME} prose-sm sm:prose-base`}>
              <ReactMarkdown remarkPlugins={remarkPlugins} components={markdownComponents} urlTransform={wikiUrlTransform}>
                {page.body}
              </ReactMarkdown>
            </div>
          </article>
        </div>
      </div>
      {rightRail}
    </div>
  ) : null;

  const dbCollectionView = dbFolder && dbSchema ? (() => {
    const visibleFields = dbSchema.fields.filter((f) => f.name !== "title");
    const handleSort = (field: string) => {
      setDbSort((prev) => {
        const next = prev.field === field
          ? { field, order: prev.order === "asc" ? "desc" : "asc" }
          : { field, order: "desc" };
        saveDbSort(dbFolder, next);
        return next;
      });
    };

    const SortIcon = ({ field }: { field: string }) => {
      if (dbSort.field !== field) return null;
      return dbSort.order === "asc"
        ? <ChevronUp size={12} className="ml-1 inline" />
        : <ChevronDown size={12} className="ml-1 inline" />;
    };

    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="border-b border-border bg-gradient-to-b from-bg-secondary to-bg-primary px-5 py-5 sm:px-8">
          <div className="mx-auto max-w-6xl">
            <div className="flex items-start gap-3">
              <div className="rounded-2xl bg-accent/10 p-3 text-accent">
                <Database size={18} />
              </div>
              <div className="min-w-0">
                <h2 className="text-2xl font-semibold tracking-tight text-text-primary">{dbSchema.name}</h2>
                <p className="mt-1 text-sm text-text-muted">
                  {dbTotal ?? dbEntries.length} entries · {dbSchema.fields.length} fields
                </p>
              </div>
            </div>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-3 py-4 sm:px-6">
          <div className="overflow-hidden rounded-2xl border border-border bg-bg-primary">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="sticky top-0 z-10 bg-bg-secondary text-text-muted">
                <tr className="border-b border-border">
                  <th className="px-4 py-3 text-left font-medium">
                    <button onClick={() => handleSort("title")} className="transition-colors hover:text-text-primary">
                      Title<SortIcon field="title" />
                    </button>
                  </th>
                  {visibleFields.map((field) => (
                    <th key={field.name} className={`px-4 py-3 font-medium ${field.type === "number" ? "text-right" : "text-left"}`}>
                      <button onClick={() => handleSort(field.name)} className="transition-colors hover:text-text-primary">
                        {field.name}<SortIcon field={field.name} />
                      </button>
                    </th>
                  ))}
                  <th className="px-4 py-3 text-left font-medium">
                    <button onClick={() => handleSort("modified")} className="transition-colors hover:text-text-primary">
                      Modified<SortIcon field="modified" />
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                {sortedDbEntries.map((entry) => (
                  <tr
                    key={entry.path}
                    onClick={() => handleSelectNode(entry.path)}
                    className="cursor-pointer border-b border-border transition-colors hover:bg-bg-hover"
                  >
                    <td className="px-4 py-3 font-medium text-text-primary">{entry.title}</td>
                    {visibleFields.map((field) => (
                      <td key={field.name} className={`px-4 py-3 text-text-muted ${field.type === "number" ? "text-right" : ""}`}>
                        <DbCell field={field} value={entry.fields[field.name]} />
                      </td>
                    ))}
                    <td className="whitespace-nowrap px-4 py-3 text-text-faint">{formatDocDate(entry.modified)}</td>
                  </tr>
                ))}
                {sortedDbEntries.length === 0 && (
                  <tr>
                    <td colSpan={visibleFields.length + 2} className="px-4 py-10 text-center text-text-faint">
                      No entries yet
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  })() : null;

  const createView = creatingNew ? (
    <div className="flex min-h-0 flex-1 justify-center overflow-y-auto px-4 py-6 sm:px-8">
      <div className="w-full max-w-4xl rounded-3xl border border-border bg-bg-primary shadow-sm">
        <div className="border-b border-border px-5 py-5">
          <div className="flex items-center gap-3">
            <div className="rounded-2xl bg-accent/10 p-3 text-accent">
              <Plus size={18} />
            </div>
            <div>
              <h2 className="text-xl font-semibold text-text-primary">Create new page</h2>
              <p className="mt-1 text-sm text-text-muted">Start a new markdown page in the docs tree.</p>
            </div>
          </div>
        </div>
        <div className="space-y-4 px-5 py-5">
          <div>
            <label htmlFor={newPagePathInputId} className="mb-1 block text-xs font-medium uppercase tracking-wide text-text-faint">
              Page path
            </label>
            <input
              id={newPagePathInputId}
              type="text"
              value={newPagePath}
              onChange={(e) => setNewPagePath(e.target.value)}
              placeholder="guides/getting-started.md"
              className="w-full rounded-2xl border border-border bg-bg-secondary px-4 py-3 text-sm text-text-primary placeholder:text-text-faint focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </div>
          <div>
            <label htmlFor={newPageContentInputId} className="mb-1 block text-xs font-medium uppercase tracking-wide text-text-faint">
              Content
            </label>
            <textarea
              id={newPageContentInputId}
              value={newPageContent}
              onChange={(e) => setNewPageContent(e.target.value)}
              className="min-h-[380px] w-full rounded-2xl border border-border bg-bg-secondary px-4 py-3 font-mono text-sm text-text-primary placeholder:text-text-faint focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={handleCreateNew}
              disabled={!newPagePath.trim()}
              className="inline-flex items-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Save size={14} />
              Create
            </button>
            <button
              onClick={() => setCreatingNew(false)}
              className="rounded-xl border border-border px-4 py-2.5 text-sm text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  ) : null;

  const editView = editing && page ? (
    <div className="flex min-h-0 flex-1 justify-center overflow-y-auto px-4 py-6 sm:px-8">
      <div className="w-full max-w-5xl rounded-3xl border border-border bg-bg-primary shadow-sm">
        <div className="border-b border-border px-5 py-5">
          <div className="flex items-center gap-3">
            <div className="rounded-2xl bg-accent/10 p-3 text-accent">
              <Pencil size={18} />
            </div>
            <div className="min-w-0">
              <h2 className="truncate text-xl font-semibold text-text-primary">Editing {page.title}</h2>
              <p className="mt-1 text-sm text-text-muted">Update the page source directly in markdown.</p>
            </div>
          </div>
        </div>
        <div className="space-y-4 px-5 py-5">
          <label htmlFor={editorContentInputId} className="block text-xs font-medium uppercase tracking-wide text-text-faint">
            Markdown content
          </label>
          <textarea
            id={editorContentInputId}
            value={editorContent}
            onChange={(e) => setEditorContent(e.target.value)}
            className="min-h-[480px] w-full rounded-2xl border border-border bg-bg-secondary px-4 py-3 font-mono text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
          />
          <div className="flex flex-wrap gap-2">
            <button
              onClick={handleSave}
              className="inline-flex items-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-accent-hover"
            >
              <Save size={14} />
              Save
            </button>
            <button
              onClick={() => setEditing(false)}
              className="rounded-xl border border-border px-4 py-2.5 text-sm text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  ) : null;

  const emptyView = !creatingNew && !editing && !page && !dbFolder && !pageLoading ? (
    <div className="flex flex-1 items-center justify-center px-6">
      <div className="max-w-lg text-center">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-3xl bg-accent/10 text-accent">
          <BookOpen size={28} />
        </div>
        <h2 className="mt-5 text-2xl font-semibold tracking-tight text-text-primary">A calmer docs workspace</h2>
        <p className="mt-3 text-sm leading-6 text-text-muted">
          Browse the tree, search for a page, or start a new note. On mobile, open the navigator to move through docs without losing your place.
        </p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => setNavigatorOpen(true)}
            className="rounded-xl border border-border px-4 py-2.5 text-sm text-text-primary transition-colors hover:bg-bg-hover md:hidden"
          >
            Open navigator
          </button>
          <button
            onClick={openCreatePage}
            className="rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-accent-hover"
          >
            New page
          </button>
        </div>
      </div>
    </div>
  ) : null;

  const mainContent = pageLoading ? (
    <div className="flex flex-1 items-center justify-center text-sm text-text-faint">Loading...</div>
  ) : (
    createView || editView || pageContent || dbCollectionView || emptyView
  );

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-bg-primary">
      <div className="flex items-center gap-3 border-b border-border bg-bg-secondary px-4 py-3 md:hidden">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-text-primary">
            {page ? page.title : dbSchema ? dbSchema.name : creatingNew ? "New page" : editing ? "Edit page" : "Docs"}
          </div>
          <div className="truncate text-[11px] text-text-faint">
            {page ? page.path : dbFolder ?? "Knowledge base"}
          </div>
        </div>
        {!page && (
          <button
            onClick={() => setNavigatorOpen(true)}
            className="rounded-full p-2 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
            aria-label="Open navigator"
          >
            <BookOpen size={16} />
          </button>
        )}
      </div>

      <div className="flex min-h-0 flex-1">
        {!isMobile && (
          <aside className="w-[300px] shrink-0 border-r border-border">
            {sidebar}
          </aside>
        )}
        <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-bg-primary">{mainContent}</main>
      </div>

      {isMobile && navigatorOpen && (
        <DocsSheet title="Browse docs" onClose={() => setNavigatorOpen(false)}>
          {sidebar}
        </DocsSheet>
      )}

      {!showDesktopInspector && inspectorOpen && page && (
        <DocsSheet title="Contents and details" onClose={() => setInspectorOpen(false)}>
          <div className="space-y-4">
            {tocCard}
            {pageMetaCard}
            {relatedDocsCard}
          </div>
        </DocsSheet>
      )}
    </div>
  );
}
