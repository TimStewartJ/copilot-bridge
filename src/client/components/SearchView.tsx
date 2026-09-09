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
import FocusDialog from "./FocusDialog";
import SearchQueryInput, { getSearchFilterToken } from "./SearchQueryInput";
import { writeClipboardText } from "../lib/clipboard";
import { getAppAbsoluteUrl } from "../lib/app-url";
import { getSessionPath } from "../lib/session-path";
import useElementScrollRestoration from "../hooks/useElementScrollRestoration";
import { getSearchHighlightTerms } from "../lib/search-text";

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
    parts.push(<mark key={`${range.start}:${range.end}`} className="rounded-sm bg-warning/25 px-0.5 text-inherit">{text.slice(range.start, range.end)}</mark>);
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
    if (visibleResponse?.coverage.state !== "indexing") return;
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
    <FocusDialog title="Search Bridge" closeLabel="Close search" pending={false} onClose={goBack}>
    <div ref={scrollRef} data-testid="search-scroll" className="max-h-[70dvh] min-h-[min(55dvh,24rem)] overflow-y-auto bg-bg-primary text-text-primary" onKeyDown={(event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      goBack();
    }}>
      <div className="space-y-4">
        <header className="sticky top-0 z-10 space-y-2 bg-bg-primary pb-2">
          <form onSubmit={(event) => {
            event.preventDefault();
            if (getSearchFilterToken(draft)) return;
            updateParams({ q: draft.trim() || null, offset: null });
          }}>
            <SearchQueryInput draft={draft} kind={kind} scope={scope} taskId={taskId} sessionId={sessionId}
              tasks={tasks.map((task) => ({ id: task.id, title: task.title }))}
              sessions={sessions.map((session) => ({ id: session.sessionId, title: session.summary || session.sessionId }))}
              onChange={setDraft}
              onCommit={(text, filters) => {
                updateParams({ ...filters, q: text.trim() || null, offset: null });
                setDraft(text.trim() ? `${text.trim()} ` : "");
              }}
            />
          </form>
          <p className="text-xs text-text-muted">Filter with type:chat, type:task, type:doc, task: or chat:. Use arrows and Enter to choose.</p>
        </header>

        {loading && <p role="status" className="text-sm text-text-muted">Searching saved Bridge content…</p>}
        {error && <div role="alert" className="rounded-xl border border-error/30 bg-error/10 p-4 text-sm text-error">
          Search could not load: {error}
          <button type="button" onClick={() => setRetryRevision((current) => current + 1)} className="ml-2 underline">Retry</button>
        </div>}
        <details className="text-xs text-text-muted"><summary className="cursor-pointer">About saved-text search</summary><p className="mt-2">Searchable chat content includes visible user and assistant text. Tool logs, attachments, OCR, hidden instructions, and external pages are not searched. Search retrieves saved text only; it does not ask AI.</p></details>
        {visibleResponse && <div className="space-y-3">
          {visibleResponse.coverage.state !== "ready" && <div role="status" className="rounded-xl border border-warning/30 bg-warning/10 p-4 text-sm text-warning">
            {visibleResponse.coverage.state === "indexing" ? "Search indexing is still in progress." : "Search coverage is partial."}
            {" "}{visibleResponse.coverage.indexedSessions} of {visibleResponse.coverage.totalSessions} chats indexed.
          </div>}
          {visibleResponse.coverage.errors.length > 0 && <div role="alert" className="rounded-xl border border-warning/30 bg-warning/10 p-4 text-sm text-warning">
            Some sources could not be searched:
            <ul className="mt-2 list-disc pl-5">{visibleResponse.coverage.errors.map((coverageError) => <li key={coverageError}>{coverageError}</li>)}</ul>
          </div>}
          <p className="text-sm text-text-muted">{total === 0
            ? "No matches in the searched coverage."
            : scope === "session"
              ? `${sessionMatchCount} matching message${sessionMatchCount === 1 ? "" : "s"} in this chat.`
              : `${total} results across source sections.`}</p>
        </div>}

        {visibleResponse && visibleResponse.chats.items.length > 0 && <section aria-labelledby="search-chats" className="space-y-3">
          <h2 id="search-chats" className="flex items-center gap-2 text-lg font-semibold"><MessageSquare size={18} /> Chats <span className="text-sm font-normal text-text-muted">({visibleResponse.chats.total})</span></h2>
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
            return <article key={hit.sessionId} className="rounded-xl border border-border bg-bg-secondary p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h3>
                  <button type="button" onClick={() => navigate(titleTarget)} className="text-left font-semibold text-text-primary hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                    <Highlight text={hit.title} query={query} />
                  </button>
                </h3>
                <p className="text-xs text-text-muted">{hit.taskTitle ? `Task: ${hit.taskTitle}` : "Quick chat"}{hit.archived ? " · Archived" : ""} · {hit.matches.length === 0 ? "Title match · no matching message text" : `${hit.matchCount} message match${hit.matchCount === 1 ? "" : "es"}`}</p>
              </div>
              <button type="button" onClick={() => updateParams({ scope: "session", sessionId: hit.sessionId, taskId: null, kind: null, offset: null })} className="min-h-9 rounded-lg px-3 text-xs text-accent hover:bg-accent-surface">Search whole chat</button>
            </div>
            <div className="mt-3 divide-y divide-border/60">
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
                    }} className="inline-flex min-h-9 items-center gap-1 rounded-lg px-2 hover:bg-bg-hover"><Clipboard size={13} /> {copiedId === match.sourceEventId ? "Copied" : "Copy link"}</button>
                  </div>
                  <button type="button" onClick={() => navigate(target)} className="mt-1 w-full rounded-lg p-2 text-left text-sm leading-relaxed text-text-secondary hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                    <Highlight text={match.snippet} query={query} />
                  </button>
                </div>;
              })}
            </div>
            {hit.matches.length < hit.matchCount && scope !== "session" && <p className="mt-3 text-xs text-warning">Showing {hit.matches.length} of {hit.matchCount} matching messages. Additional matches are not loaded in this result page.</p>}
          </article>;
          })}
        </section>}
        {copyError && <p role="alert" className="text-sm text-error">Could not copy the message link: {copyError}</p>}

        {visibleResponse && visibleResponse.tasks.items.length > 0 && <section aria-labelledby="search-tasks" className="space-y-3">
          <h2 id="search-tasks" className="flex items-center gap-2 text-lg font-semibold"><FileText size={18} /> Tasks <span className="text-sm font-normal text-text-muted">({visibleResponse.tasks.total})</span></h2>
          <div className="grid gap-3">{visibleResponse.tasks.items.map((hit) => <button key={hit.taskId} type="button" onClick={() => navigate(`/tasks/${hit.taskId}`)} className="rounded-xl border border-border bg-bg-secondary p-4 text-left hover:bg-bg-hover">
            <h3 className="font-semibold"><Highlight text={hit.title} query={query} /></h3>
            <p className="mt-1 text-xs text-text-muted">{hit.archived ? "Archived task" : "Task"}</p>
            <p className="mt-2 text-sm text-text-secondary"><Highlight text={hit.snippet} query={query} /></p>
          </button>)}</div>
        </section>}

        {visibleResponse && visibleResponse.docs.items.length > 0 && <section aria-labelledby="search-docs" className="space-y-3">
          <h2 id="search-docs" className="flex items-center gap-2 text-lg font-semibold"><BookOpen size={18} /> Docs <span className="text-sm font-normal text-text-muted">({visibleResponse.docs.total})</span></h2>
          <div className="grid gap-3">{visibleResponse.docs.items.map((hit) => <button key={hit.path} type="button" onClick={() => navigate(`/docs/${hit.path}`)} className="rounded-xl border border-border bg-bg-secondary p-4 text-left hover:bg-bg-hover">
            <h3 className="font-semibold"><Highlight text={hit.title} query={query} /></h3>
            <p className="mt-1 text-xs text-text-muted">{hit.path}</p>
            <p className="mt-2 text-sm text-text-secondary"><Highlight text={hit.snippet} query={query} /></p>
          </button>)}</div>
        </section>}

        {query.trim() && <button type="button" onClick={() => navigate(historyUrl)} className="inline-flex min-h-11 items-center gap-2 text-sm text-accent underline underline-offset-2">
          Search Focus History for “{query.trim()}”
        </button>}

        {visibleResponse && total > 0 && <nav aria-label="Search result pages" className="flex items-center justify-between border-t border-border pt-4">
          <button type="button" disabled={offset === 0} onClick={() => updateParams({ offset: offset > PAGE_SIZE ? String(offset - PAGE_SIZE) : null })} className="min-h-11 rounded-lg px-4 text-sm disabled:opacity-40 hover:bg-bg-hover">Previous</button>
          <span className="text-xs text-text-muted">{scope === "session"
            ? `Showing ${sessionVisibleMatchCount > 0 ? `${offset + 1}–${offset + sessionVisibleMatchCount}` : "0"} of ${sessionMatchCount} matching messages`
            : `Showing ${visibleCount} result${visibleCount === 1 ? "" : "s"}${offset > 0 ? ` from section offset ${offset + 1}` : ""}`}</span>
          <button type="button" disabled={!hasNextPage} onClick={() => updateParams({ offset: String(offset + PAGE_SIZE) })} className="min-h-11 rounded-lg px-4 text-sm disabled:opacity-40 hover:bg-bg-hover">Next</button>
        </nav>}
      </div>
    </div>
    </FocusDialog>
  );
}
