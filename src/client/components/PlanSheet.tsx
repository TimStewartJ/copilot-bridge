import { useState, useEffect, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { fetchPlan } from "../api";
import { ClipboardList, RefreshCw, X } from "lucide-react";
import CodeBlock from "./CodeBlock";

interface PlanSheetProps {
  sessionId: string;
  onClose: () => void;
}

export default function PlanSheet({ sessionId, onClose }: PlanSheetProps) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadPlan = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchPlan(sessionId)
      .then((data) => setContent(data.content))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [sessionId]);

  useEffect(() => { loadPlan(); }, [loadPlan]);

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
            <div className="text-accent italic animate-pulse">Loading plan...</div>
          )}
          {error && (
            <div className="text-error text-sm">Failed to load plan: {error}</div>
          )}
          {!loading && !error && !content && (
            <div className="text-text-muted text-sm">No plan found for this session.</div>
          )}
          {!loading && !error && content && (
            <div className="prose prose-invert prose-sm max-w-none
              prose-pre:bg-bg-secondary prose-pre:rounded-md prose-pre:p-3 prose-pre:text-xs prose-pre:overflow-x-auto prose-pre:max-w-full
              prose-code:text-accent prose-code:text-xs prose-code:font-mono
              prose-th:border prose-th:border-border prose-th:px-3 prose-th:py-1.5 prose-th:bg-bg-secondary
              prose-td:border prose-td:border-border prose-td:px-3 prose-td:py-1.5
              prose-table:block prose-table:overflow-x-auto prose-table:max-w-full
              prose-a:text-accent prose-a:no-underline hover:prose-a:underline
              prose-headings:mt-3 prose-headings:mb-1
              prose-p:my-1.5 prose-ul:my-1.5 prose-ol:my-1.5
              prose-li:my-0.5">
              <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={{ pre: CodeBlock }}>{content}</ReactMarkdown>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
