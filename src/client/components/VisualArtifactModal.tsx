import { useEffect, useRef, useState, type MouseEvent, type RefObject } from "react";
import type { VisualArtifact } from "../api";
import { Code2, Download, FileText, X } from "lucide-react";
import VisualArtifactRenderer from "./VisualArtifactRenderer";
import { hasVisualSource, useVisualSource } from "./useVisualSource";
import type { VisualViewport } from "./visualDisplay";

interface VisualArtifactModalProps {
  visual: VisualArtifact;
  onClose: () => void;
}

const TITLE_ID = "va-modal-title";
const RESIZE_DEBOUNCE_MS = 120;
const MIN_VIEWPORT_DELTA = 4;

const SOURCE_LABEL: Record<string, string> = {
  mermaid: "Diagram source",
  "vega-lite": "Vega-Lite spec",
  html: "HTML source",
};

type ActivePanel = "source" | "caption";

function useMeasuredViewport(): [RefObject<HTMLDivElement | null>, VisualViewport] {
  const ref = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<VisualViewport>({});

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const updateViewport = () => {
      if (cancelled) return;
      const width = Math.floor(el.clientWidth);
      const height = Math.floor(el.clientHeight);
      if (width <= 0 || height <= 0) return;

      setViewport((current) => {
        const widthDelta = Math.abs((current.width ?? 0) - width);
        const heightDelta = Math.abs((current.height ?? 0) - height);
        return current.width && current.height && widthDelta < MIN_VIEWPORT_DELTA && heightDelta < MIN_VIEWPORT_DELTA
          ? current
          : { width, height };
      });
    };

    updateViewport();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateViewport);
      return () => {
        cancelled = true;
        window.removeEventListener("resize", updateViewport);
      };
    }

    const observer = new ResizeObserver(() => {
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(updateViewport, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(el);

    return () => {
      cancelled = true;
      observer.disconnect();
      if (timeout) clearTimeout(timeout);
    };
  }, []);

  return [ref, viewport];
}

export default function VisualArtifactModal({ visual, onClose }: VisualArtifactModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [viewerRef, viewerViewport] = useMeasuredViewport();
  const [activePanel, setActivePanel] = useState<ActivePanel | null>(null);
  const sourceState = useVisualSource(visual);

  const hasSource = hasVisualSource(visual);
  const sourceLabel = SOURCE_LABEL[visual.kind] ?? "Source";
  const sourceOpen = activePanel === "source";
  const captionOpen = activePanel === "caption";

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  const handleOverlayClick = (e: MouseEvent) => {
    if (e.target === overlayRef.current) onClose();
  };

  const togglePanel = (panel: ActivePanel) => {
    setActivePanel((current) => current === panel ? null : panel);
  };

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-2 sm:p-4"
      onClick={handleOverlayClick}
      role="dialog"
      aria-modal="true"
      aria-labelledby={TITLE_ID}
    >
      <div className="relative flex h-[92vh] w-[96vw] max-w-[1800px] flex-col overflow-hidden rounded-xl bg-bg-surface shadow-2xl">
        <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2 sm:px-4">
          <span id={TITLE_ID} className="min-w-0 truncate text-sm font-medium text-text-primary">
            {visual.title}
          </span>
          <div className="flex shrink-0 items-center gap-1">
            {hasSource && (
              <button
                onClick={() => togglePanel("source")}
                className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs text-text-muted transition-colors hover:bg-bg-primary hover:text-text-primary"
                aria-label={sourceOpen ? `Hide ${sourceLabel}` : `View ${sourceLabel}`}
                aria-pressed={sourceOpen}
              >
                <Code2 size={13} />
                <span className="hidden sm:inline">{sourceOpen ? "Hide source" : "Source"}</span>
              </button>
            )}
            {visual.caption && (
              <button
                onClick={() => togglePanel("caption")}
                className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs text-text-muted transition-colors hover:bg-bg-primary hover:text-text-primary"
                aria-label={captionOpen ? "Hide caption" : "View caption"}
                aria-pressed={captionOpen}
              >
                <FileText size={13} />
                <span className="hidden sm:inline">{captionOpen ? "Hide caption" : "Caption"}</span>
              </button>
            )}
            <a
              href={visual.downloadUrl}
              download={visual.displayName}
              className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs text-text-muted transition-colors hover:bg-bg-primary hover:text-text-primary"
              aria-label={`Download ${visual.displayName}`}
            >
              <Download size={13} />
              <span className="hidden sm:inline">Download</span>
            </a>
            <button
              ref={closeButtonRef}
              onClick={onClose}
              className="rounded p-1 text-text-muted transition-colors hover:bg-bg-primary hover:text-text-primary"
              aria-label="Close"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col bg-bg-primary">
          <div className="min-h-0 flex-1 overflow-hidden p-2 sm:p-3">
            <div ref={viewerRef} className="h-full min-h-0 w-full overflow-hidden">
              <VisualArtifactRenderer visual={visual} mode="focus" viewport={viewerViewport} />
            </div>
          </div>

          {activePanel && (
            <div className="flex max-h-[34vh] shrink-0 flex-col border-t border-border bg-bg-surface">
              <div className="border-b border-border px-4 py-1.5 text-xs font-medium text-text-muted">
                {sourceOpen ? sourceLabel : "Caption"}
              </div>
              {sourceOpen ? (
                <pre className="min-h-0 flex-1 overflow-auto p-4 text-xs font-mono leading-relaxed text-text-primary whitespace-pre-wrap break-all">
                  {sourceState.loading
                    ? "Loading source..."
                    : sourceState.error
                      ? `Unable to load source: ${sourceState.error}`
                      : sourceState.source}
                </pre>
              ) : (
                <p className="min-h-0 flex-1 overflow-auto p-4 text-sm leading-relaxed whitespace-pre-wrap text-text-secondary">
                  {visual.caption}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
