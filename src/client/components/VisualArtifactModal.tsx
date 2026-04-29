import { useEffect, useRef, useState } from "react";
import type { VisualArtifact } from "../api";
import { Code2, Download, X } from "lucide-react";
import MermaidVisual from "./MermaidVisual";
import VegaLiteVisual from "./VegaLiteVisual";
import HtmlSandboxVisual from "./HtmlSandboxVisual";
import { hasVisualSource, useVisualSource } from "./useVisualSource";

interface VisualArtifactModalProps {
  visual: VisualArtifact;
  onClose: () => void;
}

const TITLE_ID = "va-modal-title";

const SOURCE_LABEL: Record<string, string> = {
  mermaid: "Diagram source",
  "vega-lite": "Vega-Lite spec",
  html: "HTML source",
};

export default function VisualArtifactModal({ visual, onClose }: VisualArtifactModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [sourceOpen, setSourceOpen] = useState(false);
  const sourceState = useVisualSource(visual);

  const hasSource = hasVisualSource(visual);
  const sourceLabel = SOURCE_LABEL[visual.kind] ?? "Source";

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === overlayRef.current) onClose();
  };

  const altText = visual.altText ?? visual.title;

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={handleOverlayClick}
      role="dialog"
      aria-modal="true"
      aria-labelledby={TITLE_ID}
    >
      <div className="relative flex flex-col max-w-[90vw] max-h-[90vh] bg-bg-surface rounded-xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <span id={TITLE_ID} className="text-sm font-medium text-text-primary truncate max-w-[55vw]">
            {visual.title}
          </span>
          <div className="flex items-center gap-2 shrink-0">
            {hasSource && (
              <button
                onClick={() => setSourceOpen((v) => !v)}
                className="flex items-center gap-1.5 text-xs text-text-muted hover:text-text-primary transition-colors px-2 py-1 rounded hover:bg-bg-primary"
                aria-label={sourceOpen ? `Hide ${sourceLabel}` : `View ${sourceLabel}`}
                aria-pressed={sourceOpen}
              >
                <Code2 size={13} />
                {sourceOpen ? "Hide source" : "View source"}
              </button>
            )}
            <a
              href={visual.downloadUrl}
              download={visual.displayName}
              className="flex items-center gap-1.5 text-xs text-text-muted hover:text-text-primary transition-colors px-2 py-1 rounded hover:bg-bg-primary"
              aria-label={`Download ${visual.displayName}`}
            >
              <Download size={13} />
              Download
            </a>
            <button
              onClick={onClose}
              className="p-1 rounded hover:bg-bg-primary text-text-muted hover:text-text-primary transition-colors"
              aria-label="Close"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="overflow-auto flex-1 flex items-center justify-center p-4 bg-bg-primary">
          {visual.kind === "mermaid" ? (
            <MermaidVisual visual={visual} expanded />
          ) : visual.kind === "vega-lite" ? (
            <VegaLiteVisual visual={visual} expanded />
          ) : visual.kind === "html" ? (
            <HtmlSandboxVisual visual={visual} expanded />
          ) : (
            <img
              src={visual.url}
              alt={altText}
              className="max-w-full max-h-[75vh] object-contain"
            />
          )}
        </div>

        {/* Source panel */}
        {sourceOpen && hasSource && (
          <div className="border-t border-border bg-bg-surface shrink-0 flex flex-col max-h-[35vh]">
            <div className="px-4 py-1.5 text-xs font-medium text-text-muted border-b border-border">
              {sourceLabel}
            </div>
            <pre className="overflow-auto flex-1 p-4 text-xs font-mono text-text-primary whitespace-pre-wrap break-all leading-relaxed">
              {sourceState.loading
                ? "Loading source..."
                : sourceState.error
                  ? `Unable to load source: ${sourceState.error}`
                  : sourceState.source}
            </pre>
          </div>
        )}

        {/* Caption */}
        {visual.caption && (
          <div className="px-4 py-2 border-t border-border bg-bg-surface shrink-0">
            <p className="text-xs text-text-muted">{visual.caption}</p>
          </div>
        )}
      </div>
    </div>
  );
}
