import { useState, useEffect, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { fetchPlan } from "../api";
import { ClipboardList, Loader2, RefreshCw, X } from "lucide-react";
import CodeBlock from "./CodeBlock";
import { APP_PROSE } from "./shared/prose-classes";
import EmptyState from "./shared/EmptyState";
import { LoadingSkeletonRegion, Skeleton, SkeletonText } from "./shared/Skeleton";

interface PlanSheetProps {
  sessionId: string;
  onClose: () => void;
  onRunFleet?: () => Promise<void>;
  runFleetDisabledReason?: string | null;
  isRunningFleet?: boolean;
}

export default function PlanSheet({
  sessionId,
  onClose,
  onRunFleet,
  runFleetDisabledReason = null,
  isRunningFleet = false,
}: PlanSheetProps) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [launchError, setLaunchError] = useState<string | null>(null);

  const loadPlan = useCallback(() => {
    setLoading(true);
    setError(null);
    setLaunchError(null);
    fetchPlan(sessionId)
      .then((data) => setContent(data.content))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [sessionId]);

  useEffect(() => { loadPlan(); }, [loadPlan]);

  const handleRunFleet = useCallback(async () => {
    if (!onRunFleet) return;
    setLaunchError(null);
    try {
      await onRunFleet();
      onClose();
    } catch (err) {
      setLaunchError(err instanceof Error ? err.message : String(err));
    }
  }, [onClose, onRunFleet]);

  const canRunFleet = Boolean(onRunFleet)
    && !loading
    && !error
    && Boolean(content)
    && !runFleetDisabledReason
    && !isRunningFleet;
  const helperText = launchError
    ? `Failed to start Fleet: ${launchError}`
    : runFleetDisabledReason
      ? runFleetDisabledReason
      : !content
        ? "Load a session plan before launching Fleet."
        : "Starts a parallel run from this plan. Best when independent tracks touch separate files.";

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-start md:justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60"
        onClick={onClose}
      />

      {/* Sheet */}
      <div className="relative w-full md:max-w-2xl md:mt-16 md:mb-16 max-h-[85vh] md:max-h-[80vh] bg-bg-primary rounded-t-2xl md:rounded-xl border border-border flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-border shrink-0">
          <h2 className="text-sm font-medium text-text-primary flex items-center gap-1.5">
            <ClipboardList size={14} className="text-text-muted" />
            Session Plan
          </h2>
          <div className="flex items-center gap-2">
            <button
              onClick={loadPlan}
              disabled={loading}
              className="text-text-muted hover:text-text-secondary transition-colors disabled:opacity-30"
              aria-label="Refresh"
              title="Refresh plan"
            >
              <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
            </button>
            <button
              onClick={onClose}
              className="text-text-muted hover:text-text-secondary transition-colors"
              aria-label="Close"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loading && (
            <LoadingSkeletonRegion isLoading label="Loading session plan" className="space-y-5">
              <div className="space-y-3">
                <Skeleton height={18} width="42%" shape="pill" />
                <SkeletonText lines={4} widths="paragraph" />
              </div>
              <div className="space-y-3">
                <Skeleton height={16} width="34%" shape="pill" />
                <SkeletonText lines={3} widths={["94%", "82%", "58%"]} />
              </div>
            </LoadingSkeletonRegion>
          )}
          {error && (
            <div className="text-error text-sm">Failed to load plan: {error}</div>
          )}
          {!loading && !error && !content && (
            <EmptyState
              message="No plan yet"
              sub="The agent creates a plan during complex tasks"
            />
          )}
          {!loading && !error && content && (
            <div className={`max-w-none ${APP_PROSE} prose-pre:bg-bg-secondary prose-th:bg-bg-secondary`}>
              <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={{ pre: CodeBlock }}>{content}</ReactMarkdown>
            </div>
          )}
        </div>
        <div className="shrink-0 border-t border-border px-5 py-4 bg-bg-secondary/40">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="rounded-full border border-accent/20 bg-accent/10 px-2 py-0.5 text-[11px] font-medium uppercase tracking-[0.14em] text-accent">
                  Experimental
                </span>
                <span className="text-sm text-text-secondary">Run this plan with Fleet</span>
              </div>
              <div className={`mt-1 text-xs ${launchError ? "text-error" : "text-text-muted"}`}>
                {helperText}
              </div>
            </div>
            <button
              type="button"
              onClick={handleRunFleet}
              disabled={!canRunFleet}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:bg-accent/30 disabled:text-white/80"
            >
              {isRunningFleet && <Loader2 size={14} className="animate-spin" />}
              {isRunningFleet ? "Starting Fleet…" : "Run with Fleet"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
