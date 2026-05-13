import { useState } from "react";
import type { VisualArtifact } from "../api";
import VisualArtifactModal from "./VisualArtifactModal";
import MermaidVisual from "./MermaidVisual";
import VegaLiteVisual from "./VegaLiteVisual";
import HtmlSandboxVisual from "./HtmlSandboxVisual";
import { Download, ZoomIn } from "lucide-react";

interface VisualArtifactCardProps {
  visual: VisualArtifact;
}

export default function VisualArtifactCard({ visual }: VisualArtifactCardProps) {
  const [modalOpen, setModalOpen] = useState(false);

  if (visual.kind === "mermaid" || visual.kind === "vega-lite" || visual.kind === "html") {
    const Renderer = visual.kind === "mermaid" ? MermaidVisual
      : visual.kind === "vega-lite" ? VegaLiteVisual
      : HtmlSandboxVisual;
    return (
      <div className="flex w-full min-w-0 flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-text-primary truncate">{visual.title}</span>
          <button
            onClick={() => setModalOpen(true)}
            title="View full size"
            className="p-1 rounded hover:bg-bg-primary text-text-muted hover:text-text-primary transition-colors shrink-0"
            aria-label={`View full size: ${visual.title}`}
          >
            <ZoomIn size={14} />
          </button>
        </div>
        <Renderer visual={visual} />
        {modalOpen && (
          <VisualArtifactModal visual={visual} onClose={() => setModalOpen(false)} />
        )}
      </div>
    );
  }

  const altText = visual.altText ?? visual.title;

  return (
    <>
      <div className="flex w-full min-w-0 flex-col gap-2">
        {/* Title row */}
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-text-primary truncate">{visual.title}</span>
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => setModalOpen(true)}
              title="View full size"
              className="p-1 rounded hover:bg-bg-primary text-text-muted hover:text-text-primary transition-colors"
              aria-label={`View full size: ${visual.title}`}
            >
              <ZoomIn size={14} />
            </button>
            <a
              href={visual.downloadUrl}
              download={visual.displayName}
              title={`Download ${visual.displayName}`}
              className="p-1 rounded hover:bg-bg-primary text-text-muted hover:text-text-primary transition-colors"
              aria-label={`Download ${visual.displayName}`}
            >
              <Download size={14} />
            </a>
          </div>
        </div>

        {/* Image preview */}
        <button
          onClick={() => setModalOpen(true)}
          className="flex w-full justify-center focus:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-lg"
          aria-label={`View full size: ${visual.title}`}
        >
          <img
            src={visual.url}
            alt={altText}
            className="max-h-80 w-full rounded-lg border border-border object-contain bg-bg-primary cursor-zoom-in hover:opacity-95 transition-opacity"
          />
        </button>

        {/* Caption */}
        {visual.caption && (
          <p className="text-xs text-text-muted leading-relaxed">{visual.caption}</p>
        )}
      </div>

      {modalOpen && (
        <VisualArtifactModal visual={visual} onClose={() => setModalOpen(false)} />
      )}
    </>
  );
}
