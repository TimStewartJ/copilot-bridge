import { useMemo } from "react";
import { Link } from "react-router-dom";
import { ChevronRight, Database, FilePlus, FileSearch, Folder, Library, Search } from "lucide-react";
import { getLastViewedDoc } from "../../last-viewed";
import { FolderChildList } from "./DocsPageView";
import { DocsTopBar, useDocsShell } from "./docs-shell";
import { DocsButton, DocsIconButton, Kbd } from "./docs-ui";
import {
  buildBreadcrumbs,
  docsRoute,
  formatDocDate,
  formatRelativeTime,
  lastSegment,
  nodeLabel,
  parentPath,
  pluralize,
  recentPages,
  summarizeFolders,
} from "./docs-model";
import { DS, cx } from "../../design/tokens";
import { Section } from "../../design/primitives";

/** Landing screen for the knowledge base when it has no root index page of its own. */
export function DocsHome() {
  const { index, openNewPage, focusSearch } = useDocsShell();
  const recent = useMemo(() => recentPages(index, 8), [index]);
  const sections = useMemo(() => summarizeFolders(index.roots), [index.roots]);
  const topLevelPages = useMemo(() => index.roots.filter((node) => node.type === "file"), [index.roots]);
  const { stats } = index;
  const isEmpty = stats.pages === 0 && stats.collections === 0;

  const lastViewed = useMemo(() => {
    const stored = getLastViewedDoc();
    if (!stored || stored.endsWith("?db")) return null;
    return index.pageByPath.get(stored) ?? null;
  }, [index]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <DocsTopBar crumbs={[]} title="Docs" actions={<DocsButton variant="primary" icon={FilePlus} onClick={() => openNewPage()}>New page</DocsButton>} />
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="docs-content-in mx-auto w-full max-w-[58rem] px-5 pb-24 pt-10 sm:px-8">
          {isEmpty ? (
            <div className="mx-auto mt-16 max-w-md text-center">
              <div className={"mx-auto flex h-12 w-12 items-center justify-center rounded-xl text-accent"}>
                <Library size={22} aria-hidden="true" />
              </div>
              <h1 className="mt-5 text-xl font-semibold tracking-tight text-text-primary">Your knowledge base is empty</h1>
              <p className="mt-2 text-sm leading-6 text-text-muted">
                Docs is where plans, runbooks and research live. Write a page yourself, or ask an agent to document what it learns; its pages show up here.
              </p>
              <DocsButton size="md" variant="primary" icon={FilePlus} onClick={() => openNewPage()} className="mt-6">Write the first page</DocsButton>
            </div>
          ) : (
            <>
              <header>
                <h1 className={DS.text.pageTitle}>Docs</h1>
                <p className="mt-1.5 text-sm text-text-muted">
                  {pluralize(stats.pages, "page")}
                  {stats.folders > 0 && ` in ${pluralize(stats.folders, "folder")}`}
                  {stats.collections > 0 && ` · ${pluralize(stats.collections, "collection")} with ${pluralize(stats.entries, "entry", "entries")}`}
                </p>
              </header>

              <button
                type="button"
                onClick={focusSearch}
                className={cx(DS.row.base, DS.row.interactive, DS.focus, "mt-6 h-11 w-full gap-3 border border-border bg-bg-secondary text-left text-text-muted hover:border-text-faint/60 hover:text-text-secondary", DS.row.touch)}
              >
                <Search size={16} aria-hidden="true" />
                <span className="flex-1">Search titles, tags and page text</span>
                <Kbd>/</Kbd>
              </button>

              {lastViewed && (
                <Link
                  to={docsRoute(lastViewed.path)}
                  className={cx(DS.row.base, DS.row.touch, DS.row.interactive, "group mt-4 gap-3 py-2.5")}
                >
                  <span className="shrink-0 text-xs text-text-muted">Continue reading</span>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary group-hover:text-accent">{lastViewed.title}</span>
                  <ChevronRight size={15} className="shrink-0 text-text-faint" aria-hidden="true" />
                </Link>
              )}

              {recent.length > 0 && (
                <Section label="Recently updated" level="page" className="mt-8">
                  <ul className={DS.surface.divided}>
                    {recent.map((page) => {
                      const folder = index.folders.get(page.isEntry || page.folder !== page.path ? page.folder : parentPath(page.path));
                      return (
                        <li key={page.path}>
                          <Link to={docsRoute(page.path)} className={cx(DS.row.base, DS.row.touch, DS.row.interactive, "group items-start gap-4 py-3")}>
                            <div className="min-w-0 flex-1">
                              <div className="flex min-w-0 items-baseline gap-2">
                                <span className="truncate text-sm font-medium text-text-primary group-hover:text-accent">{page.title}</span>
                                {folder && <span className="shrink-0 text-xs text-text-faint">{nodeLabel(folder)}</span>}
                              </div>
                              {page.description && <p className="mt-0.5 line-clamp-1 text-[13px] leading-5 text-text-muted">{page.description}</p>}
                            </div>
                            <span className="shrink-0 pt-0.5 text-xs text-text-faint" title={formatDocDate(page.modified)}>{formatRelativeTime(page.modified)}</span>
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                </Section>
              )}

              {sections.length > 0 && (
                <Section label="Browse" level="page" className="mt-8">
                  <ul className={DS.surface.divided}>
                    {sections.map((section) => {
                      const Icon = section.kind === "collection" ? Database : Folder;
                      return (
                        <li key={section.node.path}>
                          <Link
                            to={docsRoute({ path: section.node.path, kind: section.kind })}
                            className={cx(DS.row.base, DS.row.touch, DS.row.interactive, "group items-start gap-3 py-3")}
                          >
                            <Icon size={17} className={section.kind === "collection" ? "mt-0.5 shrink-0 text-accent" : "mt-0.5 shrink-0 text-text-muted"} aria-hidden="true" />
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-sm font-medium text-text-primary group-hover:text-accent">{section.label}</div>
                              <div className="mt-0.5 text-xs text-text-muted">
                                {section.kind === "collection"
                                  ? pluralize(section.node.children?.length ?? 0, "entry", "entries")
                                  : pluralize(section.itemCount, "page")}
                                {section.modified && ` · ${formatRelativeTime(section.modified)}`}
                              </div>
                            </div>
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                </Section>
              )}

              {topLevelPages.length > 0 && (
                <Section label="Pages" level="page" className="mt-8">
                  <FolderChildList nodes={topLevelPages} />
                </Section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Overview for a folder that has no index page of its own, so every breadcrumb leads somewhere. */
export function DocsFolderPage({ path }: { path: string }) {
  const { index, isMobile, openNewPage } = useDocsShell();
  const node = index.folders.get(path);
  const label = node ? nodeLabel(node) : path;
  const crumbs = useMemo(() => buildBreadcrumbs(path, index, label), [path, index, label]);
  const children = node?.children ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <DocsTopBar
        crumbs={crumbs}
        title={label}
        actions={isMobile
          ? <DocsIconButton icon={FilePlus} label="New page here" onClick={() => openNewPage(path)} className="h-10 w-10" />
          : <DocsButton icon={FilePlus} onClick={() => openNewPage(path)}>New page here</DocsButton>}
      />
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="docs-content-in mx-auto w-full max-w-[47rem] px-5 pb-24 pt-8 sm:px-8 sm:pt-10">
          <header className="mb-7 flex items-center gap-3.5">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-bg-surface text-text-secondary">
              <Folder size={19} aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-xl font-semibold tracking-tight text-text-primary sm:text-2xl">{label}</h1>
              <p className="mt-0.5 text-[13px] text-text-muted">{pluralize(children.length, "item")}</p>
            </div>
          </header>
          {children.length > 0 ? (
            <FolderChildList nodes={children} />
          ) : (
            <div className={cx(DS.text.empty, "px-6 py-12 text-center")}>
              <p className="text-sm text-text-muted">This folder is empty.</p>
              <DocsButton variant="primary" icon={FilePlus} onClick={() => openNewPage(path)} className="mt-4">New page here</DocsButton>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function DocsNotFound({ path, canCreate }: { path: string; canCreate: boolean }) {
  const { index, goHome, openNewPage } = useDocsShell();
  const crumbs = useMemo(() => buildBreadcrumbs(path, index), [path, index]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <DocsTopBar crumbs={crumbs} title="Page not found" />
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6 py-10">
        <div className="max-w-md text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-bg-surface text-text-muted">
            <FileSearch size={22} aria-hidden="true" />
          </div>
          <h1 className="mt-5 text-xl font-semibold tracking-tight text-text-primary">There is no page here</h1>
          <p className="mt-2 text-sm leading-6 text-text-muted">
            Nothing exists at <span className="break-all font-mono text-[13px] text-text-secondary">{path}</span>. It may have been moved, renamed or deleted.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            <DocsButton size="md" onClick={goHome}>Back to Docs</DocsButton>
            {canCreate && <DocsButton size="md" variant="primary" icon={FilePlus} onClick={() => openNewPage(parentPath(path), lastSegment(path))}>Create this page</DocsButton>}
          </div>
        </div>
      </div>
    </div>
  );
}

export function DocsLoadError({ path, message, onRetry }: { path: string; message: string; onRetry: () => void }) {
  const { index } = useDocsShell();
  const crumbs = useMemo(() => buildBreadcrumbs(path, index), [path, index]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <DocsTopBar crumbs={crumbs} title="Could not load" />
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 py-10">
        <div className="max-w-md text-center">
          <h1 className="text-lg font-semibold text-text-primary">This page could not be loaded</h1>
          <p className="mt-2 break-words text-sm leading-6 text-text-muted">{message}</p>
          <DocsButton size="md" variant="primary" onClick={onRetry} className="mt-5">Try again</DocsButton>
        </div>
      </div>
    </div>
  );
}
