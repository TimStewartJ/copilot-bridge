import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import CodeBlock from "./CodeBlock";
import {
  fetchDocsTree,
  fetchDocPage,
  writeDocPage,
  deleteDocPage,
  searchDocs,
  fetchDbSchema,
  fetchDbEntries,
  type DocTreeNode,
  type DocPage,
  type DocSearchResult,
  type DbSchema,
  type DbEntry,
} from "../api";
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
  Database,
  BookOpen,
  X,
  Save,
  ArrowLeft,
} from "lucide-react";

// ── Tree node component ─────────────────────────────────────────

function TreeNode({
  node,
  depth,
  selectedPath,
  onSelect,
}: {
  node: DocTreeNode;
  depth: number;
  selectedPath: string | null;
  onSelect: (path: string, isDb?: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(depth < 1);
  const isFolder = node.type === "folder";
  const isSelected = node.path === selectedPath;

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
            onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}
            className="shrink-0 p-0.5 rounded hover:bg-bg-primary transition-colors cursor-pointer"
          >
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
          <button
            onClick={() => {
              if (node.isDb) onSelect(node.path, true);
              else if (node.hasIndex) { setExpanded(true); onSelect(node.path); }
              else setExpanded((v) => !v);
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

// ── Main DocsView ───────────────────────────────────────────────

export default function DocsView() {
  const navigate = useNavigate();

  // Tree state
  const [tree, setTree] = useState<DocTreeNode[]>([]);
  const [treeLoading, setTreeLoading] = useState(true);
  const [hasRootIndex, setHasRootIndex] = useState(false);

  // Page state
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [page, setPage] = useState<DocPage | null>(null);
  const [pageLoading, setPageLoading] = useState(false);

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
  const [dbFolder, setDbFolder] = useState<string | null>(null);

  // Load tree on mount
  useEffect(() => {
    loadTree();
  }, []);

  // Auto-load root index page when tree loads
  useEffect(() => {
    if (!treeLoading && hasRootIndex && !selectedPath) {
      handleSelectNode("index");
    }
  }, [treeLoading, hasRootIndex]);

  const loadTree = useCallback(async () => {
    setTreeLoading(true);
    try {
      const data = await fetchDocsTree();
      setTree(data.tree);
      setHasRootIndex(data.hasRootIndex);
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

  // Load a page or DB folder
  const handleSelectNode = useCallback(
    async (path: string, isDb?: boolean) => {
      setSelectedPath(path);
      setEditing(false);
      setCreatingNew(false);
      setPageLoading(true);
      setSidebarOpen(false);

      if (isDb) {
        // Load DB schema + entries
        setPage(null);
        setDbFolder(path);
        try {
          const [schema, data] = await Promise.all([
            fetchDbSchema(path),
            fetchDbEntries(path),
          ]);
          setDbSchema(schema);
          setDbEntries(data.entries);
        } catch {
          setDbSchema(null);
          setDbEntries([]);
        } finally {
          setPageLoading(false);
        }
        return;
      }

      setDbFolder(null);
      setDbSchema(null);
      try {
        const p = await fetchDocPage(path);
        setPage(p);
      } catch {
        setPage(null);
      } finally {
        setPageLoading(false);
      }
    },
    [],
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
      setSelectedPath(null);
      loadTree();
    } catch (err) {
      console.error("Delete failed:", err);
    }
  }, [selectedPath, loadTree]);

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
      handleSelectNode("index");
    } else {
      setSelectedPath(null);
      setPage(null);
      setEditing(false);
      setCreatingNew(false);
      setDbFolder(null);
      setDbSchema(null);
    }
  }, [hasRootIndex, handleSelectNode]);

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
            setSelectedPath(null);
            setPage(null);
            setSidebarOpen(false);
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
      return (
        <div className="flex-1 flex flex-col overflow-y-auto">
          {/* Header */}
          <div className="shrink-0 flex items-start justify-between gap-3 px-4 py-3 border-b border-border bg-bg-secondary">
            <div className="min-w-0">
              <h1 className="text-base font-semibold text-text-primary truncate">
                {page.title}
              </h1>
              <div className="flex flex-wrap items-center gap-1.5 mt-1">
                {page.tags.map((tag) => (
                  <span
                    key={tag}
                    className="px-1.5 py-0.5 text-[10px] rounded bg-bg-hover text-text-muted"
                  >
                    {tag}
                  </span>
                ))}
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
          {/* Body */}
          <div className="flex-1 px-4 py-4 prose prose-sm max-w-none text-text-primary prose-headings:text-text-primary prose-a:text-accent prose-code:text-text-primary prose-pre:bg-bg-secondary prose-pre:border prose-pre:border-border">
            <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={{ pre: CodeBlock }}>
              {page.body}
            </ReactMarkdown>
          </div>
        </div>
      );
    }

    // DB collection view
    if (dbFolder && dbSchema) {
      return (
        <div className="flex-1 flex flex-col overflow-y-auto">
          <div className="shrink-0 flex items-center gap-3 px-4 py-3 border-b border-border bg-bg-secondary">
            <Database size={16} className="text-accent shrink-0" />
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-text-primary truncate">{dbSchema.name}</h2>
              <div className="text-[10px] text-text-faint">{dbEntries.length} entries · {dbSchema.fields.length} fields</div>
            </div>
          </div>
          <div className="flex-1 overflow-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border bg-bg-secondary text-text-muted">
                  <th className="text-left px-3 py-2 font-medium">Title</th>
                  {dbSchema.fields.filter((f) => f.name !== "title").map((f) => (
                    <th key={f.name} className="text-left px-3 py-2 font-medium">{f.name}</th>
                  ))}
                  <th className="text-left px-3 py-2 font-medium">Modified</th>
                </tr>
              </thead>
              <tbody>
                {dbEntries.map((entry) => (
                  <tr
                    key={entry.path}
                    onClick={() => handleSelectNode(entry.path)}
                    className="border-b border-border hover:bg-bg-hover cursor-pointer transition-colors"
                  >
                    <td className="px-3 py-2 text-text-primary font-medium">{entry.title}</td>
                    {dbSchema.fields.filter((f) => f.name !== "title").map((f) => (
                      <td key={f.name} className="px-3 py-2 text-text-muted">
                        {entry.fields[f.name] != null ? String(entry.fields[f.name]) : "—"}
                      </td>
                    ))}
                    <td className="px-3 py-2 text-text-faint whitespace-nowrap">
                      {entry.modified ? new Date(entry.modified).toLocaleDateString() : "—"}
                    </td>
                  </tr>
                ))}
                {dbEntries.length === 0 && (
                  <tr>
                    <td colSpan={dbSchema.fields.filter((f) => f.name !== "title").length + 2} className="px-3 py-8 text-center text-text-faint">
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
              setSelectedPath(null);
              setDbFolder(null);
              setDbSchema(null);
              setCreatingNew(false);
              setEditing(false);
            }}
            className="text-text-muted hover:text-text-primary transition-colors"
            aria-label="Back to tree"
          >
            <ArrowLeft size={16} />
          </button>
        ) : (
          <button
            onClick={() => navigate("/")}
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
                  setSelectedPath(null);
                  setEditing(false);
                  setNewPagePath("");
                  setNewPageContent("---\ntitle: \ntags: []\n---\n\n");
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
