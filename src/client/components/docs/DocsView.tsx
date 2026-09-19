import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { setLastViewedDoc } from "../../last-viewed";
import { useIsMobile } from "../../useIsMobile";
import { LoadingSkeletonRegion, Skeleton, SkeletonText } from "../shared/Skeleton";
import DocsCollectionView from "./DocsCollectionView";
import DocsEditor from "./DocsEditor";
import DocsPageView from "./DocsPageView";
import DocsSidebar from "./DocsSidebar";
import { DeletePageDialog, NewEntryDialog, NewPageDialog, type DeleteTarget } from "./DocsDialogs";
import { DocsFolderPage, DocsHome, DocsLoadError, DocsNotFound } from "./DocsOverview";
import { DocsShellProvider, type DocsShell } from "./docs-shell";
import { isNotFoundError, useDbSchemaQuery, useDocPageQuery, useDocsTreeQuery } from "./docs-queries";
import {
  loadExpandedFolders,
  loadSidebarCollapsed,
  loadWideLayout,
  saveExpandedFolders,
  saveSidebarCollapsed,
  saveWideLayout,
} from "./docs-storage";
import {
  ancestorFolderPaths,
  buildTreeIndex,
  defaultNewPageFolder,
  docsRoute,
  leadingTitle,
  nodeLabel,
  owningCollection,
  parentPath,
} from "./docs-model";

export interface DocsViewProps {
  /** Publishes the resolved page/collection title so the app can title the browser tab. */
  onDocTitleChange?: (title: string | null) => void;
}

type DialogState =
  | { kind: "new-page"; folder: string; slug?: string }
  | { kind: "new-entry"; folder: string }
  | { kind: "delete"; target: DeleteTarget }
  | null;

const EMPTY_TREE: never[] = [];

function readDocPath(pathname: string): string | null {
  const raw = pathname.replace(/^\/docs\/?/, "").replace(/\/+$/, "");
  if (!raw) return null;
  return raw
    .split("/")
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join("/");
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

function PageSkeleton() {
  return (
    <LoadingSkeletonRegion isLoading label="Loading page" delayMs={120} className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-5">
        <Skeleton height={10} width={44} shape="pill" />
        <Skeleton height={10} width={96} shape="pill" />
        <Skeleton height={10} width={160} shape="pill" />
      </div>
      <div className="mx-auto w-full max-w-[47rem] space-y-8 px-5 pt-10 sm:px-8">
        <div className="space-y-4">
          <Skeleton height={30} width="70%" shape="rounded" />
          <SkeletonText lines={2} widths={["96%", "58%"]} />
          <Skeleton height={10} width={200} shape="pill" />
        </div>
        <SkeletonText lines={5} widths={["100%", "96%", "90%", "98%", "64%"]} />
        <div className="space-y-3">
          <Skeleton height={18} width="34%" shape="rounded" />
          <SkeletonText lines={6} widths={["98%", "100%", "84%", "92%", "96%", "48%"]} />
        </div>
      </div>
    </LoadingSkeletonRegion>
  );
}

export default function DocsView({ onDocTitleChange }: DocsViewProps = {}) {
  const navigate = useNavigate();
  const location = useLocation();
  const isMobile = useIsMobile();

  const docPath = useMemo(() => readDocPath(location.pathname), [location.pathname]);
  const isCollectionRoute = docPath !== null && new URLSearchParams(location.search).has("db");

  const treeQuery = useDocsTreeQuery();
  const treeLoaded = treeQuery.data !== undefined;
  const index = useMemo(() => buildTreeIndex(treeQuery.data?.tree ?? EMPTY_TREE), [treeQuery.data]);

  const [expanded, setExpanded] = useState<Set<string>>(() => loadExpandedFolders() ?? new Set());
  const [hasStoredExpansion] = useState(() => loadExpandedFolders() !== null);
  const [sidebarCollapsed, setSidebarCollapsedState] = useState(loadSidebarCollapsed);
  const [wide, setWideState] = useState(loadWideLayout);
  const [searchQuery, setSearchQuery] = useState("");
  const [dialog, setDialog] = useState<DialogState>(null);
  const [editing, setEditing] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const seededExpansionRef = useRef(false);

  // ── What the route points at ───────────────────────────────────
  const folderNode = docPath ? index.folders.get(docPath) : undefined;
  const isPlainFolder = Boolean(treeLoaded && docPath && folderNode && !folderNode.hasIndex && !index.files.has(docPath));
  const wantsPage = docPath !== null && !isCollectionRoute && !isPlainFolder;
  const pageQuery = useDocPageQuery(docPath, wantsPage);
  const page = wantsPage ? pageQuery.data ?? null : null;
  const entryCollection = page?.isDbItem ? page.folder : null;
  const schemaQuery = useDbSchemaQuery(entryCollection);
  const schema = entryCollection ? schemaQuery.data ?? null : null;

  // ── Tree expansion ─────────────────────────────────────────────
  const setFolderOpen = useCallback((path: string, open: boolean) => {
    setExpanded((current) => {
      if (current.has(path) === open) return current;
      const next = new Set(current);
      if (open) next.add(path);
      else next.delete(path);
      saveExpandedFolders(next);
      return next;
    });
  }, []);

  // First visit: open the top-level folders so the tree is not a wall of closed rows.
  useEffect(() => {
    if (!treeQuery.data || hasStoredExpansion || seededExpansionRef.current) return;
    seededExpansionRef.current = true;
    const topLevel = treeQuery.data.tree.filter((node) => node.type === "folder" && !node.isDb).map((node) => node.path);
    if (topLevel.length === 0) return;
    // Merge rather than replace: a deep link has already opened the folders above its page.
    setExpanded((current) => {
      const next = new Set([...current, ...topLevel]);
      saveExpandedFolders(next);
      return next;
    });
  }, [treeQuery.data, hasStoredExpansion]);

  // Wherever the reader lands, make sure the tree shows it.
  useEffect(() => {
    if (!docPath) return;
    const ancestors = ancestorFolderPaths(docPath);
    setExpanded((current) => {
      if (ancestors.every((path) => current.has(path))) return current;
      const next = new Set([...current, ...ancestors]);
      saveExpandedFolders(next);
      return next;
    });
  }, [docPath]);

  // ── Navigation and shell actions ───────────────────────────────
  const goTo = useCallback<DocsShell["goTo"]>((target, options) => {
    navigate(docsRoute(target, options?.hash ?? ""), {
      replace: options?.replace,
      state: options?.edit ? { docsEdit: true } : undefined,
    });
  }, [navigate]);

  const goHome = useCallback(() => navigate("/docs"), [navigate]);

  const setSidebarCollapsed = useCallback((collapsed: boolean) => {
    setSidebarCollapsedState(collapsed);
    saveSidebarCollapsed(collapsed);
  }, []);

  const setWide = useCallback((next: boolean) => {
    setWideState(next);
    saveWideLayout(next);
  }, []);

  const focusSearch = useCallback(() => {
    if (isMobile) {
      if (docPath !== null) navigate("/docs");
    } else {
      setSidebarCollapsed(false);
    }
    // The input may only exist after this render (collapsed sidebar, or the phone home screen).
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    }));
  }, [isMobile, docPath, navigate, setSidebarCollapsed]);

  const searchFor = useCallback((query: string) => {
    setSearchQuery(query);
    focusSearch();
  }, [focusSearch]);

  const openNewPage = useCallback((folder?: string, slug?: string) => {
    const collection = owningCollection(index, folder ?? docPath);
    if (collection && folder === undefined) {
      setDialog({ kind: "new-entry", folder: collection.path });
      return;
    }
    setDialog({ kind: "new-page", folder: folder ?? defaultNewPageFolder(index, docPath), slug });
  }, [index, docPath]);

  const openNewEntry = useCallback((folder: string) => setDialog({ kind: "new-entry", folder }), []);

  const shell = useMemo<DocsShell>(() => ({
    isMobile,
    index,
    sidebarCollapsed,
    expandSidebar: () => setSidebarCollapsed(false),
    goTo,
    goHome,
    openNewPage,
    openNewEntry,
    searchFor,
    focusSearch,
    wide,
    setWide,
  }), [isMobile, index, sidebarCollapsed, setSidebarCollapsed, goTo, goHome, openNewPage, openNewEntry, searchFor, focusSearch, wide, setWide]);

  // ── Edit mode ──────────────────────────────────────────────────
  useEffect(() => {
    setEditing(false);
  }, [docPath, isCollectionRoute]);

  // A freshly created page opens straight into the editor.
  const wantsEdit = Boolean((location.state as { docsEdit?: boolean } | null)?.docsEdit);
  useEffect(() => {
    if (!wantsEdit || !page) return;
    setEditing(true);
    navigate(`${location.pathname}${location.search}${location.hash}`, { replace: true, state: null });
  }, [wantsEdit, page, navigate, location.pathname, location.search, location.hash]);

  // ── Tab title and "last viewed" ────────────────────────────────
  const pageTitle = page
    ? (typeof page.frontmatter.title === "string" && page.frontmatter.title.trim() ? page.title : leadingTitle(page.body) ?? page.title)
    : null;
  const publishedTitle = docPath === null
    ? null
    : pageTitle ?? ((isCollectionRoute || isPlainFolder) && folderNode ? nodeLabel(folderNode) : null);
  useEffect(() => {
    onDocTitleChange?.(publishedTitle);
  }, [publishedTitle, onDocTitleChange]);
  useEffect(() => () => onDocTitleChange?.(null), [onDocTitleChange]);

  useEffect(() => {
    if (docPath) setLastViewedDoc(isCollectionRoute ? `${docPath}?db` : docPath);
  }, [docPath, isCollectionRoute]);

  // ── Keyboard shortcuts ─────────────────────────────────────────
  const canEdit = page !== null && !editing && (!page.isDbItem || schema !== null);
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || isTypingTarget(event.target)) return;
      if (typeof document.querySelector === "function" && document.querySelector('[aria-modal="true"]')) return;
      if (event.key === "/") {
        event.preventDefault();
        focusSearch();
      } else if (event.key === "e" && canEdit) {
        event.preventDefault();
        setEditing(true);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [focusSearch, canEdit]);

  // ── Screen selection ───────────────────────────────────────────
  const sidebar = (variant: "rail" | "screen") => (
    <DocsSidebar
      variant={variant}
      loading={treeQuery.isPending}
      failed={treeQuery.isError && !treeLoaded}
      onRetry={() => void treeQuery.refetch()}
      selectedPath={docPath}
      selectedIsCollection={isCollectionRoute}
      query={searchQuery}
      onQueryChange={setSearchQuery}
      searchInputRef={searchInputRef}
      expanded={expanded}
      onToggle={setFolderOpen}
      onCollapse={variant === "rail" ? () => setSidebarCollapsed(true) : undefined}
      onDelete={(target) => setDialog({ kind: "delete", target })}
    />
  );

  let screen: ReactNode;
  if (docPath === null) {
    if (isMobile) screen = sidebar("screen");
    else if (!treeLoaded) screen = treeQuery.isError ? <DocsLoadError path="" message="Your docs could not be loaded." onRetry={() => void treeQuery.refetch()} /> : <PageSkeleton />;
    else if (treeQuery.data?.hasRootIndex) screen = <Navigate to={`/docs/index${location.hash}`} replace />;
    else screen = <DocsHome />;
  } else if (isCollectionRoute) {
    screen = <DocsCollectionView key={docPath} folder={docPath} onMissing={<DocsNotFound path={docPath} canCreate={false} />} />;
  } else if (isPlainFolder) {
    screen = folderNode?.isDb
      ? <Navigate to={docsRoute({ path: docPath, kind: "collection" })} replace />
      : <DocsFolderPage path={docPath} />;
  } else if (page && editing && (!page.isDbItem || schema)) {
    screen = <DocsEditor key={page.path} page={page} schema={schema} onClose={() => setEditing(false)} />;
  } else if (page) {
    screen = (
      <DocsPageView
        key={page.path}
        page={page}
        schema={schema}
        hash={location.hash}
        onEdit={() => setEditing(true)}
        onDelete={() => setDialog({ kind: "delete", target: { path: page.path, title: pageTitle ?? page.title, isEntry: page.isDbItem } })}
      />
    );
  } else if (pageQuery.isError && !isNotFoundError(pageQuery.error)) {
    screen = <DocsLoadError path={docPath} message={pageQuery.error instanceof Error ? pageQuery.error.message : "Something went wrong."} onRetry={() => void pageQuery.refetch()} />;
  } else if (pageQuery.isError && treeLoaded) {
    screen = <DocsNotFound path={docPath} canCreate={owningCollection(index, docPath) === null} />;
  } else {
    screen = <PageSkeleton />;
  }

  const afterDelete = (target: DeleteTarget) => {
    setDialog(null);
    if (docPath !== target.path) return;
    const collection = target.isEntry ? owningCollection(index, target.path) : null;
    if (collection) goTo({ path: collection.path, kind: "collection" }, { replace: true });
    else if (parentPath(target.path)) goTo({ path: parentPath(target.path), kind: "folder" }, { replace: true });
    else navigate("/docs", { replace: true });
  };

  // Editing hides the tree: the writer gets the width, and a stray click cannot leave the page.
  const isEditorOpen = Boolean(page && editing && (!page.isDbItem || schema));
  const showRail = !isMobile && !sidebarCollapsed && !isEditorOpen;

  return (
    <DocsShellProvider value={shell}>
      <div className="docs-ui flex h-full min-h-0 overflow-hidden bg-bg-primary">
        {showRail && <aside className="w-[17.5rem] shrink-0 border-r border-border">{sidebar("rail")}</aside>}
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">{screen}</main>
      </div>

      {dialog?.kind === "new-page" && <NewPageDialog initialFolder={dialog.folder} initialSlug={dialog.slug} onClose={() => setDialog(null)} />}
      {dialog?.kind === "new-entry" && <NewEntryDialog folder={dialog.folder} onClose={() => setDialog(null)} />}
      {dialog?.kind === "delete" && (
        <DeletePageDialog target={dialog.target} onClose={() => setDialog(null)} onDeleted={() => afterDelete(dialog.target)} />
      )}
    </DocsShellProvider>
  );
}
