import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type RefObject } from "react";
import {
  ChevronRight,
  Clipboard,
  Database,
  ExternalLink,
  FilePlus,
  Library,
  Link2,
  PanelLeftClose,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useToast } from "../../useToast";
import { getAppAbsoluteUrl } from "../../lib/app-url";
import { writeClipboardText } from "../../lib/clipboard";
import ContextMenu, { CtxDivider, CtxItem, type ContextMenuPosition } from "../ContextMenu";
import { LoadingSkeletonRegion, Skeleton } from "../shared/Skeleton";
import { useDocsShell } from "./docs-shell";
import { useDocsSearchQuery } from "./docs-queries";
import { cx, DocsButton, DocsIconButton, Kbd } from "./docs-ui";
import type { DeleteTarget } from "./DocsDialogs";
import {
  compactTreeLabel,
  docsRoute,
  flattenVisibleTree,
  formatRelativeTime,
  matchPagesByTitle,
  nodeLabel,
  parentPath,
  parseSnippet,
  pluralize,
  recentPages,
  targetForNode,
  type DocsTreeIndex,
  type DocsTreeRow,
} from "./docs-model";
import { DS } from "../../design/tokens";

const INDENT_PX = 14;

function folderLabels(path: string, index: DocsTreeIndex): string[] {
  const parts = parentPath(path).split("/").filter(Boolean);
  return parts.map((part, position) => {
    const folder = index.folders.get(parts.slice(0, position + 1).join("/"));
    return folder ? nodeLabel(folder) : part;
  });
}

// ── Search results ────────────────────────────────────────────────

interface SearchItem {
  path: string;
  title: string;
  trail: string;
  snippet: string;
}

function useSearchItems(query: string, index: DocsTreeIndex) {
  const search = useDocsSearchQuery(query);
  const items = useMemo<SearchItem[]>(() => {
    if (!query.trim()) return [];
    const contentHits = search.data?.results ?? [];
    const snippets = new Map(contentHits.map((hit) => [hit.path, hit.snippet]));
    const titleHits = matchPagesByTitle(index, query, 6);
    const seen = new Set<string>();
    const merged: SearchItem[] = [];
    const add = (path: string, title: string, snippet: string) => {
      if (seen.has(path)) return;
      seen.add(path);
      const labels = folderLabels(path, index);
      const folderName = parentPath(path).split("/").pop() ?? "";
      // The trail names the folder, so the title does not need to repeat it.
      merged.push({ path, title: compactTreeLabel(title, [folderName, labels[labels.length - 1] ?? ""]), trail: labels.join(" / "), snippet });
    };
    for (const page of titleHits) add(page.path, page.title, snippets.get(page.path) ?? page.description ?? "");
    for (const hit of contentHits) add(hit.path, index.pageByPath.get(hit.path)?.title ?? hit.title, hit.snippet);
    return merged;
  }, [query, search.data, index]);
  return { items, searching: search.isFetching, failed: search.isError };
}

function SearchResults({
  items,
  activeIndex,
  searching,
  failed,
  query,
  selectedPath,
  roomy,
  onOpen,
  onHover,
}: {
  items: SearchItem[];
  activeIndex: number;
  searching: boolean;
  failed: boolean;
  query: string;
  selectedPath: string | null;
  roomy: boolean;
  onOpen: (path: string) => void;
  onHover: (index: number) => void;
}) {
  if (items.length === 0) {
    return (
      <div className="px-4 py-10 text-center">
        <p className="text-sm text-text-muted">{searching ? "Searching…" : <>No pages match “{query.trim()}”</>}</p>
        {!searching && <p className="mt-1.5 text-xs text-text-faint">Search looks at titles, tags and the full text of every page.</p>}
      </div>
    );
  }
  return (
    <div>
      <ul id="docs-search-results" role="listbox" aria-label="Search results" className="space-y-0.5 px-2 py-2">
        {items.map((item, position) => (
          <li key={item.path} role="option" aria-selected={position === activeIndex}>
            <button
              type="button"
              onClick={() => onOpen(item.path)}
              onMouseEnter={() => onHover(position)}
              className={cx(DS.row.stacked, position === activeIndex && DS.row.selected)}
            >
              <div className={cx("truncate font-medium", roomy ? "text-[15px]" : "text-[13px]", item.path === selectedPath ? "text-accent" : "text-text-primary")}>
                {item.title}
              </div>
              {item.trail && <div className="mt-0.5 truncate text-[11px] text-text-faint">{item.trail}</div>}
              {item.snippet && (
                <p className="mt-1 line-clamp-2 text-xs leading-[1.15rem] text-text-muted">
                  {parseSnippet(item.snippet).map((segment, segmentIndex) => (
                    segment.highlighted ? <mark key={segmentIndex}>{segment.text}</mark> : <span key={segmentIndex}>{segment.text}</span>
                  ))}
                </p>
              )}
            </button>
          </li>
        ))}
      </ul>
      {failed && <p className="px-4 pb-3 text-xs text-text-faint">Full-text search is unavailable right now; showing title matches only.</p>}
    </div>
  );
}

// ── Tree ──────────────────────────────────────────────────────────

function isRowCurrent(row: DocsTreeRow, selectedPath: string | null, selectedIsCollection: boolean): boolean {
  if (!selectedPath) return false;
  // A collection stays highlighted while one of its entries is open; entries are not in the tree.
  if (row.kind === "collection") return selectedPath === row.node.path || selectedPath.startsWith(`${row.node.path}/`);
  return row.node.path === selectedPath && !selectedIsCollection;
}

function TreeSkeleton() {
  return (
    <LoadingSkeletonRegion isLoading label="Loading docs" className="space-y-3 px-4 py-3">
      {[64, 48, 72, 40, 58, 66, 44, 52].map((width, row) => (
        <Skeleton key={row} height={11} width={`${width}%`} shape="pill" style={{ marginLeft: row % 3 === 0 ? 0 : INDENT_PX }} />
      ))}
    </LoadingSkeletonRegion>
  );
}

interface TreeProps {
  rows: DocsTreeRow[];
  selectedPath: string | null;
  selectedIsCollection: boolean;
  roomy: boolean;
  onOpen: (row: DocsTreeRow) => void;
  onToggle: (path: string, open: boolean) => void;
  onContextMenu: (row: DocsTreeRow, position: ContextMenuPosition) => void;
  onAdd: (row: DocsTreeRow) => void;
}

function DocsTree({ rows, selectedPath, selectedIsCollection, roomy, onOpen, onToggle, onContextMenu, onAdd }: TreeProps) {
  const treeRef = useRef<HTMLDivElement | null>(null);
  const currentKey = rows.find((row) => isRowCurrent(row, selectedPath, selectedIsCollection))?.key ?? null;
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const tabStopKey = (focusKey && rows.some((row) => row.key === focusKey) ? focusKey : null) ?? currentKey ?? rows[0]?.key ?? null;

  const focusRow = (key: string) => {
    setFocusKey(key);
    const tree = treeRef.current;
    if (!tree || typeof tree.querySelector !== "function") return;
    tree.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(key)}"]`)?.focus();
  };

  // Bring the open page into view when it changes (deep links, search, in-page links).
  useEffect(() => {
    const tree = treeRef.current;
    if (!currentKey || !tree || typeof tree.querySelector !== "function") return;
    tree.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(currentKey)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [currentKey]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const position = rows.findIndex((row) => row.key === tabStopKey);
    if (position < 0) return;
    const row = rows[position];
    const move = (next: number) => {
      event.preventDefault();
      const target = rows[Math.min(rows.length - 1, Math.max(0, next))];
      if (target) focusRow(target.key);
    };
    switch (event.key) {
      case "ArrowDown":
        return move(position + 1);
      case "ArrowUp":
        return move(position - 1);
      case "Home":
        return move(0);
      case "End":
        return move(rows.length - 1);
      case "ArrowRight":
        if (!row.hasChildren) return;
        event.preventDefault();
        if (row.expanded) move(position + 1);
        else onToggle(row.node.path, true);
        return;
      case "ArrowLeft":
        event.preventDefault();
        if (row.hasChildren && row.expanded) onToggle(row.node.path, false);
        else if (row.parentKey) focusRow(row.parentKey);
        return;
      default:
    }
  };

  return (
    <div ref={treeRef} role="tree" aria-label="Docs" onKeyDown={handleKeyDown} className="px-2 py-2">
      {rows.map((row) => {
        const current = row.key === currentKey;
        const label = row.label;
        const fullTitle = nodeLabel(row.node);
        const count = row.kind === "collection" ? row.node.children?.length ?? 0 : null;
        const canAdd = row.kind !== "page" && !roomy;
        return (
          <div
            key={row.key}
            role="treeitem"
            aria-level={row.depth + 1}
            aria-expanded={row.hasChildren ? row.expanded : undefined}
            aria-selected={current}
            className={cx("group relative flex items-center rounded-md transition-colors", roomy ? "min-h-11" : "min-h-8", current ? DS.row.selected : "hover:bg-bg-hover/70")}
            onContextMenu={(event: MouseEvent) => {
              event.preventDefault();
              onContextMenu(row, { x: event.clientX, y: event.clientY });
            }}
          >
            {Array.from({ length: row.depth }, (_, guide) => (
              <span key={guide} aria-hidden="true" className="relative shrink-0 self-stretch" style={{ width: INDENT_PX }}>
                <span className="absolute inset-y-0 left-[13px] w-px bg-border-subtle" />
              </span>
            ))}
            {row.hasChildren ? (
              <button
                type="button"
                tabIndex={-1}
                aria-label={row.expanded ? `Collapse ${label}` : `Expand ${label}`}
                onClick={() => onToggle(row.node.path, !row.expanded)}
                className={cx(DS.button.base, DS.button.icon.sm, DS.button.variant.ghost, roomy && "h-11")}
              >
                <ChevronRight size={14} className={cx("transition-transform duration-150", row.expanded && "rotate-90")} />
              </button>
            ) : (
              <span className={cx("flex shrink-0 items-center justify-center", roomy ? "w-8" : "w-7")} aria-hidden="true">
                {row.kind === "collection" && <Database size={13} className={current ? "text-accent" : "text-text-muted"} />}
              </span>
            )}
            <button
              type="button"
              data-row-key={row.key}
              tabIndex={row.key === tabStopKey ? 0 : -1}
              aria-current={current ? "page" : undefined}
              onFocus={() => setFocusKey(row.key)}
              onClick={() => onOpen(row)}
              title={fullTitle}
              className={cx(DS.focus, "min-h-10 min-w-0 flex-1 truncate py-2 pr-2 text-left text-[13px] group-hover:text-text-primary md:min-h-8", roomy && "text-[15px]", current ? "font-medium text-text-primary" : "text-text-secondary")}
            >
              {label}
            </button>
            {count !== null && <span className={cx("shrink-0 pr-2 text-[11px] tabular-nums text-text-faint", canAdd && "group-hover:hidden group-focus-within:hidden")}>{count}</span>}
            {canAdd && (
              <button
                type="button"
                tabIndex={-1}
                aria-label={row.kind === "collection" ? `New entry in ${label}` : `New page in ${label}`}
                title={row.kind === "collection" ? "New entry" : "New page here"}
                onClick={() => onAdd(row)}
                className={cx(DS.button.base, DS.button.icon.sm, DS.button.variant.ghost, "mr-1 hidden group-focus-within:flex group-hover:flex")}
              >
                <Plus size={14} />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Sidebar ───────────────────────────────────────────────────────

export interface DocsSidebarProps {
  /** "rail" is the desktop column; "screen" is the full-screen browser phones land on. */
  variant: "rail" | "screen";
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
  selectedPath: string | null;
  selectedIsCollection: boolean;
  query: string;
  onQueryChange: (query: string) => void;
  searchInputRef: RefObject<HTMLInputElement | null>;
  expanded: ReadonlySet<string>;
  onToggle: (path: string, open: boolean) => void;
  onCollapse?: () => void;
  onDelete: (target: DeleteTarget) => void;
}

export default function DocsSidebar({
  variant,
  loading,
  failed,
  onRetry,
  selectedPath,
  selectedIsCollection,
  query,
  onQueryChange,
  searchInputRef,
  expanded,
  onToggle,
  onCollapse,
  onDelete,
}: DocsSidebarProps) {
  const { index, goTo, goHome, openNewPage, openNewEntry } = useDocsShell();
  const { showToast } = useToast();
  const roomy = variant === "screen";
  const [activeResult, setActiveResult] = useState(0);
  const [menu, setMenu] = useState<{ row: DocsTreeRow; position: ContextMenuPosition } | null>(null);
  const { items, searching, failed: searchFailed } = useSearchItems(query, index);
  const rows = useMemo(() => flattenVisibleTree(index.roots, expanded), [index.roots, expanded]);
  const recent = useMemo(() => (roomy ? recentPages(index, 5) : []), [roomy, index]);
  const hasQuery = query.trim().length > 0;

  useEffect(() => {
    setActiveResult(0);
  }, [query]);

  const openResult = (path: string) => {
    onQueryChange("");
    goTo(path);
  };

  const openRow = (row: DocsTreeRow) => {
    // On a phone this screen is the whole view, so a plain folder opens in place.
    if (roomy && row.kind === "folder" && !row.node.hasIndex) {
      onToggle(row.node.path, !row.expanded);
      return;
    }
    if (row.hasChildren && !row.expanded) onToggle(row.node.path, true);
    goTo(targetForNode(row.node));
  };

  const addUnder = (row: DocsTreeRow) => {
    if (row.kind === "collection") openNewEntry(row.node.path);
    else openNewPage(row.node.path);
  };

  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      if (query) onQueryChange("");
      else event.currentTarget.blur();
      return;
    }
    if (!hasQuery || items.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setActiveResult((current) => (current + delta + items.length) % items.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      openResult(items[Math.min(activeResult, items.length - 1)].path);
    }
  };

  const copy = (text: string, label: string) => {
    void writeClipboardText(text).then(
      () => showToast({ tone: "success", title: `${label} copied`, durationMs: 2500 }),
      () => showToast({ tone: "error", title: `Could not copy the ${label.toLowerCase()}` }),
    );
  };

  const menuRow = menu?.row ?? null;
  const menuTarget = menuRow ? targetForNode(menuRow.node) : null;
  const closeMenu = () => setMenu(null);

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-secondary">
      <div className={cx("flex shrink-0 items-center gap-1 pl-3 pr-2", roomy ? "h-12 border-b border-border" : "h-12")}>
        <button
          type="button"
          onClick={goHome}
          className={cx(DS.button.base, DS.button.size.sm, DS.button.variant.ghost, DS.focus, "min-w-0 flex-1 gap-2 text-left")}
        >
          <Library size={16} className="shrink-0 text-accent" aria-hidden="true" />
          <span className={cx("truncate font-semibold text-text-primary", roomy ? "text-[17px]" : "text-sm")}>Docs</span>
        </button>
        <DocsIconButton icon={FilePlus} label="New page" onClick={() => openNewPage()} className={roomy ? "h-10 w-10" : undefined} size={roomy ? 18 : 16} />
        {onCollapse && <DocsIconButton icon={PanelLeftClose} label="Hide sidebar" onClick={onCollapse} />}
      </div>

      <div className={cx("shrink-0 px-3", roomy ? "py-3" : "pb-2")}>
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-faint" aria-hidden="true" />
          <input
            ref={searchInputRef}
            type="text"
            role="combobox"
            aria-label="Search docs"
            aria-expanded={hasQuery}
            aria-controls="docs-search-results"
            aria-autocomplete="list"
            autoComplete="off"
            spellCheck={false}
            enterKeyHint="search"
            value={query}
            placeholder="Search docs"
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={handleSearchKeyDown}
            className={cx(DS.field.input, DS.field.inputSize.md, "peer pl-8 pr-8", roomy ? "h-10" : "md:h-8")}
          />
          {query ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => {
                onQueryChange("");
                searchInputRef.current?.focus();
              }}
              className={cx(DS.button.base, DS.button.icon.sm, DS.button.variant.ghost, "absolute right-1.5 top-1/2 -translate-y-1/2 text-text-faint")}
            >
              <X size={13} />
            </button>
          ) : !roomy ? (
            <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 peer-focus:hidden"><Kbd>/</Kbd></span>
          ) : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {hasQuery ? (
          <SearchResults
            items={items}
            activeIndex={activeResult}
            searching={searching}
            failed={searchFailed}
            query={query}
            selectedPath={selectedPath}
            roomy={roomy}
            onOpen={openResult}
            onHover={setActiveResult}
          />
        ) : loading ? (
          <TreeSkeleton />
        ) : failed ? (
          <div className="px-4 py-10 text-center">
            <p className="text-sm text-text-muted">Your docs could not be loaded.</p>
            <DocsButton onClick={onRetry} className="mt-3">Try again</DocsButton>
          </div>
        ) : rows.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <p className="text-sm font-medium text-text-primary">No pages yet</p>
            <p className="mt-1.5 text-xs leading-5 text-text-muted">Write the first one, or ask an agent to document something for you.</p>
            <DocsButton variant="primary" icon={FilePlus} onClick={() => openNewPage()} className="mt-4">New page</DocsButton>
          </div>
        ) : (
          <>
            {recent.length > 0 && (
              <section aria-labelledby="docs-recent-heading" className="border-b border-border pb-2">
                <h2 id="docs-recent-heading" className="px-4 pb-1 pt-1 text-xs font-semibold text-text-muted">Recently updated</h2>
                <ul className="px-2">
                  {recent.map((page) => {
                    const labels = folderLabels(page.path, index);
                    const folderName = parentPath(page.path).split("/").pop() ?? "";
                    return (
                      <li key={page.path}>
                        <button type="button" onClick={() => goTo(page.path)} className={cx(DS.row.base, DS.row.interactive, "min-h-12 w-full gap-3 text-left active:bg-bg-hover", DS.row.touch)}>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[15px] text-text-primary">{compactTreeLabel(page.title, [folderName, labels[labels.length - 1] ?? ""])}</span>
                            {labels.length > 0 && <span className="block truncate text-xs text-text-faint">{labels.join(" / ")}</span>}
                          </span>
                          <span className="shrink-0 text-xs text-text-faint">{formatRelativeTime(page.modified)}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}
            {roomy && <h2 className="px-4 pb-0 pt-3 text-xs font-semibold text-text-muted">All pages</h2>}
            <DocsTree
              rows={rows}
              selectedPath={selectedPath}
              selectedIsCollection={selectedIsCollection}
              roomy={roomy}
              onOpen={openRow}
              onToggle={onToggle}
              onContextMenu={(row, position) => setMenu({ row, position })}
              onAdd={addUnder}
            />
          </>
        )}
      </div>

      {!roomy && !loading && !failed && rows.length > 0 && !hasQuery && (
        <div className="shrink-0 border-t border-border px-4 py-2 text-[11px] text-text-faint">
          {pluralize(index.stats.pages, "page")}
          {index.stats.collections > 0 && ` · ${pluralize(index.stats.collections, "collection")}`}
        </div>
      )}

      {menu && menuRow && menuTarget && (
        <ContextMenu position={menu.position} onClose={closeMenu}>
          <CtxItem icon={<ExternalLink size={15} />} label="Open" onClick={() => { closeMenu(); goTo(menuTarget); }} />
          {menuRow.kind === "folder" && <CtxItem icon={<FilePlus size={15} />} label="New page here" onClick={() => { closeMenu(); openNewPage(menuRow.node.path); }} />}
          {menuRow.kind === "collection" && <CtxItem icon={<Plus size={15} />} label="New entry" onClick={() => { closeMenu(); openNewEntry(menuRow.node.path); }} />}
          <CtxDivider />
          <CtxItem icon={<Link2 size={15} />} label="Copy link" onClick={() => { closeMenu(); copy(getAppAbsoluteUrl(docsRoute(menuTarget)).toString(), "Link"); }} />
          <CtxItem icon={<Clipboard size={15} />} label="Copy path" onClick={() => { closeMenu(); copy(menuRow.node.path, "Path"); }} />
          {menuRow.kind === "page" && (
            <>
              <CtxDivider />
              <CtxItem
                icon={<Trash2 size={15} />}
                label="Delete page"
                className="text-error"
                onClick={() => { closeMenu(); onDelete({ path: menuRow.node.path, title: nodeLabel(menuRow.node), isEntry: false }); }}
              />
            </>
          )}
        </ContextMenu>
      )}
    </div>
  );
}
