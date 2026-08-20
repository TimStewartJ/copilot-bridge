import type { DeferLoopStore } from "./defer-loop-store.js";
import type { DeferredPromptStore } from "./deferred-prompt-store.js";
import type { GlobalBus } from "./global-bus.js";

/** Content-free defer indicator data for a single session. */
export interface DeferSummary {
  count: number;
  nextRunAt: string | null;
}

export interface DeferSummaryRow {
  count: number;
  nextRunAt: string | null;
}

export function normalizeDeferSummary(row: DeferSummaryRow | undefined): DeferSummary {
  return {
    count: Number(row?.count ?? 0),
    nextRunAt: row?.nextRunAt ?? null,
  };
}

export function mergeDeferSummaries(...summaries: DeferSummary[]): DeferSummary {
  return summaries.reduce<DeferSummary>(
    (merged, summary) => ({
      count: merged.count + summary.count,
      nextRunAt:
        summary.nextRunAt !== null && (merged.nextRunAt === null || summary.nextRunAt < merged.nextRunAt)
          ? summary.nextRunAt
          : merged.nextRunAt,
    }),
    { count: 0, nextRunAt: null },
  );
}

export interface DeferSummarySources {
  deferredPromptStore?: Pick<DeferredPromptStore, "getSummaryForSession">;
  deferLoopStore?: Pick<DeferLoopStore, "getSummaryForSession">;
}

export function getDeferSummaryForSession(sessionId: string, sources: DeferSummarySources): DeferSummary {
  return mergeDeferSummaries(
    sources.deferredPromptStore?.getSummaryForSession(sessionId) ?? { count: 0, nextRunAt: null },
    sources.deferLoopStore?.getSummaryForSession(sessionId) ?? { count: 0, nextRunAt: null },
  );
}

export interface DeferSummaryBulkSources {
  deferredPromptStore?: Pick<DeferredPromptStore, "listSummariesBySession">;
  deferLoopStore?: Pick<DeferLoopStore, "listSummariesBySession">;
}

const EMPTY_DEFER_SUMMARY: DeferSummary = { count: 0, nextRunAt: null };

/**
 * Snapshot both stores once so list-shaped callers can resolve thousands of
 * sessions without a per-session query. Returns a fresh object per lookup so
 * callers can embed it in DTOs safely.
 */
export function createDeferSummaryLookup(sources: DeferSummaryBulkSources): (sessionId: string) => DeferSummary {
  const prompts = sources.deferredPromptStore?.listSummariesBySession() ?? new Map<string, DeferSummary>();
  const loops = sources.deferLoopStore?.listSummariesBySession() ?? new Map<string, DeferSummary>();
  return (sessionId: string) => mergeDeferSummaries(
    prompts.get(sessionId) ?? EMPTY_DEFER_SUMMARY,
    loops.get(sessionId) ?? EMPTY_DEFER_SUMMARY,
  );
}

export function emitSessionDeferSummary(
  globalBus: GlobalBus,
  sessionId: string,
  sources: DeferSummarySources,
): void {
  globalBus.emit({
    type: "session:defer-summary",
    sessionId,
    deferSummary: getDeferSummaryForSession(sessionId, sources),
  });
}
