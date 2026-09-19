import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowDown, ArrowUp, Database, Info, Plus, Search, SearchX, X } from "lucide-react";
import type { DbEntry, DbSchema } from "../../api";
import { LoadingSkeletonRegion, Skeleton } from "../shared/Skeleton";
import { DbValue } from "./DocsEntryFields";
import { DocsTopBar, useDocsShell } from "./docs-shell";
import { isNotFoundError, useDbCollectionQuery } from "./docs-queries";
import { loadDbSort, saveDbSort } from "./docs-storage";
import { cx, DocsBanner, DocsButton, DocsIconButton, DocsSelect } from "./docs-ui";
import {
  buildBreadcrumbs,
  dbFieldLabel,
  docsRoute,
  EMPTY_DB_FILTER,
  filterDbEntries,
  formatDocDate,
  formatRelativeTime,
  isDbFilterActive,
  nextDbSort,
  pluralize,
  selectFilterOptions,
  sortDbEntries,
  visibleDbFields,
  type DbFilterState,
  type DbSortState,
} from "./docs-model";

/** Beyond a few dropdowns the toolbar stops being scannable; the text filter covers the rest. */
const MAX_SELECT_FILTERS = 3;

function CollectionSkeleton() {
  return (
    <LoadingSkeletonRegion isLoading label="Loading collection" className="space-y-6 px-5 py-8 sm:px-8">
      <div className="flex items-center gap-3">
        <Skeleton width={40} height={40} shape="rounded" />
        <div className="space-y-2">
          <Skeleton width={220} height={20} shape="pill" />
          <Skeleton width={140} height={11} shape="pill" />
        </div>
      </div>
      <Skeleton height={36} width="100%" shape="rounded" />
      <div className="space-y-2.5">
        {Array.from({ length: 8 }, (_, row) => <Skeleton key={row} height={14} width={`${92 - (row % 4) * 9}%`} shape="pill" />)}
      </div>
    </LoadingSkeletonRegion>
  );
}

function SortableHeader({
  field,
  label,
  sort,
  onSort,
  align = "left",
}: {
  field: string;
  label: string;
  sort: DbSortState;
  onSort: (field: string) => void;
  align?: "left" | "right";
}) {
  const active = sort.field === field;
  const Arrow = sort.order === "asc" ? ArrowUp : ArrowDown;
  return (
    <th
      scope="col"
      aria-sort={active ? (sort.order === "asc" ? "ascending" : "descending") : "none"}
      className={cx("whitespace-nowrap border-b border-border bg-bg-secondary px-3.5 py-0 font-medium", align === "right" ? "text-right" : "text-left")}
    >
      <button
        type="button"
        onClick={() => onSort(field)}
        className={cx(
          "group inline-flex h-9 items-center gap-1 text-xs transition-colors hover:text-text-primary",
          active ? "text-text-primary" : "text-text-muted",
        )}
      >
        {label}
        <Arrow size={12} className={cx("transition-opacity", active ? "opacity-100" : "opacity-0 group-hover:opacity-40")} aria-hidden="true" />
      </button>
    </th>
  );
}

function EntryTable({ schema, entries, sort, onSort }: { schema: DbSchema; entries: DbEntry[]; sort: DbSortState; onSort: (field: string) => void }) {
  const { goTo } = useDocsShell();
  const fields = visibleDbFields(schema);
  return (
    <div className="min-h-0 shrink overflow-auto rounded-xl border border-border">
      <table className="w-full min-w-max border-separate border-spacing-0 text-[13px]">
        <thead className="sticky top-0 z-10">
          <tr>
            <SortableHeader field="title" label="Title" sort={sort} onSort={onSort} />
            {fields.map((field) => (
              <SortableHeader key={field.name} field={field.name} label={dbFieldLabel(field.name)} sort={sort} onSort={onSort} align={field.type === "number" ? "right" : "left"} />
            ))}
            <SortableHeader field="modified" label="Updated" sort={sort} onSort={onSort} />
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.path} onClick={() => goTo(entry.path)} className="group cursor-pointer transition-colors hover:bg-bg-secondary">
              <td className="max-w-[26rem] border-b border-border-subtle px-3.5 py-2.5 align-top font-medium text-text-primary">
                <Link
                  to={docsRoute(entry.path)}
                  onClick={(event) => event.stopPropagation()}
                  className="line-clamp-2 whitespace-normal break-words leading-5 group-hover:text-accent"
                >
                  {entry.title}
                </Link>
              </td>
              {fields.map((field) => (
                <td
                  key={field.name}
                  className={cx(
                    "border-b border-border-subtle px-3.5 py-2.5 align-top text-text-secondary",
                    field.type === "number" && "text-right",
                    field.type === "text" ? "max-w-[20rem]" : "whitespace-nowrap",
                  )}
                >
                  {field.type === "text"
                    ? <div className="line-clamp-2 whitespace-normal break-words leading-5"><DbValue field={field} value={entry.fields[field.name]} /></div>
                    : <DbValue field={field} value={entry.fields[field.name]} />}
                </td>
              ))}
              <td className="whitespace-nowrap border-b border-border-subtle px-3.5 py-2.5 align-top text-text-muted" title={formatDocDate(entry.modified)}>
                {formatRelativeTime(entry.modified) || "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EntryCards({ schema, entries }: { schema: DbSchema; entries: DbEntry[] }) {
  const fields = visibleDbFields(schema);
  return (
    <ul className="space-y-2.5 pb-6">
      {entries.map((entry) => {
        const filled = fields.filter((field) => {
          const value = entry.fields[field.name];
          return value != null && value !== "" && value !== false;
        });
        return (
          <li key={entry.path}>
            <Link to={docsRoute(entry.path)} className="block rounded-xl border border-border bg-bg-secondary/50 px-4 py-3 transition-colors active:bg-bg-hover">
              <div className="text-[15px] font-medium leading-5 text-text-primary">{entry.title}</div>
              {filled.length > 0 && (
                <dl className="mt-2.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[13px]">
                  {filled.slice(0, 5).map((field) => (
                    <div key={field.name} className="contents">
                      <dt className="text-text-muted">{dbFieldLabel(field.name)}</dt>
                      <dd className="min-w-0 truncate text-text-secondary"><DbValue field={field} value={entry.fields[field.name]} /></dd>
                    </div>
                  ))}
                </dl>
              )}
              <div className="mt-2.5 text-xs text-text-faint">Updated {formatRelativeTime(entry.modified) || "—"}</div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export interface DocsCollectionViewProps {
  folder: string;
  onMissing: ReactNode;
}

export default function DocsCollectionView({ folder, onMissing }: DocsCollectionViewProps) {
  const { index, isMobile, openNewEntry } = useDocsShell();
  const query = useDbCollectionQuery(folder);
  const [sort, setSort] = useState<DbSortState>(() => loadDbSort(folder));
  const [filter, setFilter] = useState<DbFilterState>(EMPTY_DB_FILTER);

  useEffect(() => {
    setSort(loadDbSort(folder));
    setFilter(EMPTY_DB_FILTER);
  }, [folder]);

  const schema = query.data?.schema ?? null;
  const entries = query.data?.entries ?? null;
  const node = index.folders.get(folder);
  const name = schema?.name ?? node?.title ?? folder;
  const crumbs = useMemo(() => buildBreadcrumbs(folder, index, name), [folder, index, name]);

  const selectFields = useMemo(
    () => (schema ? visibleDbFields(schema).filter((field) => field.type === "select").slice(0, MAX_SELECT_FILTERS) : []),
    [schema],
  );
  const visibleEntries = useMemo(() => {
    if (!schema || !entries) return [];
    return sortDbEntries(filterDbEntries(entries, schema, filter), sort, schema);
  }, [schema, entries, filter, sort]);

  const handleSort = (field: string) => {
    setSort((current) => {
      const next = nextDbSort(current, field);
      saveDbSort(folder, next);
      return next;
    });
  };

  if (query.isError && isNotFoundError(query.error)) return <>{onMissing}</>;

  const filtering = isDbFilterActive(filter);
  const newEntryAction = isMobile
    ? <DocsIconButton icon={Plus} label="New entry" onClick={() => openNewEntry(folder)} className="h-10 w-10" />
    : <DocsButton variant="primary" icon={Plus} onClick={() => openNewEntry(folder)}>New entry</DocsButton>;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <DocsTopBar crumbs={crumbs} title={name} actions={schema ? newEntryAction : undefined} />

      {query.isPending ? (
        <CollectionSkeleton />
      ) : query.isError || !schema || !entries ? (
        <div className="px-5 py-8 sm:px-8">
          <DocsBanner tone="error" actions={<DocsButton onClick={() => void query.refetch()}>Try again</DocsButton>}>
            This collection could not be loaded. {query.error instanceof Error ? query.error.message : ""}
          </DocsBanner>
        </div>
      ) : (
        <div className={cx("docs-content-in flex min-h-0 flex-1 flex-col px-4 pt-6 sm:px-8 sm:pt-8", isMobile ? "overflow-y-auto" : "pb-6")}>
          <div className="flex items-start gap-3.5">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent-surface text-accent">
              <Database size={19} aria-hidden="true" />
            </div>
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-xl font-semibold tracking-tight text-text-primary sm:text-2xl">{name}</h1>
              <p className="mt-0.5 text-[13px] text-text-muted">
                {pluralize(entries.length, "entry", "entries")} · {pluralize(schema.fields.length, "field")}
                {node?.hasIndex && (
                  <>
                    {" · "}
                    <Link to={docsRoute(folder)} className="inline-flex items-center gap-1 text-accent hover:underline">
                      <Info size={12} aria-hidden="true" />About this collection
                    </Link>
                  </>
                )}
              </p>
            </div>
          </div>

          {entries.length > 0 && (
            <div className="mt-5 flex flex-wrap items-center gap-2">
              <div className="relative min-w-[12rem] flex-1 sm:max-w-xs">
                <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-faint" aria-hidden="true" />
                <input
                  type="search"
                  value={filter.text}
                  onChange={(event) => setFilter((current) => ({ ...current, text: event.target.value }))}
                  placeholder="Filter entries…"
                  aria-label="Filter entries"
                  className="h-9 w-full rounded-md border border-border bg-bg-primary pl-9 pr-3 text-sm text-text-primary placeholder:text-text-faint transition-colors hover:border-text-faint/60 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25"
                />
              </div>
              {selectFields.map((field) => (
                <DocsSelect
                  key={field.name}
                  aria-label={`Filter by ${dbFieldLabel(field.name)}`}
                  value={filter.selects[field.name] ?? ""}
                  onChange={(event) => setFilter((current) => ({ ...current, selects: { ...current.selects, [field.name]: event.target.value } }))}
                  className={cx(isMobile ? "min-w-0 flex-1 basis-[9rem]" : "w-auto max-w-[11rem]", filter.selects[field.name] && "border-accent-border text-accent")}
                >
                  <option value="">{dbFieldLabel(field.name)}: any</option>
                  {selectFilterOptions(field, entries).map((option) => <option key={option} value={option}>{option}</option>)}
                </DocsSelect>
              ))}
              {isMobile && (
                <DocsSelect
                  aria-label="Sort entries"
                  value={`${sort.field}:${sort.order}`}
                  onChange={(event) => {
                    const at = event.target.value.lastIndexOf(":");
                    const next: DbSortState = { field: event.target.value.slice(0, at), order: event.target.value.slice(at + 1) === "asc" ? "asc" : "desc" };
                    setSort(next);
                    saveDbSort(folder, next);
                  }}
                  className="min-w-0 flex-1 basis-[9rem]"
                >
                  <option value="modified:desc">Recently updated</option>
                  <option value="modified:asc">Oldest first</option>
                  <option value="title:asc">Title A–Z</option>
                  <option value="title:desc">Title Z–A</option>
                  {visibleDbFields(schema).map((field) => [
                    <option key={`${field.name}:asc`} value={`${field.name}:asc`}>{dbFieldLabel(field.name)} ↑</option>,
                    <option key={`${field.name}:desc`} value={`${field.name}:desc`}>{dbFieldLabel(field.name)} ↓</option>,
                  ])}
                </DocsSelect>
              )}
              {filtering && (
                <>
                  <DocsButton variant="ghost" icon={X} onClick={() => setFilter(EMPTY_DB_FILTER)}>Clear</DocsButton>
                  <span className="text-xs text-text-muted" aria-live="polite">{visibleEntries.length} of {entries.length}</span>
                </>
              )}
            </div>
          )}

          <div className="mt-4 flex min-h-0 flex-1 flex-col">
            {entries.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border px-6 py-14 text-center">
                <Database size={22} className="mx-auto text-text-faint" aria-hidden="true" />
                <p className="mt-3 text-sm font-medium text-text-primary">No entries yet</p>
                <p className="mt-1 text-[13px] text-text-muted">Add the first one, or ask an agent to fill this collection in.</p>
                <DocsButton variant="primary" icon={Plus} onClick={() => openNewEntry(folder)} className="mt-4">New entry</DocsButton>
              </div>
            ) : visibleEntries.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border px-6 py-14 text-center">
                <SearchX size={22} className="mx-auto text-text-faint" aria-hidden="true" />
                <p className="mt-3 text-sm font-medium text-text-primary">No entries match these filters</p>
                <DocsButton onClick={() => setFilter(EMPTY_DB_FILTER)} className="mt-4">Clear filters</DocsButton>
              </div>
            ) : isMobile ? (
              <EntryCards schema={schema} entries={visibleEntries} />
            ) : (
              <EntryTable schema={schema} entries={visibleEntries} sort={sort} onSort={handleSort} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
