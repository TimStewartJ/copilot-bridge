import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { FileText, X } from "lucide-react";

interface ToolResultModalProps {
  title: string;
  content: string;
  format?: "plain" | "markdown";
  onClose: () => void;
}

export default memo(function ToolResultModal({ title, content, format = "plain", onClose }: ToolResultModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-start md:justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />

      <div className="relative w-full md:max-w-2xl md:mt-16 md:mb-16 max-h-[85vh] md:max-h-[80vh] bg-bg-primary rounded-t-2xl md:rounded-xl border border-border flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-border shrink-0">
          <h2 className="text-sm font-medium text-text-primary flex items-center gap-1.5 truncate">
            <FileText size={14} className="text-text-muted shrink-0" />
            {title}
          </h2>
          <button
            onClick={onClose}
            className="text-text-muted hover:text-text-secondary transition-colors shrink-0 ml-2 cursor-pointer"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {format === "markdown" ? (
            <div className="prose prose-invert prose-sm max-w-none
              prose-pre:bg-bg-secondary prose-pre:rounded-md prose-pre:p-3 prose-pre:text-xs prose-pre:overflow-x-auto prose-pre:max-w-full
              prose-code:text-accent prose-code:text-xs prose-code:font-mono
              prose-a:text-accent prose-a:no-underline hover:prose-a:underline
              prose-headings:mt-3 prose-headings:mb-1
              prose-p:my-1.5 prose-ul:my-1.5 prose-ol:my-1.5
              prose-li:my-0.5">
              <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{content}</ReactMarkdown>
            </div>
          ) : (
            <pre className="text-text-muted whitespace-pre-wrap break-all text-xs font-mono">{content}</pre>
          )}
        </div>
      </div>
    </div>
  );
});
