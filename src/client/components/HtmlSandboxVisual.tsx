import { useState } from "react";
import { Copy, Download, Check } from "lucide-react";
import type { VisualArtifact } from "../api";
import { useVisualSource } from "./useVisualSource";

interface HtmlSandboxVisualProps {
  visual: VisualArtifact;
  /** When true, renders expanded (modal-style); otherwise compact card view */
  expanded?: boolean;
}

export default function HtmlSandboxVisual({ visual, expanded = false }: HtmlSandboxVisualProps) {
  const [copied, setCopied] = useState(false);

  const { source, loading: sourceLoading } = useVisualSource(visual);

  const handleCopy = async () => {
    if (!source) return;
    try {
      await navigator.clipboard.writeText(source);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard not available — ignore
    }
  };

  if (!source && !visual.url) {
    return (
      <div className="rounded-lg border border-border bg-bg-primary p-4 text-sm text-red-500" role="alert">
        HTML sandbox: content unavailable
      </div>
    );
  }

  return (
    <div className="flex w-full min-w-0 flex-col gap-2">
      {/* Sandbox label */}
      <div className="flex items-center gap-1.5">
        <span className="text-xs font-medium text-text-muted bg-bg-primary rounded px-1.5 py-0.5 border border-border">
          Interactive Sandbox
        </span>
      </div>

      {/* iframe sandbox area */}
      <div
        className={`w-full rounded-lg border border-border overflow-hidden bg-white ${
          expanded ? "min-h-[50vh]" : "min-h-[220px]"
        }`}
      >
        <iframe
          src={visual.url}
          sandbox="allow-scripts"
          title={visual.title}
          aria-label={visual.title}
          className="w-full h-full border-none"
          style={{ height: expanded ? "60vh" : 280, minHeight: expanded ? "50vh" : 220 }}
          loading="lazy"
        />
      </div>

      {/* Controls */}
      <div className="flex items-center gap-1 justify-end">
        {(source || sourceLoading) && (
          <button
            onClick={handleCopy}
            title="Copy HTML source"
            disabled={!source}
            className="flex items-center gap-1 px-2 py-1 text-xs rounded hover:bg-bg-primary text-text-muted hover:text-text-primary transition-colors"
            aria-label="Copy HTML source"
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
            {copied ? "Copied" : sourceLoading ? "Loading source" : "Copy source"}
          </button>
        )}
        <a
          href={visual.downloadUrl}
          download={visual.displayName}
          title={`Download ${visual.displayName}`}
          className="flex items-center gap-1 px-2 py-1 text-xs rounded hover:bg-bg-primary text-text-muted hover:text-text-primary transition-colors"
          aria-label={`Download ${visual.displayName}`}
        >
          <Download size={12} />
          Download
        </a>
      </div>

      {/* Caption */}
      {visual.caption && (
        <p className="text-xs text-text-muted leading-relaxed">{visual.caption}</p>
      )}
    </div>
  );
}
