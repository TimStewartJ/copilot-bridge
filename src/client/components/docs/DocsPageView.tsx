import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { Link } from "react-router-dom";
import {
  ArrowLeft,
  ArrowRight,
  Clipboard,
  FileText,
  Link2,
  List,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  Pencil,
  Trash2,
} from "lucide-react";
import type { DbSchema, DocPage, DocTreeNode } from "../../api";
import { TAG_COLOR_BG, TAG_COLOR_TEXT } from "../../tag-colors";
import { useTagsQuery } from "../../hooks/queries/useTags";
import { useToast } from "../../useToast";
import { getAppAbsoluteUrl } from "../../lib/app-url";
import { writeClipboardText } from "../../lib/clipboard";
import ContextMenu, { CtxDivider, CtxItem, type ContextMenuPosition } from "../ContextMenu";
import DocsMarkdown from "./DocsMarkdown";
import DocsToc, { useActiveHeading } from "./DocsToc";
import { DbValue } from "./DocsEntryFields";
import { DocsTopBar, useDocsShell } from "./docs-shell";
import { clearDraft, loadDraft, type StoredDraft } from "./docs-storage";
import { cx, DocsBanner, DocsButton, DocsDialog, DocsIconButton, useElementWidth } from "./docs-ui";
import {
  buildBreadcrumbs,
  dbFieldLabel,
  docsRoute,
  estimateReadingMinutes,
  extractHeadings,
  findHeadingByAnchor,
  findNeighbours,
  formatDocDate,
  formatRelativeTime,
  leadingTitle,
  nodeKind,
  nodeLabel,
  stripLeadingTitle,
  tagsMatch,
  tocHeadings,
  visibleDbFields,
  type DocsPageRef,
} from "./docs-model";
import { DS } from "../../design/tokens";
import { prefersReducedMotion } from "../../lib/motion";

/** Narrowest reading pane that still fits the contents rail beside a readable column. */
const TOC_RAIL_MIN_WIDTH = 900;

/** Long summaries are clamped on phones, where they would otherwise push the page off screen. */
function PageDescription({ text, clamp }: { text: string; clamp: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const clamped = clamp && !expanded && text.length > 180;
  return (
    <div className="mt-3">
      <p className={cx("text-[15px] leading-7 text-text-secondary", clamped && "line-clamp-3")}>{text}</p>
      {clamped && (
        <button type="button" onClick={() => setExpanded(true)} className={cx(DS.button.base, DS.button.size.sm, DS.button.variant.ghost, "mt-1 text-accent hover:text-accent-hover")}>
          Show more
        </button>
      )}
    </div>
  );
}

export function DocTagChips({ tags, onSelect }: { tags: string[]; onSelect?: (tag: string) => void }) {
  const { data: bridgeTags } = useTagsQuery();
  if (tags.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Tags">
      {tags.map((tag) => {
        const color = bridgeTags?.find((candidate) => tagsMatch(candidate.name, tag))?.color;
        const tone = color
          ? `${TAG_COLOR_BG[color] ?? "bg-bg-surface"} ${TAG_COLOR_TEXT[color] ?? "text-text-secondary"}`
          : "bg-bg-surface text-text-secondary";
        const className = cx(DS.badge.base, "items-center text-xs", tone);
        return (
          <li key={tag}>
            {onSelect ? (
              <button type="button" onClick={() => onSelect(tag)} title={`Find pages tagged “${tag}”`} className={cx(className, "transition-opacity hover:opacity-75")}>
                {tag}
              </button>
            ) : (
              <span className={className}>{tag}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function NeighbourLink({ page, direction }: { page: DocsPageRef; direction: "previous" | "next" }) {
  const isNext = direction === "next";
  return (
    <Link
      to={docsRoute(page.path)}
      className={cx("group flex min-w-0 flex-1 flex-col gap-1 rounded-xl border border-border px-4 py-3 transition-colors hover:bg-bg-secondary", isNext && "items-end text-right")}
    >
      <span className="flex items-center gap-1.5 text-xs text-text-muted">
        {!isNext && <ArrowLeft size={12} aria-hidden="true" />}
        {isNext ? "Next" : "Previous"}
        {isNext && <ArrowRight size={12} aria-hidden="true" />}
      </span>
      <span className="max-w-full truncate text-sm font-medium text-text-primary group-hover:text-accent">{page.title}</span>
    </Link>
  );
}

export function FolderChildList({ nodes }: { nodes: DocTreeNode[] }) {
  if (nodes.length === 0) return null;
  return (
    <ul className="divide-y divide-border-subtle overflow-hidden rounded-xl border border-border">
      {nodes.map((node) => {
        const kind = nodeKind(node);
        const count = kind === "page" ? null : node.children?.length ?? 0;
        return (
          <li key={`${node.type}:${node.path}`}>
            <Link to={docsRoute({ path: node.path, kind })} className="group flex items-start gap-3 px-4 py-3 transition-colors hover:bg-bg-secondary">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-text-primary group-hover:text-accent">{nodeLabel(node)}</span>
                  {count !== null && (
                    <span className={cx(DS.badge.base, "shrink-0 bg-bg-surface text-text-muted")}>
                      {kind === "collection" ? `${count} entries` : `${count} items`}
                    </span>
                  )}
                </div>
                {node.description && <p className="mt-0.5 line-clamp-2 text-[13px] leading-5 text-text-muted">{node.description}</p>}
              </div>
              {node.modified && (
                <span className="shrink-0 pt-0.5 text-xs text-text-faint" title={formatDocDate(node.modified)}>
                  {formatRelativeTime(node.modified)}
                </span>
              )}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export interface DocsPageViewProps {
  page: DocPage;
  /** Schema of the owning collection, when the page is a collection entry. */
  schema: DbSchema | null;
  hash: string;
  onEdit: () => void;
  onDelete: () => void;
}

export default function DocsPageView({ page, schema, hash, onEdit, onDelete }: DocsPageViewProps) {
  const shell = useDocsShell();
  const { index, isMobile, wide, setWide } = shell;
  const { showToast } = useToast();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [menuPosition, setMenuPosition] = useState<ContextMenuPosition | null>(null);
  const [tocOpen, setTocOpen] = useState(false);
  const [storedDraft, setStoredDraft] = useState<StoredDraft | null>(null);
  const paneWidth = useElementWidth(scrollRef);

  const hasFrontmatterTitle = typeof page.frontmatter.title === "string" && page.frontmatter.title.trim().length > 0;
  const title = hasFrontmatterTitle ? page.title : leadingTitle(page.body) ?? page.title;
  const description = typeof page.frontmatter.description === "string" ? page.frontmatter.description.trim() : "";
  const body = useMemo(() => stripLeadingTitle(page.body), [page.body]);
  const headings = useMemo(() => extractHeadings(body), [body]);
  const contents = useMemo(() => tocHeadings(headings), [headings]);
  const activeHeadingId = useActiveHeading(scrollRef, contents);
  const readingMinutes = useMemo(() => estimateReadingMinutes(body), [body]);

  const folderNode = page.isFolderIndex ? index.folders.get(page.path) : undefined;
  const crumbs = useMemo(() => buildBreadcrumbs(page.path, index, title), [page.path, index, title]);
  const neighbours = useMemo(
    () => (page.isDbItem ? { previous: null, next: null } : findNeighbours(index, page.path)),
    [index, page.path, page.isDbItem],
  );
  const entryFields = schema && page.isDbItem ? visibleDbFields(schema) : [];
  const showRail = !isMobile && contents.length > 1 && paneWidth >= TOC_RAIL_MIN_WIDTH;
  const showTocButton = contents.length > 1 && !showRail;

  useEffect(() => {
    setStoredDraft(loadDraft(page.path));
  }, [page.path, page.modified]);

  const scrollToHeading = useCallback((id: string, behavior: ScrollBehavior): boolean => {
    const container = scrollRef.current;
    const element = typeof document.getElementById === "function" ? document.getElementById(id) : null;
    if (!container || !element || typeof container.scrollTo !== "function") return false;
    const top = element.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop - 20;
    container.scrollTo({ top: Math.max(0, top), behavior });
    element.classList.remove("docs-heading-flash");
    // Reading a layout property restarts the animation when the same heading is chosen twice.
    void element.offsetWidth;
    element.classList.add("docs-heading-flash");
    return true;
  }, []);

  // Land on the fragment from the URL, or at the top of a newly opened page.
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const container = scrollRef.current;
      if (!container) return;
      let anchor = hash.replace(/^#/, "");
      try {
        anchor = decodeURIComponent(anchor);
      } catch {
        // Keep the literal fragment.
      }
      const target = findHeadingByAnchor(headings, anchor);
      if (!target || !scrollToHeading(target.id, "auto")) container.scrollTo?.({ top: 0, behavior: "auto" });
    });
    return () => window.cancelAnimationFrame(frame);
    // `headings` is deliberately not a dependency: it changes on every background refetch, and
    // re-running then would yank the reader back to the fragment while they are mid-page.
  }, [page.path, hash, scrollToHeading]);

  const handleAnchorSelect = useCallback((anchor: string, source: "heading" | "link" | "toc") => {
    const id = findHeadingByAnchor(headings, anchor)?.id ?? anchor;
    if (!scrollToHeading(id, prefersReducedMotion() ? "auto" : "smooth")) return;
    const fragment = `#${encodeURIComponent(id)}`;
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}${fragment}`);
    if (source !== "heading") return;
    const url = getAppAbsoluteUrl(docsRoute(page.path, fragment)).toString();
    void writeClipboardText(url).then(
      () => showToast({ tone: "success", title: "Link to section copied", durationMs: 2500 }),
      () => showToast({ tone: "error", title: "Could not copy the link" }),
    );
  }, [headings, page.path, scrollToHeading, showToast]);

  const copy = useCallback((text: string, label: string) => {
    void writeClipboardText(text).then(
      () => showToast({ tone: "success", title: `${label} copied`, durationMs: 2500 }),
      () => showToast({ tone: "error", title: `Could not copy the ${label.toLowerCase()}` }),
    );
  }, [showToast]);

  const openMenu = (event: ReactMouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setMenuPosition({ x: rect.right - 200, y: rect.bottom + 6 });
  };

  const actions = (
    <>
      {showTocButton && <DocsIconButton icon={List} label="On this page" onClick={() => setTocOpen(true)} className={isMobile ? "h-10 w-10" : undefined} />}
      {isMobile
        ? <DocsIconButton icon={Pencil} label="Edit page" onClick={onEdit} className="h-10 w-10" />
        : <DocsButton icon={Pencil} onClick={onEdit} title="Edit (E)">Edit</DocsButton>}
      <DocsIconButton
        icon={MoreHorizontal}
        label="More actions"
        aria-haspopup="menu"
        aria-expanded={menuPosition !== null}
        onClick={openMenu}
        className={isMobile ? "h-10 w-10" : undefined}
      />
    </>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <DocsTopBar crumbs={crumbs} title={title} actions={actions} />

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className={cx("docs-content-in mx-auto flex w-full gap-10 px-5 sm:px-8", wide ? "max-w-none" : "max-w-[66rem]")}>
          <article className={cx("min-w-0 flex-1 pb-24 pt-8 sm:pt-10", !wide && "mx-auto max-w-[47rem]")}>
            {storedDraft && (
              <div className="mb-6">
                <DocsBanner
                  tone="info"
                  actions={(
                    <>
                      <DocsButton variant="ghost" onClick={() => { clearDraft(page.path); setStoredDraft(null); }}>Discard</DocsButton>
                      <DocsButton variant="primary" onClick={onEdit}>Resume editing</DocsButton>
                    </>
                  )}
                >
                  You have unsaved edits to this page from {formatRelativeTime(storedDraft.savedAt)}.
                </DocsBanner>
              </div>
            )}

            <header className="mb-8 border-b border-border-subtle pb-6">
              {isMobile && crumbs.length > 1 && (
                <nav aria-label="Breadcrumb" className="mb-2 flex flex-wrap items-center gap-x-1.5 text-[13px] text-text-muted">
                  {crumbs.slice(0, -1).map((crumb, position) => (
                    <span key={`${position}:${crumb.label}`} className="flex items-center gap-1.5">
                      {position > 0 && <span aria-hidden="true" className="text-text-faint">/</span>}
                      {crumb.target ? <Link to={docsRoute(crumb.target)} className="hover:text-text-primary">{crumb.label}</Link> : crumb.label}
                    </span>
                  ))}
                </nav>
              )}
              <h1 className="text-[1.75rem] font-semibold leading-tight tracking-tight text-text-primary sm:text-[2rem]">{title}</h1>
              {description && <PageDescription text={description} clamp={isMobile} />}
              <div className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-text-muted">
                {page.modified && (
                  <span title={[`Updated ${formatDocDate(page.modified)}`, page.created && `Created ${formatDocDate(page.created)}`].filter(Boolean).join(" · ")}>
                    Updated {formatRelativeTime(page.modified)}
                  </span>
                )}
                {page.modified && <span aria-hidden="true" className="text-text-faint">·</span>}
                <span>{readingMinutes} min read</span>
              </div>
              {page.tags.length > 0 && <div className="mt-3"><DocTagChips tags={page.tags} onSelect={shell.searchFor} /></div>}
            </header>

            {entryFields.length > 0 && (
              <dl className="mb-8 grid grid-cols-[minmax(6.5rem,auto)_minmax(0,1fr)] gap-x-6 gap-y-2.5 rounded-xl border border-border bg-bg-secondary/60 px-4 py-3.5 text-sm">
                {entryFields.map((field) => (
                  <div key={field.name} className="contents">
                    <dt className="py-0.5 text-text-muted">{dbFieldLabel(field.name)}</dt>
                    <dd className="min-w-0 py-0.5 text-text-primary"><DbValue field={field} value={page.frontmatter[field.name]} wrap /></dd>
                  </div>
                ))}
              </dl>
            )}

            {body.trim() ? (
              <DocsMarkdown
                markdown={body}
                headings={headings}
                // The root index page lives at "index" but its links are relative to the docs root.
                currentPath={page.isFolderIndex && page.path === "index" ? "" : page.path}
                currentIsDirectory={page.isFolderIndex}
                index={index}
                onAnchorSelect={handleAnchorSelect}
              />
            ) : (
              <div className={cx(DS.text.empty, "px-6 py-10 text-center")}>
                <FileText size={22} className="mx-auto text-text-faint" aria-hidden="true" />
                <p className="mt-3 text-sm text-text-muted">This page is empty.</p>
                <DocsButton variant="primary" icon={Pencil} onClick={onEdit} className="mt-4">Start writing</DocsButton>
              </div>
            )}

            {folderNode?.children && folderNode.children.length > 0 && (
              <section className="mt-12" aria-labelledby="docs-in-this-folder">
                <h2 id="docs-in-this-folder" className="mb-3 text-sm font-semibold text-text-secondary">In this folder</h2>
                <FolderChildList nodes={folderNode.children} />
              </section>
            )}

            {(neighbours.previous || neighbours.next) && (
              <nav aria-label="Previous and next page" className="mt-12 flex flex-col gap-3 sm:flex-row">
                {neighbours.previous ? <NeighbourLink page={neighbours.previous} direction="previous" /> : <div className="hidden flex-1 sm:block" />}
                {neighbours.next ? <NeighbourLink page={neighbours.next} direction="next" /> : <div className="hidden flex-1 sm:block" />}
              </nav>
            )}
          </article>

          {showRail && (
            <aside className="w-52 shrink-0" aria-label="On this page">
              <div className="sticky top-0 flex max-h-[calc(100dvh-3rem)] flex-col pb-8 pt-10">
                <h2 className="mb-2.5 shrink-0 text-xs font-semibold text-text-secondary">On this page</h2>
                <div className="docs-quiet-scroll relative min-h-0 flex-1 overflow-y-auto pb-2">
                  <DocsToc headings={contents} activeId={activeHeadingId} onSelect={(id) => handleAnchorSelect(id, "toc")} />
                </div>
              </div>
            </aside>
          )}
        </div>
      </div>

      {tocOpen && (
        <DocsDialog title="On this page" onClose={() => setTocOpen(false)} size="sm">
          <DocsToc
            variant="sheet"
            headings={contents}
            activeId={activeHeadingId}
            onSelect={(id) => {
              setTocOpen(false);
              // Let the sheet unmount first so its focus restore does not fight the scroll.
              window.requestAnimationFrame(() => handleAnchorSelect(id, "toc"));
            }}
          />
        </DocsDialog>
      )}

      {menuPosition && (
        <ContextMenu position={menuPosition} onClose={() => setMenuPosition(null)}>
          <CtxItem icon={<Link2 size={15} />} label="Copy link" onClick={() => { setMenuPosition(null); copy(getAppAbsoluteUrl(docsRoute(page.path)).toString(), "Link"); }} />
          <CtxItem icon={<Clipboard size={15} />} label="Copy page path" onClick={() => { setMenuPosition(null); copy(page.path, "Path"); }} />
          <CtxItem icon={<FileText size={15} />} label="Copy as Markdown" onClick={() => { setMenuPosition(null); copy(page.body, "Markdown"); }} />
          {!isMobile && (
            <CtxItem
              icon={wide ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
              label={wide ? "Use reading width" : "Use full width"}
              onClick={() => { setMenuPosition(null); setWide(!wide); }}
            />
          )}
          <CtxDivider />
          <CtxItem icon={<Trash2 size={15} />} label={page.isDbItem ? "Delete entry" : "Delete page"} className="text-error" onClick={() => { setMenuPosition(null); onDelete(); }} />
        </ContextMenu>
      )}
    </div>
  );
}
