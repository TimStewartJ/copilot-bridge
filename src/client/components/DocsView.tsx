import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { setLastViewedDoc } from "../last-viewed";
import { useAppBack } from "../hooks/useAppBack";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
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
import {
  FileText,
  Folder,
  FolderOpen,
  Search,
  Plus,
  Pencil,
  Trash2,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  Database,
  BookOpen,
  X,
  Save,
  ArrowLeft,
  Check,
  ExternalLink,
} from "lucide-react";

// ── Persisted folder expansion state ─────────────────────────────
const EXPANDED_KEY = "bridge-docs-expanded";

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

// ── Persisted DB sort state ─────────────────────────────────────
const DB_SORT_KEY = "bridge-docs-db-sort";
type DbSortState = { field: string; order: "asc" | "desc" };
const DEFAULT_DB_SORT: DbSortState = { field: "modified", order: "desc" };

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
  } catch { /* ignore */ }
}

// ── Tree node component ─────────────────────────────────────────

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
          className={`w-full flex items-center gap-1 px-2 py-1 text-xs rounded transition-colors ${
            isSelected
              ? "bg-bg-hover text-text-primary"
              : "text-text-muted hover:bg-bg-hover hover:text-text-primary"
          }`}
          style={{ paddingLeft: `${depth * 16 + 4}px` }}
        >
          <button
            onClick={(e) => { e.stopPropagation(); toggleExpand(); }}
            className="shrink-0 p-0.5 rounded hover:bg-bg-primary transition-colors cursor-pointer"
          >
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
          <button
            onClick={() => {
              if (node.isDb) onSelect(node.path, true);
              else if (node.hasIndex) { onToggleExpanded(node.path, true); onSelect(node.path); }
              else toggleExpand();
            }}
            className="flex items-center gap-1.5 min-w-0 flex-1 cursor-pointer"
          >
            {node.isDb ? (
              <Database size={13} className="shrink-0" />
            ) : expanded ? (
              <FolderOpen size={13} className="shrink-0" />
            ) : (
              <Folder size={13} className="shrink-0" />
            )}
            <span className="truncate">{node.name}</span>
          </button>
        </div>
        {expanded && node.children && (
          <div>
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
      className={`w-full flex items-center gap-1.5 px-2 py-1 text-xs rounded transition-colors cursor-pointer ${
        isSelected
          ? "bg-bg-hover text-text-primary"
          : "text-text-muted hover:bg-bg-hover hover:text-text-primary"
      }`}
      style={{ paddingLeft: `${depth * 16 + 22}px` }}
    >
      <FileText size={13} className="shrink-0" />
      <span className="truncate">{node.name}</span>
    </button>
  );
}

// ── Snippet sanitizer ────────────────────────────────────────────
// Only allow <mark> and </mark> tags from FTS5 snippets — strip everything else
function sanitizeSnippet(html: string): string {
  return html
    .replace(/<(?!\/?mark\b)[^>]*>/gi, "")
    .replace(/&(?!amp;|lt;|gt;|quot;|#\d+;)/g, "&amp;");
}

/** Resolve a relative link path against a docs page path */
function resolveRelativePath(currentPath: string, href: string): string {
  // Separate fragment from path
  const hashIdx = href.indexOf("#");
  const rawPath = hashIdx >= 0 ? href.slice(0, hashIdx) : href;
  const clean = rawPath.replace(/\.md$/, "");
  if (!clean) return currentPath; // pure fragment link like "#section"
  if (clean.startsWith("/")) return clean.slice(1);
  // Current path might be a folder index (e.g. "guides" for guides/index.md)
  // or a file (e.g. "guides/page"). We keep all segments as the "directory"
  // if the page is a folder index (no slash or ends at a folder level).
  const parts = currentPath.includes("/")
    ? currentPath.split("/").slice(0, -1) // file: drop last segment
    : [currentPath]; // folder index: keep as directory
  for (const seg of clean.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== ".") parts.push(seg);
  }
  return parts.filter(Boolean).join("/");
}

/** Allow wiki: URLs through react-markdown's URL sanitizer */
function wikiUrlTransform(url: string): string {
  if (url.startsWith("wiki:")) return url;
  return defaultUrlTransform(url);
}

// ── DB collection helpers ───────────────────────────────────────

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

function DbCell({ field, value }: { field: { name: string; type: string; options?: string[] }; value: unknown }) {
  if (value == null || value === "") return <span className="text-text-faint">—</span>;

  switch (field.type) {
    case "select": {
      const s = String(value);
      const c = getBadgeColor(s, field.options);
      return (
        <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${c.bg} ${c.text}`}>
          {s}
        </span>
      );
    }
    case "boolean":
      return value === true || value === "true"
        ? <Check size={13} className="text-emerald-400" />
        : <X size={13} className="text-text-faint" />;
    case "date":
      try {
        return <span className="whitespace-nowrap">{new Date(String(value)).toLocaleDateString()}</span>;
      } catch {
        return <span>{String(value)}</span>;
      }
    case "number":
      return <span className="tabular-nums">{String(value)}</span>;
    case "url":
      return (
        <a
          href={String(value)}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="inline-flex items-center gap-1 text-accent hover:underline max-w-[200px] truncate"
        >
          {String(value).replace(/^https?:\/\/(www\.)?/, "").slice(0, 40)}
          <ExternalLink size={10} className="shrink-0" />
        </a>
      );
    default:
      return <span>{String(value)}</span>;
  }
}

// ── Main DocsView ───────────────────────────────────────────────

export default function DocsView() {
  const navigate = useNavigate();
  const location = useLocation();
  const { goBack: appGoBack } = useAppBack();

  // Derive selectedPath and isDb from URL
  const urlDocPath = location.pathname.replace(/^\/docs\/?/, "") || null;
  const isDbFromUrl = new URLSearchParams(location.search).has("db");
  const selectedPath = urlDocPath;

  // Tree state
  const [tree, setTree] = useState<DocTreeNode[]>([]);
  const [treeLoading, setTreeLoading] = useState(true);
  const [hasRootIndex, setHasRootIndex] = useState(false);

  // Page state
  const [page, setPage] = useState<DocPage | null>(null);
  const [pageLoading, setPageLoading] = useState(false);
  const [dbItemSchema, setDbItemSchema] = useState<DbSchema | null>(null);

  // Editor state
  const [editing, setEditing] = useState(false);
  const [editorContent, setEditorContent] = useState("");

  // New page state
  const [creatingNew, setCreatingNew] = useState(false);
  const [newPagePath, setNewPagePath] = useState("");
  const [newPageContent, setNewPageContent] = useState("");

  // Search state
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<DocSearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Mobile sidebar toggle
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // DB view state
  const [dbSchema, setDbSchema] = useState<DbSchema | null>(null);
  const [dbEntries, setDbEntries] = useState<DbEntry[]>([]);
  const [dbTotal, setDbTotal] = useState<number | null>(null);
  const [dbFolder, setDbFolder] = useState<string | null>(null);
  const [dbSort, setDbSort] = useState<DbSortState>(DEFAULT_DB_SORT);

  // Restore persisted sort when switching to a DB collection
  useEffect(() => {
    if (dbFolder) setDbSort(getDbSort(dbFolder));
  }, [dbFolder]);

  // Folder expansion state (persisted to localStorage)
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => getExpandedFolders());

  // Wikilink resolution cache: target → resolved path (null = broken link)
  const [resolvedLinks, setResolvedLinks] = useState<Record<string, { path: string; title: string } | null>>({});

  const handleToggleExpanded = useCallback((path: string, expanded: boolean) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (expanded) next.add(path);
      else next.delete(path);
      saveExpandedFolders(next);
      return next;
    });
  }, []);

  // Load tree on mount
  useEffect(() => {
    loadTree();
  }, []);

  // Auto-redirect to root index when tree loads and no doc selected
  useEffect(() => {
    if (!treeLoading && hasRootIndex && !selectedPath) {
      navigate("/docs/index", { replace: true });
    }
  }, [treeLoading, hasRootIndex, selectedPath, navigate]);

  // Load page/DB when URL-derived selectedPath changes
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
    setSidebarOpen(false);
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
      fetchDocPage(selectedPath)
        .then((p) => {
          if (cancelled) return;
          setPage(p);
        })
        .catch(() => {
          if (cancelled) return;
          setPage(null);
        })
        .finally(() => {
          if (!cancelled) setPageLoading(false);
        });
    }

    setLastViewedDoc(isDbFromUrl ? selectedPath + "?db" : selectedPath);

    return () => { cancelled = true; };
  }, [selectedPath, isDbFromUrl]);

  // Client-side sorting of DB entries
  const sortedDbEntries = useMemo(() => {
    if (!dbEntries.length || !dbSort) return dbEntries;
    const { field, order } = dbSort;
    return [...dbEntries].sort((a, b) => {
      let va: unknown, vb: unknown;
      if (field === "title") {
        va = a.title; vb = b.title;
      } else if (field === "modified") {
        va = a.modified; vb = b.modified;
      } else if (field === "created") {
        va = a.created; vb = b.created;
      } else {
        va = a.fields[field]; vb = b.fields[field];
      }
      // Nulls last
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      // Type-aware comparison
      if (typeof va === "number" && typeof vb === "number") {
        return order === "asc" ? va - vb : vb - va;
      }
      if (typeof va === "boolean" && typeof vb === "boolean") {
        return order === "asc" ? Number(va) - Number(vb) : Number(vb) - Number(va);
      }
      const sa = String(va), sb = String(vb);
      // Try date comparison for date-like strings
      if (field === "modified" || field === "created") {
        const da = new Date(sa).getTime(), db = new Date(sb).getTime();
        if (!isNaN(da) && !isNaN(db)) return order === "asc" ? da - db : db - da;
      }
      // Try numeric comparison for number-ish strings
      const na = Number(sa), nb = Number(sb);
      if (!isNaN(na) && !isNaN(nb) && sa !== "" && sb !== "") {
        return order === "asc" ? na - nb : nb - na;
      }
      const cmp = sa.localeCompare(sb, undefined, { sensitivity: "base" });
      return order === "asc" ? cmp : -cmp;
    });
  }, [dbEntries, dbSort]);

  const loadTree = useCallback(async () => {
    setTreeLoading(true);
    try {
      const data = await fetchDocsTree();
      setTree(data.tree);
      setHasRootIndex(data.hasRootIndex);
      // Auto-expand top-level folders on first visit (nothing persisted yet)
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

  // Search with debounce
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
    }, 300);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [searchQuery]);

  // Navigate to a page or DB folder via URL
  const handleSelectNode = useCallback(
    (path: string, isDb?: boolean) => {
      const url = isDb ? `/docs/${path}?db` : `/docs/${path}`;
      navigate(url);
    },
    [navigate],
  );

  // Save edits
  const handleSave = useCallback(async () => {
    if (!selectedPath) return;
    try {
      await writeDocPage(selectedPath, editorContent);
      const p = await fetchDocPage(selectedPath);
      setPage(p);
      setEditing(false);
    } catch (err) {
      console.error("Save failed:", err);
    }
  }, [selectedPath, editorContent]);

  // Delete page
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

  // Create new page
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

  // Start editing
  const startEdit = useCallback(() => {
    if (!page) return;
    // Reconstruct raw content with frontmatter
    const frontmatter = Object.keys(page.frontmatter).length
      ? `---\n${Object.entries(page.frontmatter)
          .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
          .join("\n")}\n---\n\n`
      : "";
    setEditorContent(frontmatter + page.body);
    setEditing(true);
  }, [page]);

  // Navigate to root index
  const handleGoHome = useCallback(() => {
    if (hasRootIndex) {
      navigate("/docs/index");
    } else {
      setPage(null);
      setEditing(false);
      setCreatingNew(false);
      setDbFolder(null);
      setDbSchema(null);
      navigate("/docs");
    }
  }, [hasRootIndex, navigate]);

  // Batch-resolve wikilinks when page body changes
  useEffect(() => {
    if (!page?.body) return;
    const re = /\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]/g;
    const targets = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = re.exec(page.body)) !== null) targets.add(m[1].trim());
    if (targets.size === 0) { setResolvedLinks({}); return; }

    let cancelled = false;
    resolveWikilinks([...targets]).then((result) => {
      if (!cancelled) setResolvedLinks(result);
    }).catch(() => {
      if (!cancelled) setResolvedLinks({});
    });
    return () => { cancelled = true; };
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

  // Custom markdown rendering with wikilink support
  const remarkPlugins = useMemo(() => [remarkGfm, remarkBreaks, remarkWikilink], []);
  const markdownComponents = useMemo(() => ({
    pre: CodeBlock,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    a: ({ href, children, node: _node, ...props }: any) => {
      // Wikilinks use the wiki: scheme
      if (href?.startsWith("wiki:")) {
        const target = href.slice(5);
        const resolved = resolvedLinks[target];
        const isBroken = resolvedLinks[target] === null && target in resolvedLinks;
        return (
          <a
            {...props}
            href="#"
            onClick={(e: React.MouseEvent) => {
              e.preventDefault();
              if (resolved) navigate(`/docs/${resolved.path}`);
            }}
            className={isBroken ? "text-red-400 cursor-not-allowed opacity-70" : undefined}
            title={isBroken ? `Page not found: ${target}` : resolved?.title || target}
          >
            {children}
          </a>
        );
      }

      // External links and other schemes (mailto:, tel:, etc.) — pass through
      if (href && /^[a-z][a-z0-9+.-]*:/i.test(href)) {
        return <a {...props} href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
      }

      // Fragment-only links — pass through for in-page navigation
      if (!href || href.startsWith("#")) {
        return <a {...props} href={href}>{children}</a>;
      }

      // Relative markdown links — resolve against current page path and navigate
      if (selectedPath) {
        const resolvedPath = resolveRelativePath(selectedPath, href);
        return (
          <a
            {...props}
            href="#"
            onClick={(e: React.MouseEvent) => {
              e.preventDefault();
              navigate(`/docs/${resolvedPath}`);
            }}
          >
            {children}
          </a>
        );
      }

      return <a {...props} href={href}>{children}</a>;
    },
  }), [resolvedLinks, selectedPath, navigate]);

  // ── Sidebar ─────────────────────────────────────────────────────

  const sidebar = (
    <div className="flex flex-col h-full">
      {/* Header */}
      <button
        onClick={handleGoHome}
        className="hidden md:flex items-center gap-2 px-3 py-2 border-b border-border text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
      >
        <BookOpen size={14} className="shrink-0" />
        <span className="text-xs font-semibold">Docs</span>
      </button>

      {/* Search bar */}
      <div className="p-2 border-b border-border">
        <div className="relative">
          <Search
            size={14}
            className="absolute left-2 top-1/2 -translate-y-1/2 text-text-faint pointer-events-none"
          />
          <input
            type="text"
            placeholder="Search docs…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-7 pr-7 py-1.5 text-xs rounded-md bg-bg-primary border border-border text-text-primary placeholder-text-faint focus:outline-none focus:ring-1 focus:ring-accent"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-text-faint hover:text-text-primary"
            >
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      {/* Tree or search results */}
      <div className="flex-1 overflow-y-auto py-1">
        {searchResults !== null ? (
          // Search results
          searching ? (
            <div className="px-3 py-4 text-center text-text-faint text-xs">
              Searching…
            </div>
          ) : searchResults.length === 0 ? (
            <div className="px-3 py-4 text-center text-text-faint text-xs">
              No results
            </div>
          ) : (
            <div className="space-y-0.5 px-1">
              {searchResults.map((r) => (
                <button
                  key={r.path}
                  onClick={() => {
                    setSearchQuery("");
                    setSearchResults(null);
                    handleSelectNode(r.path);
                  }}
                  className={`w-full text-left px-2 py-1.5 rounded text-xs transition-colors hover:bg-bg-hover ${
                    r.path === selectedPath ? "bg-bg-hover text-text-primary" : "text-text-muted"
                  }`}
                >
                  <div className="font-medium text-text-primary truncate">
                    {r.title}
                  </div>
                  <div className="text-text-faint truncate text-[10px]">{r.path}</div>
                  {r.snippet && (
                    <div
                      className="text-text-faint text-[10px] mt-0.5 line-clamp-2"
                      dangerouslySetInnerHTML={{ __html: sanitizeSnippet(r.snippet) }}
                    />
                  )}
                </button>
              ))}
            </div>
          )
        ) : treeLoading ? (
          <div className="px-3 py-4 text-center text-text-faint text-xs">
            Loading…
          </div>
        ) : tree.length === 0 ? (
          <div className="px-3 py-4 text-center text-text-faint text-xs">
            No docs yet
          </div>
        ) : (
          tree.map((node) => (
            <TreeNode
              key={node.path}
              node={node}
              depth={0}
              selectedPath={selectedPath}
              onSelect={handleSelectNode}
              expandedFolders={expandedFolders}
              onToggleExpanded={handleToggleExpanded}
            />
          ))
        )}
      </div>

      {/* New Page button */}
      <div className="p-2 border-t border-border">
        <button
          onClick={() => {
            setCreatingNew(true);
            setEditing(false);
            setPage(null);
            setSidebarOpen(false);
            navigate("/docs");
          }}
          className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs rounded-md bg-bg-hover text-text-primary hover:bg-bg-primary transition-colors"
        >
          <Plus size={12} />
          New Page
        </button>
      </div>
    </div>
  );

  // ── Main content area ───────────────────────────────────────────

  const mainContent = (() => {
    // New page creation
    if (creatingNew) {
      return (
        <div className="flex-1 flex flex-col p-4 overflow-y-auto">
          <div className="flex items-center gap-2 mb-4">
            <button
              onClick={() => setCreatingNew(false)}
              className="text-text-muted hover:text-text-primary transition-colors"
            >
              <ArrowLeft size={16} />
            </button>
            <h2 className="text-sm font-semibold text-text-primary">Create New Page</h2>
          </div>
          <label className="text-xs text-text-muted mb-1">
            Page path (e.g. guides/getting-started.md)
          </label>
          <input
            type="text"
            value={newPagePath}
            onChange={(e) => setNewPagePath(e.target.value)}
            placeholder="folder/page-name.md"
            className="w-full px-3 py-2 text-sm rounded-md bg-bg-primary border border-border text-text-primary placeholder-text-faint focus:outline-none focus:ring-1 focus:ring-accent mb-3"
          />
          <label className="text-xs text-text-muted mb-1">Content (markdown)</label>
          <textarea
            value={newPageContent}
            onChange={(e) => setNewPageContent(e.target.value)}
            placeholder={"---\ntitle: My Page\ntags: [guide]\n---\n\n# Hello\n\nYour content here."}
            className="flex-1 min-h-[200px] w-full px-3 py-2 text-sm rounded-md bg-bg-primary border border-border text-text-primary placeholder-text-faint font-mono focus:outline-none focus:ring-1 focus:ring-accent resize-none"
          />
          <div className="flex gap-2 mt-3">
            <button
              onClick={handleCreateNew}
              disabled={!newPagePath.trim()}
              className="flex items-center gap-1.5 px-4 py-2 text-xs rounded-md bg-accent text-white hover:bg-accent-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Save size={12} />
              Create
            </button>
            <button
              onClick={() => setCreatingNew(false)}
              className="px-4 py-2 text-xs rounded-md bg-bg-hover text-text-muted hover:text-text-primary transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      );
    }

    // Page loading
    if (pageLoading) {
      return (
        <div className="flex-1 flex items-center justify-center text-text-faint text-sm">
          Loading…
        </div>
      );
    }

    // Editing
    if (editing && page) {
      return (
        <div className="flex-1 flex flex-col p-4 overflow-y-auto">
          <div className="flex items-center gap-2 mb-4">
            <button
              onClick={() => setEditing(false)}
              className="text-text-muted hover:text-text-primary transition-colors"
            >
              <ArrowLeft size={16} />
            </button>
            <h2 className="text-sm font-semibold text-text-primary truncate">
              Editing: {page.title}
            </h2>
          </div>
          <textarea
            value={editorContent}
            onChange={(e) => setEditorContent(e.target.value)}
            className="flex-1 min-h-[300px] w-full px-3 py-2 text-sm rounded-md bg-bg-primary border border-border text-text-primary font-mono focus:outline-none focus:ring-1 focus:ring-accent resize-none"
          />
          <div className="flex gap-2 mt-3">
            <button
              onClick={handleSave}
              className="flex items-center gap-1.5 px-4 py-2 text-xs rounded-md bg-accent text-white hover:bg-accent-hover transition-colors"
            >
              <Save size={12} />
              Save
            </button>
            <button
              onClick={() => setEditing(false)}
              className="px-4 py-2 text-xs rounded-md bg-bg-hover text-text-muted hover:text-text-primary transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      );
    }

    // Page view
    if (page) {
      const dbPropertyFields = dbItemSchema?.fields.filter((field) => field.name !== "title") ?? [];

      return (
        <div className="flex-1 flex flex-col overflow-y-auto">
          {/* Header */}
          <div className="shrink-0 flex items-start justify-between gap-3 px-4 py-3 border-b border-border bg-bg-secondary">
            <div className="min-w-0">
              <h1 className="text-base font-semibold text-text-primary truncate">
                {page.title}
              </h1>
              <div className="flex flex-wrap items-center gap-1.5 mt-1">
                {page.tags.map((tag) => {
                  const bg = TAG_COLOR_BG[tag] ?? "bg-bg-hover";
                  const text = TAG_COLOR_TEXT[tag] ?? "text-text-muted";
                  return (
                    <span
                      key={tag}
                      className={`px-1.5 py-0.5 text-[10px] rounded ${bg} ${text}`}
                    >
                      {tag}
                    </span>
                  );
                })}
              </div>
              <div className="text-[10px] text-text-faint mt-1">
                Created {new Date(page.created).toLocaleDateString()} · Modified{" "}
                {new Date(page.modified).toLocaleDateString()}
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button
                onClick={startEdit}
                title="Edit"
                className="p-1.5 rounded text-text-muted hover:bg-bg-hover hover:text-text-primary transition-colors"
              >
                <Pencil size={14} />
              </button>
              <button
                onClick={handleDelete}
                title="Delete"
                className="p-1.5 rounded text-text-muted hover:bg-bg-hover hover:text-red-400 transition-colors"
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>
          {dbPropertyFields.length > 0 && (
            <div className="shrink-0 px-4 py-3 border-b border-border bg-bg-primary">
              <div className="text-[11px] font-medium uppercase tracking-wide text-text-faint mb-2">
                Properties
              </div>
              <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-[minmax(0,160px)_minmax(0,1fr)]">
                {dbPropertyFields.map((field) => (
                  <div
                    key={field.name}
                    className="grid gap-1 sm:contents"
                  >
                    <dt className="text-xs text-text-muted">{field.name}</dt>
                    <dd className="text-xs text-text-primary min-w-0">
                      <DbCell field={field} value={page.frontmatter[field.name]} />
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
          {/* Body */}
          <div className="flex-1 px-4 py-4 prose prose-invert prose-sm max-w-none text-text-primary prose-headings:text-text-primary prose-a:text-accent prose-code:text-text-primary prose-strong:text-text-primary prose-pre:bg-bg-secondary prose-pre:border prose-pre:border-border">
            <ReactMarkdown remarkPlugins={remarkPlugins} components={markdownComponents} urlTransform={wikiUrlTransform}>
              {page.body}
            </ReactMarkdown>
          </div>
        </div>
      );
    }

    // DB collection view
    if (dbFolder && dbSchema) {
      const handleSort = (field: string) => {
        setDbSort((prev) => {
          const next = prev.field === field
            ? { field, order: prev.order === "asc" ? "desc" as const : "asc" as const }
            : { field, order: "desc" as const };
          saveDbSort(dbFolder, next);
          return next;
        });
      };

      const SortIcon = ({ field }: { field: string }) => {
        if (dbSort.field !== field) return null;
        return dbSort.order === "asc"
          ? <ChevronUp size={12} className="inline ml-0.5" />
          : <ChevronDown size={12} className="inline ml-0.5" />;
      };

      const thClass = "text-left px-3 py-2 font-medium cursor-pointer select-none hover:text-text-primary transition-colors";
      const visibleFields = dbSchema.fields.filter((f) => f.name !== "title");

      return (
        <div className="flex-1 flex flex-col overflow-y-auto">
          <div className="shrink-0 flex items-center gap-3 px-4 py-3 border-b border-border bg-bg-secondary">
            <Database size={16} className="text-accent shrink-0" />
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-text-primary truncate">{dbSchema.name}</h2>
              <div className="text-[10px] text-text-faint">{dbTotal ?? dbEntries.length} entries · {dbSchema.fields.length} fields</div>
            </div>
          </div>
          <div className="flex-1 overflow-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 z-10">
                <tr className="border-b border-border bg-bg-secondary text-text-muted">
                  <th className={thClass} onClick={() => handleSort("title")}>
                    Title<SortIcon field="title" />
                  </th>
                  {visibleFields.map((f) => (
                    <th key={f.name} className={`${thClass} ${f.type === "number" ? "text-right" : ""}`} onClick={() => handleSort(f.name)}>
                      {f.name}<SortIcon field={f.name} />
                    </th>
                  ))}
                  <th className={thClass} onClick={() => handleSort("modified")}>
                    Modified<SortIcon field="modified" />
                  </th>
                </tr>
              </thead>
              <tbody>
                {sortedDbEntries.map((entry) => (
                  <tr
                    key={entry.path}
                    onClick={() => handleSelectNode(entry.path)}
                    className="border-b border-border hover:bg-bg-hover cursor-pointer transition-colors"
                  >
                    <td className="px-3 py-2 text-text-primary font-medium">{entry.title}</td>
                    {visibleFields.map((f) => (
                      <td key={f.name} className={`px-3 py-2 text-text-muted ${f.type === "number" ? "text-right" : ""}`}>
                        <DbCell field={f} value={entry.fields[f.name]} />
                      </td>
                    ))}
                    <td className="px-3 py-2 text-text-faint whitespace-nowrap">
                      {entry.modified ? new Date(entry.modified).toLocaleDateString() : "—"}
                    </td>
                  </tr>
                ))}
                {sortedDbEntries.length === 0 && (
                  <tr>
                    <td colSpan={visibleFields.length + 2} className="px-3 py-8 text-center text-text-faint">
                      No entries yet
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      );
    }

    // Empty state
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 text-text-faint">
        <BookOpen size={32} />
        <div className="text-sm">Select a page or create one</div>
      </div>
    );
  })();

  // ── Layout ──────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Mobile header */}
      <div className="shrink-0 flex items-center gap-3 px-4 py-2.5 border-b border-border bg-bg-secondary md:hidden">
        {(page || dbFolder || creatingNew) ? (
          <button
            onClick={() => {
              setPage(null);
              setDbFolder(null);
              setDbSchema(null);
              setCreatingNew(false);
              setEditing(false);
              navigate("/docs");
            }}
            className="text-text-muted hover:text-text-primary transition-colors"
            aria-label="Back to tree"
          >
            <ArrowLeft size={16} />
          </button>
        ) : (
          <button
            onClick={appGoBack}
            className="text-text-muted hover:text-text-primary transition-colors"
            aria-label="Back to home"
          >
            <ArrowLeft size={16} />
          </button>
        )}
        <span className="text-sm font-semibold text-text-primary truncate">
          {page ? page.title : dbSchema ? dbSchema.name : creatingNew ? "New Page" : "Docs"}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {!(page || dbFolder || creatingNew) && (
            <>
              <button
                onClick={() => {
                  setCreatingNew(true);
                  setPage(null);
                  setEditing(false);
                  setNewPagePath("");
                  setNewPageContent("---\ntitle: \ntags: []\n---\n\n");
                  navigate("/docs");
                }}
                className="text-text-muted hover:text-text-primary transition-colors"
                title="New Page"
              >
                <Plus size={16} />
              </button>
              <button
                onClick={() => setSidebarOpen((v) => !v)}
                className="text-text-muted hover:text-text-primary transition-colors"
              >
                <Search size={16} />
              </button>
            </>
          )}
        </div>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* Sidebar — always visible on desktop; on mobile show only when no page selected */}
        <div
          className={`
            ${sidebarOpen ? "flex" : (page || dbFolder || creatingNew) ? "hidden" : "flex"} md:flex
            flex-col w-full md:w-[250px] shrink-0 bg-bg-secondary border-r border-border
            ${sidebarOpen ? "absolute inset-0 z-10" : ""} md:relative md:inset-auto md:z-auto
          `}
        >
          {/* Mobile close */}
          <div className="flex items-center justify-between px-3 py-2 border-b border-border md:hidden">
            <span className="text-xs font-medium text-text-primary">File Tree</span>
            <button
              onClick={() => setSidebarOpen(false)}
              className="text-text-muted hover:text-text-primary"
            >
              <X size={14} />
            </button>
          </div>
          {sidebar}
        </div>

        {/* Main content — hidden on mobile when showing tree */}
        <div className={`flex-1 flex flex-col min-w-0 min-h-0 ${!(page || dbFolder || creatingNew) ? "hidden md:flex" : ""}`}>
          {mainContent}
        </div>
      </div>
    </div>
  );
}
