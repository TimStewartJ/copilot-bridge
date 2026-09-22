import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { BookOpen, Clipboard, FileText, MessageSquare } from "lucide-react";
import type {
  BridgeSearchResponse,
  SearchChatHit,
  SearchKind,
  SearchScope,
} from "../../shared/search.js";
import { searchBridge, type Task, type Session } from "../api";
import FocusDialog from "../design/Dialog";
import SearchQueryInput, { getSearchFilterToken } from "./SearchQueryInput";
import { writeClipboardText } from "../lib/clipboard";
import { getAppAbsoluteUrl } from "../lib/app-url";
import { getSessionPath } from "../lib/session-path";
import useElementScrollRestoration from "../hooks/useElementScrollRestoration";
import { formatSearchExcerpt, getSearchHighlightTerms } from "../lib/search-text";
import { DS, cx } from "../design/tokens";
import { Button, SegmentedControl } from "../design/primitives";

const PAGE_SIZE = 20;
const SEARCH_DEBOUNCE_MS = 300;
const INDEXING_REFRESH_MS = 2_000;

function parseScope(value: string | null): SearchScope {
  return value === "task" || value === "session" ? value : "global";
}

function parseKind(value: string | null): SearchKind {
  return value === "chat" || value === "task" || value === "doc" ? value : "all";
}

function parseOffset(value: string | null): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function safeInternalPath(value: string | null | undefined, fallback: string): string {
  return value?.startsWith("/") && !value.startsWith("//") ? value : fallback;
}

function Highlight({ text, query }: { text: string; query: string }) {
  const terms = getSearchHighlightTerms(query);
  if (terms.length === 0) return text;
  const lowerText = text.toLocaleLowerCase();
  const ranges = terms.flatMap((term) => {
    const matches: Array<{ start: number; end: number }> = [];
    const lowerTerm = term.toLocaleLowerCase();
    let start = lowerText.indexOf(lowerTerm);
    while (start >= 0) {
      matches.push({ start, end: start + term.length });
      start = lowerText.indexOf(lowerTerm, start + Math.max(1, term.length));
    }
    return matches;
  }).sort((left, right) => left.start - right.start || right.end - left.end);
  const merged = ranges.reduce<Array<{ start: number; end: number }>>((result, range) => {
    const previous = result.at(-1);
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      result.push({ ...range });
    }
    return result;
  }, []);
  if (merged.length === 0) return text;
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const range of merged) {
    if (range.start > cursor) parts.push(text.slice(cursor, range.start));
    parts.push(<mark key={`${range.start}:${range.end}`} className="rounded-sm bg-surface-selected px-0.5 font-semibold text-text-primary">{text.slice(range.start, range.end)}</mark>);
    cursor = range.end;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

function formatDate(value?: string): string {
  if (!value) return "Date unavailable";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Date unavailable"
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function resultCount(response: BridgeSearchResponse | null): number {
  if (!response) return 0;
  return response.chats.total + response.tasks.total + response.docs.total;
}

function chatPath(
  hit: SearchChatHit,
  sourceEventId: string,
  returnTo: string,
  query: string,
  matchOffset: number,
): string {
  const path = getSessionPath({ sessionId: hit.sessionId, taskId: hit.taskId });
  const params = new URLSearchParams({
    message: sourceEventId,
    from: returnTo,
    search: query,
    matchOffset: String(matchOffset),
  });
  return `${path}?${params.toString()}`;
}

function chatHistoryPath(hit: SearchChatHit, returnTo: string): string {
  const path = getSessionPath({ sessionId: hit.sessionId, taskId: hit.taskId });
  const params = new URLSearchParams({ history: "1", from: returnTo });
  return `${path}?${params.toString()}`;
}

export default function SearchView({ tasks = [], sessions = [], onClose }: {
  tasks?: Task[];
  sessions?: Session[];
  onClose?: () => void;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const scope = parseScope(params.get("scope"));
  const kind = parseKind(params.get("kind"));
  const taskId = params.get("taskId") ?? undefined;
  const sessionId = params.get("sessionId") ?? undefined;
  const query = params.get("q") ?? "";
  const offset = parseOffset(params.get("offset"));
  const returnTo = safeInternalPath(params.get("from"), "/");
  const [draft, setDraft] = useState(query);
  const [response, setResponse] = useState<BridgeSearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [retryRevision, setRetryRevision] = useState(0);
  const [pollRevision, setPollRevision] = useState(0);
  const [responseKey, setResponseKey] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentSearchUrl = `${location.pathname}${location.search}`;
  const currentParams = params.toString();
  const requestKey = JSON.stringify({ query, scope, kind, taskId, sessionId, offset, retryRevision });
  const visibleResponse = responseKey === requestKey ? response : null;
  useElementScrollRestoration(scrollRef, {
    key: `bridge-search:${currentSearchUrl}`,
    enabled: !query.trim() || visibleResponse !== null,
  });

  useEffect(() => {
    setDraft((current) => current.trim() === query.trim() ? current : query);
  }, [query]);

  useEffect(() => {
    if (getSearchFilterToken(draft)) return;
    if (draft.trim() === query.trim()) return;
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null;
      const next = new URLSearchParams(currentParams);
      const normalized = draft.trim();
      if (normalized) next.set("q", normalized);
      else next.delete("q");
      next.delete("offset");
      setParams(next, { replace: true });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    };
  }, [currentParams, draft, query, setParams]);

  useEffect(() => {
    const normalized = query.trim();
    if (!normalized) {
      setResponse(null);
      setError(null);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    const preserveCurrentResponse = responseKey === requestKey && response !== null;
    setLoading(true);
    setError(null);
    if (!preserveCurrentResponse) {
      setResponse(null);
      setResponseKey(null);
    }
    void searchBridge({
      q: normalized,
      scope,
      taskId,
      sessionId,
      kind,
      limit: PAGE_SIZE,
      offset,
      refreshOnly: preserveCurrentResponse,
    }, { signal: controller.signal }).then((next) => {
      if (!controller.signal.aborted) {
        setResponse(next);
        setResponseKey(requestKey);
      }
    }, (reason: unknown) => {
      if (!controller.signal.aborted) {
        if (!preserveCurrentResponse) setResponse(null);
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [kind, offset, pollRevision, query, requestKey, retryRevision, scope, sessionId, taskId]);

  useEffect(() => {
    if (!(visibleResponse?.coverage.reconciling ?? (visibleResponse?.coverage.state === "indexing"))) return;
    const timer = setTimeout(() => {
      setPollRevision((current) => current + 1);
    }, INDEXING_REFRESH_MS);
    return () => clearTimeout(timer);
  }, [visibleResponse]);

  const total = resultCount(visibleResponse);
  const visibleCount = visibleResponse
    ? visibleResponse.chats.items.length + visibleResponse.tasks.items.length + visibleResponse.docs.items.length
    : 0;
  const sessionMatchCount = scope === "session"
    ? visibleResponse?.chats.items[0]?.matchCount ?? 0
    : 0;
  const sessionVisibleMatchCount = scope === "session"
    ? visibleResponse?.chats.items[0]?.matches.length ?? 0
    : 0;
  const hasNextPage = visibleResponse
    ? scope === "session"
      ? offset + sessionVisibleMatchCount < sessionMatchCount
      : [visibleResponse.chats.total, visibleResponse.tasks.total, visibleResponse.docs.total].some((sectionTotal) => offset + PAGE_SIZE < sectionTotal)
    : false;
  const historyUrl = useMemo(() => {
    const historyParams = new URLSearchParams();
    if (query.trim()) historyParams.set("historyQuery", query.trim());
    return `/dashboard/focus?${historyParams.toString()}#focus-history`;
  }, [query]);

  const updateParams = (updates: Record<string, string | null>) => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    const next = new URLSearchParams(params);
    if (!Object.hasOwn(updates, "q")) {
      if (draft.trim()) next.set("q", draft.trim());
      else next.delete("q");
    }
    for (const [key, value] of Object.entries(updates)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    setDraft(next.get("q") ?? "");
    setParams(next, { replace: true });
  };

  const goBack = () => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    if (onClose) onClose();
    else navigate(returnTo, { replace: true });
  };

  return (
    <FocusDialog title="Search Bridge" closeLabel="Close search" pending={false} onClose={goBack} size="wide" contained>
    <div data-testid="search-layout" className="flex min-h-0 flex-1 flex-col" onKeyDown={(event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      goBack();
    }}>
        <header className="z-10 shrink-0 space-y-3 border-b border-border px-4 pb-3 sm:px-5">
          <form onSubmit={(event) => {
            event.preventDefault();
            if (getSearchFilterToken(draft)) return;
            updateParams({ q: draft.trim() || null, offset: null });
          }}>
            <SearchQueryInput draft={draft} kind={kind} scope={scope} taskId={taskId} sessionId={sessionId} showTypeChip={false}
              tasks={tasks.map((task) => ({ id: task.id, title: task.title }))}
              sessions={sessions.map((session) => ({ id: session.sessionId, title: session.summary || session.sessionId }))}
              onChange={setDraft}
              onCommit={(text, filters) => {
                updateParams({ ...filters, q: text.trim() || null, offset: null });
                setDraft(text.trim() ? `${text.trim()} ` : "");
              }}
            />
          </form>
          <SegmentedControl
            ariaLabel="Search sources"
            value={kind}
            onChange={(value) => updateParams({ kind: value === "all" ? null : value, offset: null })}
            options={[
              { value: "all", label: "All" },
              { value: "chat", label: "Chats" },
              { value: "task", label: "Tasks" },
              { value: "doc", label: "Docs" },
            ]}
            size="sm"
          />
        </header>

      <div ref={scrollRef} data-testid="search-scroll" className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-4 py-4 sm:px-5">
        {!query.trim() && !loading && (
          <div className="py-5">
            <p className={DS.text.sectionTitle}>Find something you saved</p>
            <p className={cx(DS.text.prose, "mt-1")}>Search a phrase, task name, or topic. Choose a source above to narrow the results.</p>
          </div>
        )}
        {loading && <p role="status" className={DS.text.prose}>Searching saved Bridge content…</p>}
        {error && <div role="alert" className={cx(DS.notice.surface, "text-error")}>
          Search could not load: {error}
          <Button variant="ghost" size="sm" onClick={() => setRetryRevision((current) => current + 1)} className="ml-2">Retry</Button>
        </div>}
        {visibleResponse && <div className="space-y-3">
          {visibleResponse.coverage.state !== "ready" && <div role="status" className={cx(DS.notice.surface, "p-4 text-sm text-warning")}>
            {visibleResponse.coverage.state === "partial" ? "Search coverage is partial." : ""}
            {(visibleResponse.coverage.reconciling ?? (visibleResponse.coverage.state === "indexing")) ? " Search indexing is still in progress." : ""}
            {" "}{visibleResponse.coverage.indexedSessions} of {visibleResponse.coverage.totalSessions} chats indexed.
          </div>}
          {visibleResponse.coverage.errors.length > 0 && <div role="alert" className={cx(DS.notice.surface, "p-4 text-sm text-warning")}>
            Some sources could not be searched:
            <ul className="mt-2 list-disc pl-5">{visibleResponse.coverage.errors.map((coverageError) => <li key={coverageError}>{coverageError}</li>)}</ul>
          </div>}
          <p className={DS.text.prose} aria-live="polite">{total === 0
            ? "No matches in the searched coverage."
            : scope === "session"
              ? `${sessionMatchCount} matching message${sessionMatchCount === 1 ? "" : "s"} in this chat.`
              : `${total} result${total === 1 ? "" : "s"}.`}</p>
          {total === 0 && <p className={DS.text.prose}>Try fewer words, a different phrase, or another source.</p>}
        </div>}

        {visibleResponse && visibleResponse.chats.items.length > 0 && <section aria-labelledby="search-chats">
          <h3 id="search-chats" className={cx(DS.text.sectionLabel, "mb-2 flex items-center gap-2")}><MessageSquare size={14} /> Chats <span className="tabular-nums text-text-muted">({visibleResponse.chats.total})</span></h3>
          <div className={DS.surface.divided}>
          {visibleResponse.chats.items.map((hit) => {
            const titleTarget = hit.matches[0]
              ? chatPath(
                  hit,
                  hit.matches[0].sourceEventId,
                  currentSearchUrl,
                  query,
                  scope === "session" ? offset : 0,
                )
              : chatHistoryPath(hit, currentSearchUrl);
            return <article key={hit.sessionId} className="py-3 first:pt-0">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h3>
                  <button type="button" onClick={() => navigate(titleTarget)} className={cx(DS.focus, "min-h-10 rounded py-1 text-left text-sm font-medium text-text-primary hover:underline md:min-h-7")}>
                    <Highlight text={hit.title} query={query} />
                  </button>
                </h3>
                <p className="text-xs text-text-muted">{hit.taskTitle ? `Task: ${hit.taskTitle}` : "Quick chat"}{hit.archived ? " · Archived" : ""} · {hit.matches.length === 0 ? "Title match · no matching message text" : `${hit.matchCount} message match${hit.matchCount === 1 ? "" : "es"}`}</p>
              </div>
              <button type="button" onClick={() => updateParams({ scope: "session", sessionId: hit.sessionId, taskId: null, kind: null, offset: null })} className={cx(DS.button.base, DS.button.size.sm, DS.button.variant.ghost, "min-h-9 text-accent")}>Search whole chat</button>
            </div>
            <div className="mt-3 divide-y divide-border-subtle">
              {hit.matches.map((match) => {
                const target = chatPath(
                  hit,
                  match.sourceEventId,
                  currentSearchUrl,
                  query,
                  scope === "session" ? offset : 0,
                );
                return <div key={match.sourceEventId} className="py-3 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-text-muted">
                    <span>{match.role === "user" ? "You" : "Assistant"} · {formatDate(match.timestamp)}</span>
                    <button type="button" aria-label="Copy link to message" onClick={() => {
                      const canonical = getAppAbsoluteUrl(target);
                      canonical.searchParams.delete("from");
                      canonical.searchParams.delete("search");
                      canonical.searchParams.delete("matchOffset");
                      setCopyError(null);
                      void writeClipboardText(canonical.toString()).then(
                        () => setCopiedId(match.sourceEventId),
                        (reason: unknown) => setCopyError(reason instanceof Error ? reason.message : String(reason)),
                      );
                    }} className={cx(DS.button.base, DS.button.size.sm, DS.button.variant.ghost, "min-h-9 gap-1")}><Clipboard size={13} /> {copiedId === match.sourceEventId ? "Copied" : "Copy link"}</button>
                  </div>
                  <button type="button" onClick={() => navigate(target)} className={cx(DS.row.stacked, "mt-1 px-0 py-1.5 text-text-secondary")}>
                    <span className="block break-words leading-6 line-clamp-3"><Highlight text={match.snippet} query={query} /></span>
                  </button>
                </div>;
              })}
            </div>
            {hit.matches.length < hit.matchCount && scope !== "session" && <p className="mt-3 text-xs text-warning">Showing {hit.matches.length} of {hit.matchCount} matching messages. Additional matches are not loaded in this result page.</p>}
          </article>;
          })}
          </div>
        </section>}
        {copyError && <p role="alert" className="text-sm text-error">Could not copy the message link: {copyError}</p>}

        {visibleResponse && visibleResponse.tasks.items.length > 0 && <section aria-labelledby="search-tasks">
          <h3 id="search-tasks" className={cx(DS.text.sectionLabel, "mb-2 flex items-center gap-2")}><FileText size={14} /> Tasks <span className="tabular-nums text-text-muted">({visibleResponse.tasks.total})</span></h3>
          <div className={DS.surface.divided}>{visibleResponse.tasks.items.map((hit) => <div key={hit.taskId} className="py-1"><button type="button" onClick={() => navigate(`/tasks/${hit.taskId}`)} className={DS.row.stacked}>
            <span className="block text-sm font-medium text-text-primary"><Highlight text={hit.title} query={query} /></span>
            <span className="mt-1 block text-xs text-text-muted">{hit.archived ? "Archived task" : "Task"}</span>
            <span className="mt-1.5 block break-words leading-6 text-text-secondary line-clamp-3"><Highlight text={formatSearchExcerpt(hit.snippet, query)} query={query} /></span>
          </button></div>)}</div>
        </section>}

        {visibleResponse && visibleResponse.docs.items.length > 0 && <section aria-labelledby="search-docs">
          <h3 id="search-docs" className={cx(DS.text.sectionLabel, "mb-2 flex items-center gap-2")}><BookOpen size={14} /> Docs <span className="tabular-nums text-text-muted">({visibleResponse.docs.total})</span></h3>
          <div className={DS.surface.divided}>{visibleResponse.docs.items.map((hit) => <div key={hit.path} className="py-1"><button type="button" onClick={() => navigate(`/docs/${hit.path}`)} className={DS.row.stacked}>
            <span className="block text-sm font-medium text-text-primary"><Highlight text={hit.title} query={query} /></span>
            <span className="mt-1 block truncate text-xs text-text-muted">{hit.path}</span>
            <span className="mt-1.5 block break-words leading-6 text-text-secondary line-clamp-3"><Highlight text={formatSearchExcerpt(hit.snippet, query)} query={query} /></span>
          </button></div>)}</div>
        </section>}

        {query.trim() && <button type="button" onClick={() => navigate(historyUrl)} className={cx(DS.row.stacked, "text-accent")}>
          Search Focus History for “{query.trim()}”
        </button>}

        {visibleResponse && total > 0 && <nav aria-label="Search result pages" className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
          <button type="button" disabled={offset === 0} onClick={() => updateParams({ offset: offset > PAGE_SIZE ? String(offset - PAGE_SIZE) : null })} className={cx(DS.button.base, DS.button.size.sm, DS.button.variant.ghost, "disabled:opacity-40")}>Previous</button>
          <span className="text-xs text-text-muted">{scope === "session"
            ? `Showing ${sessionVisibleMatchCount > 0 ? `${offset + 1}–${offset + sessionVisibleMatchCount}` : "0"} of ${sessionMatchCount} matching messages`
            : `Showing ${visibleCount} result${visibleCount === 1 ? "" : "s"}${offset > 0 ? ` from section offset ${offset + 1}` : ""}`}</span>
          <button type="button" disabled={!hasNextPage} onClick={() => updateParams({ offset: String(offset + PAGE_SIZE) })} className={cx(DS.button.base, DS.button.size.sm, DS.button.variant.ghost, "disabled:opacity-40")}>Next</button>
        </nav>}
      </div>
      <footer className="shrink-0 border-t border-border px-4 py-2 sm:px-5">
        <details className={DS.details.root}>
          <summary className={cx(DS.details.summary, DS.row.touch, "text-xs text-text-secondary")}>Search tips and coverage</summary>
          <div className="space-y-1 pb-2 text-xs leading-relaxed text-text-secondary">
            <p>Use type:chat, type:task, type:doc, task: or chat: to filter. Use arrows and Enter to choose a suggestion.</p>
            <p>Searchable chat content includes visible user and assistant text. Tool logs, attachments, OCR, hidden instructions, and external pages are not searched. Search retrieves saved text only; it does not ask AI.</p>
          </div>
        </details>
      </footer>
    </div>
    </FocusDialog>
  );
}
