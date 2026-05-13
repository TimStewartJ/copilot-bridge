import { useState } from "react";
import type { VisualArtifact } from "../api";
import VisualArtifactModal from "./VisualArtifactModal";
import VisualArtifactRenderer from "./VisualArtifactRenderer";
import { Download, ZoomIn } from "lucide-react";

interface VisualArtifactCardProps {
  visual: VisualArtifact;
}

export default function VisualArtifactCard({ visual }: VisualArtifactCardProps) {
  const [modalOpen, setModalOpen] = useState(false);

  return (
    <>
      <div className="flex w-full min-w-0 flex-col gap-2">
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

        {visual.kind === "image" ? (
          <button
            onClick={() => setModalOpen(true)}
            className="flex w-full cursor-zoom-in justify-center rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            aria-label={`View full size: ${visual.title}`}
          >
            <VisualArtifactRenderer visual={visual} mode="inline" />
          </button>
        ) : (
          <VisualArtifactRenderer visual={visual} mode="inline" />
        )}

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
