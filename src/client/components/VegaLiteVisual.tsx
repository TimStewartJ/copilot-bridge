import { useEffect, useRef, useState } from "react";
import { Copy, Download, Check } from "lucide-react";
import type { VisualArtifact } from "../api";
import { useVisualSource } from "./useVisualSource";

interface VegaLiteVisualProps {
  visual: VisualArtifact;
  /** When true, renders expanded (modal-style); otherwise compact card view */
  expanded?: boolean;
}

async function renderVegaLite(container: HTMLElement, spec: object): Promise<void> {
  const vegaEmbed = (await import("vega-embed")).default;
  await vegaEmbed(container, spec as any, {
    actions: false,
    renderer: "canvas",
  });
}

export default function VegaLiteVisual({ visual, expanded = false }: VegaLiteVisualProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [rendered, setRendered] = useState(false);
  const [copied, setCopied] = useState(false);

  const { source, loading: sourceLoading, error: sourceError } = useVisualSource(visual);

  useEffect(() => {
    setRenderError(null);
    setRendered(false);

    if (sourceLoading) return;
    if (sourceError) {
      setRenderError(sourceError);
      return;
    }
    if (!source.trim()) {
      setRenderError("Vega-Lite spec is empty");
      return;
    }

    let spec: object;
    try {
      spec = JSON.parse(source);
    } catch {
      setRenderError("Vega-Lite spec is not valid JSON");
      return;
    }

    if (!containerRef.current) return;
    const el = containerRef.current;
    let cancelled = false;

    renderVegaLite(el, spec).then(
      () => { if (!cancelled) setRendered(true); },
      (err) => {
        if (!cancelled) {
          setRenderError(err instanceof Error ? err.message : String(err));
        }
      },
    );

    return () => {
      cancelled = true;
      // Clear the container so stale renders don't persist
      if (el) el.innerHTML = "";
    };
  }, [source, sourceError, sourceLoading]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(source);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard not available — ignore
    }
  };

  return (
    <div className={`flex flex-col gap-2 ${expanded ? "w-full" : "max-w-lg"}`}>
      {/* Chart render area */}
      <div
        className={`rounded-lg border border-border bg-white dark:bg-bg-primary overflow-auto flex items-center justify-center p-4 ${
          expanded ? "min-h-[40vh]" : "min-h-[120px] max-h-80"
        }`}
      >
        {renderError ? (
          <div className="text-sm text-red-500 font-mono whitespace-pre-wrap max-w-full break-all" role="alert">
            Vega-Lite render error: {renderError}
          </div>
        ) : (
          <div className="relative w-full h-full flex items-center justify-center">
            {!rendered && (
              <div className="text-xs text-text-muted animate-pulse absolute">
                {sourceLoading ? "Loading chart…" : "Rendering chart…"}
              </div>
            )}
            <div ref={containerRef} className="w-full h-full flex items-center justify-center" />
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="flex items-center gap-1 justify-end">
        <button
          onClick={handleCopy}
          title="Copy chart spec"
          className="flex items-center gap-1 px-2 py-1 text-xs rounded hover:bg-bg-primary text-text-muted hover:text-text-primary transition-colors"
          aria-label="Copy chart spec"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? "Copied" : "Copy spec"}
        </button>
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
