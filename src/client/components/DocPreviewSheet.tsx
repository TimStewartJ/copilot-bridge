import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { BookOpen, ExternalLink, X } from "lucide-react";
import { fetchDocPage } from "../api";
import type { DocPage } from "../api";
import CodeBlock from "./CodeBlock";

interface DocPreviewSheetProps {
  docPath: string;
  onClose: () => void;
}

export default function DocPreviewSheet({ docPath, onClose }: DocPreviewSheetProps) {
  const navigate = useNavigate();
  const [doc, setDoc] = useState<DocPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetchDocPage(docPath)
      .then(setDoc)
      .catch(() => setError("Failed to load page"))
      .finally(() => setLoading(false));
  }, [docPath]);

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-start md:justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />

      {/* Sheet */}
      <div className="relative w-full md:max-w-2xl md:mt-16 md:mb-16 max-h-[85vh] md:max-h-[80vh] bg-bg-primary rounded-t-2xl md:rounded-xl border border-border flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-border shrink-0">
          <h2 className="text-sm font-medium text-text-primary flex items-center gap-1.5 min-w-0">
            <BookOpen size={14} className="text-text-muted shrink-0" />
            <span className="truncate">{doc?.title ?? docPath}</span>
          </h2>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => { onClose(); navigate(`/docs/${docPath}`); }}
              className="text-text-muted hover:text-accent transition-colors flex items-center gap-1 text-xs"
              title="Open in Docs"
            >
              <ExternalLink size={13} />
              <span className="hidden sm:inline">Open</span>
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

        {/* Path */}
        <div className="px-5 py-1.5 border-b border-border/50 shrink-0">
          <span className="text-[10px] font-mono text-text-faint">{docPath}</span>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loading && (
            <div className="text-center py-8 text-text-faint text-sm">Loading…</div>
          )}
          {error && (
            <div className="text-center py-8 text-red-400 text-sm">{error}</div>
          )}
          {doc && !loading && (
            <div className="prose prose-invert prose-sm max-w-none
              prose-pre:bg-bg-secondary prose-pre:rounded-md prose-pre:p-3 prose-pre:text-xs prose-pre:overflow-x-auto prose-pre:max-w-full
              prose-code:text-accent prose-code:text-xs prose-code:font-mono
              prose-th:border prose-th:border-border prose-th:px-3 prose-th:py-1.5 prose-th:bg-bg-secondary
              prose-td:border prose-td:border-border prose-td:px-3 prose-td:py-1.5
              prose-table:block prose-table:overflow-x-auto prose-table:max-w-full
              prose-a:text-accent prose-a:no-underline hover:prose-a:underline
              prose-headings:mt-3 prose-headings:mb-1
              prose-p:my-1.5 prose-ul:my-1.5 prose-ol:my-1.5
              prose-li:my-0.5"
            >
              <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={{ pre: CodeBlock }}>
                {doc.body}
              </ReactMarkdown>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
