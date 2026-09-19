import { useMemo, type ReactNode } from "react";
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

function SectionHeading({ children }: { children: ReactNode }) {
  return <h2 className="mb-3 text-sm font-semibold text-text-secondary">{children}</h2>;
}

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
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-accent-surface text-accent">
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
                <h1 className="text-[1.75rem] font-semibold tracking-tight text-text-primary">Docs</h1>
                <p className="mt-1.5 text-sm text-text-muted">
                  {pluralize(stats.pages, "page")}
                  {stats.folders > 0 && ` in ${pluralize(stats.folders, "folder")}`}
                  {stats.collections > 0 && ` · ${pluralize(stats.collections, "collection")} with ${pluralize(stats.entries, "entry", "entries")}`}
                </p>
              </header>

              <button
                type="button"
                onClick={focusSearch}
                className="mt-6 flex h-11 w-full items-center gap-3 rounded-lg border border-border bg-bg-secondary px-3.5 text-left text-sm text-text-muted transition-colors hover:border-text-faint/60 hover:text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
              >
                <Search size={16} aria-hidden="true" />
                <span className="flex-1">Search titles, tags and page text</span>
                <Kbd>/</Kbd>
              </button>

              {lastViewed && (
                <Link
                  to={docsRoute(lastViewed.path)}
                  className="group mt-4 flex items-center gap-3 rounded-lg border border-border px-3.5 py-2.5 transition-colors hover:border-accent-border hover:bg-bg-secondary"
                >
                  <span className="shrink-0 text-xs text-text-muted">Continue reading</span>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary group-hover:text-accent">{lastViewed.title}</span>
                  <ChevronRight size={15} className="shrink-0 text-text-faint" aria-hidden="true" />
                </Link>
              )}

              {recent.length > 0 && (
                <section className="mt-10">
                  <SectionHeading>Recently updated</SectionHeading>
                  <ul className="divide-y divide-border-subtle overflow-hidden rounded-xl border border-border">
                    {recent.map((page) => {
                      const folder = index.folders.get(page.isEntry || page.folder !== page.path ? page.folder : parentPath(page.path));
                      return (
                        <li key={page.path}>
                          <Link to={docsRoute(page.path)} className="group flex items-start gap-4 px-4 py-3 transition-colors hover:bg-bg-secondary">
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
                </section>
              )}

              {sections.length > 0 && (
                <section className="mt-10">
                  <SectionHeading>Browse</SectionHeading>
                  <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {sections.map((section) => {
                      const Icon = section.kind === "collection" ? Database : Folder;
                      return (
                        <li key={section.node.path}>
                          <Link
                            to={docsRoute({ path: section.node.path, kind: section.kind })}
                            className="group flex h-full items-start gap-3 rounded-xl border border-border px-4 py-3.5 transition-colors hover:border-accent-border hover:bg-bg-secondary"
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
                </section>
              )}

              {topLevelPages.length > 0 && (
                <section className="mt-10">
                  <SectionHeading>Pages</SectionHeading>
                  <FolderChildList nodes={topLevelPages} />
                </section>
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
            <div className="rounded-xl border border-dashed border-border px-6 py-12 text-center">
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
