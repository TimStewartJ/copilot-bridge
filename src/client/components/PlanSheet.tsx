import { useState, useEffect, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { fetchPlan } from "../api";

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
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
      />

      {/* Sheet */}
      <div className="relative w-full md:max-w-2xl md:mt-16 md:mb-16 max-h-[85vh] md:max-h-[80vh] bg-[#1a1a2e] rounded-t-2xl md:rounded-xl border border-[#2a2a4a] flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-[#2a2a4a] shrink-0">
          <h2 className="text-sm font-semibold text-gray-200">📋 Session Plan</h2>
          <div className="flex items-center gap-2">
            <button
              onClick={loadPlan}
              disabled={loading}
              className="text-gray-500 hover:text-gray-300 text-sm transition-colors disabled:opacity-30"
              aria-label="Refresh"
              title="Refresh plan"
            >
              <span className={loading ? "inline-block animate-spin" : ""}>↻</span>
            </button>
            <button
              onClick={onClose}
              className="text-gray-500 hover:text-gray-300 text-lg leading-none transition-colors"
              aria-label="Close"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loading && (
            <div className="text-indigo-400 italic animate-pulse">Loading plan...</div>
          )}
          {error && (
            <div className="text-red-400 text-sm">Failed to load plan: {error}</div>
          )}
          {!loading && !error && !content && (
            <div className="text-gray-500 text-sm">No plan found for this session.</div>
          )}
          {!loading && !error && content && (
            <div className="prose prose-invert prose-sm max-w-none
              prose-pre:bg-[#16213e] prose-pre:rounded-md prose-pre:p-3 prose-pre:text-xs prose-pre:overflow-x-auto prose-pre:max-w-full
              prose-code:text-indigo-300 prose-code:text-xs prose-code:font-mono
              prose-th:border prose-th:border-gray-600 prose-th:px-3 prose-th:py-1.5 prose-th:bg-[#16213e]
              prose-td:border prose-td:border-gray-600 prose-td:px-3 prose-td:py-1.5
              prose-table:block prose-table:overflow-x-auto prose-table:max-w-full
              prose-a:text-indigo-400 prose-a:no-underline hover:prose-a:underline
              prose-headings:mt-3 prose-headings:mb-1
              prose-p:my-1.5 prose-ul:my-1.5 prose-ol:my-1.5
              prose-li:my-0.5">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
