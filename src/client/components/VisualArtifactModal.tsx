import { useEffect, useRef, useState, type RefObject } from "react";
import type { VisualArtifact } from "../api";
import { Code2, FileText } from "lucide-react";
import VisualArtifactRenderer from "./VisualArtifactRenderer";
import { hasVisualSource, useVisualSource } from "./useVisualSource";
import { describeVisualKind, type VisualViewport } from "./visualDisplay";
import { LIGHTBOX_BACKDROP_ATTR, LightboxDownload, LightboxShell } from "./LightboxShell";
import { formatFileSize } from "./ChatAttachments";
import { DS, cx } from "../design/tokens";

interface VisualArtifactModalProps {
  visual: VisualArtifact;
  onClose: () => void;
}

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
  const [viewerRef, viewerViewport] = useMeasuredViewport();
  const [activePanel, setActivePanel] = useState<ActivePanel | null>(null);
  const sourceState = useVisualSource(visual);

  const hasSource = hasVisualSource(visual);
  const sourceLabel = SOURCE_LABEL[visual.kind] ?? "Source";
  const sourceOpen = activePanel === "source";
  const captionOpen = activePanel === "caption";
  const isImage = visual.kind === "image";
  const { label: kindLabel } = describeVisualKind(visual.kind);

  const togglePanel = (panel: ActivePanel) => {
    setActivePanel((current) => current === panel ? null : panel);
  };

  const panelToggle = cx(DS.button.base, DS.button.size.sm, DS.button.variant.ghost);

  return (
    <LightboxShell
      title={visual.title}
      subtitle={[kindLabel, formatFileSize(visual.size)].filter(Boolean).join(" · ")}
      onClose={onClose}
      actions={(
        <>
          {hasSource && (
            <button
              type="button"
              onClick={() => togglePanel("source")}
              className={cx(panelToggle, sourceOpen && DS.surface.selected)}
              aria-label={sourceOpen ? `Hide ${sourceLabel}` : `View ${sourceLabel}`}
              aria-pressed={sourceOpen}
            >
              <Code2 size={15} aria-hidden="true" />
              <span className="hidden sm:inline">Source</span>
            </button>
          )}
          {visual.caption && (
            <button
              type="button"
              onClick={() => togglePanel("caption")}
              className={cx(panelToggle, captionOpen && DS.surface.selected)}
              aria-label={captionOpen ? "Hide caption" : "View caption"}
              aria-pressed={captionOpen}
            >
              <FileText size={15} aria-hidden="true" />
              <span className="hidden sm:inline">Caption</span>
            </button>
          )}
          <LightboxDownload href={visual.downloadUrl} fileName={visual.displayName} />
        </>
      )}
    >
      <div
        className="flex min-h-0 flex-1 flex-col px-2 pb-2 sm:px-6 sm:pb-6"
        {...{ [LIGHTBOX_BACKDROP_ATTR]: "" }}
      >
        <div
          className={cx(
            "flex min-h-0 flex-1 flex-col overflow-hidden",
            !isImage && "rounded-xl border border-surface-edge bg-surface-group",
          )}
          {...(isImage ? { [LIGHTBOX_BACKDROP_ATTR]: "" } : {})}
        >
          <div className={cx("min-h-0 flex-1 overflow-hidden", !isImage && "p-2 sm:p-3")}>
            <div ref={viewerRef} className="h-full min-h-0 w-full overflow-hidden" {...(isImage ? { [LIGHTBOX_BACKDROP_ATTR]: "" } : {})}>
              <VisualArtifactRenderer visual={visual} mode="focus" viewport={viewerViewport} />
            </div>
          </div>

          {activePanel && (
            <div
              className={cx(
                "flex max-h-[38vh] shrink-0 flex-col border-t border-surface-edge bg-surface-inset",
                DS.motion.reveal,
                isImage && "mt-3 rounded-xl border",
              )}
            >
              <div className="px-4 pb-1 pt-2.5 text-xs font-medium text-text-secondary">
                {sourceOpen ? sourceLabel : "Caption"}
              </div>
              {sourceOpen ? (
                <pre className="min-h-0 flex-1 overflow-auto px-4 pb-4 pt-1 font-mono text-xs leading-relaxed text-text-primary whitespace-pre-wrap break-all">
                  {sourceState.loading
                    ? "Loading source..."
                    : sourceState.error
                      ? `Unable to load source: ${sourceState.error}`
                      : sourceState.source}
                </pre>
              ) : (
                <p className="min-h-0 flex-1 overflow-auto px-4 pb-4 pt-1 text-sm leading-relaxed whitespace-pre-wrap text-text-secondary">
                  {visual.caption}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </LightboxShell>
  );
}
