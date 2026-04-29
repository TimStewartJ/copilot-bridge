import { useEffect, useRef, useState } from "react";
import { Copy, Download, Check } from "lucide-react";
import type { VisualArtifact } from "../api";
import { useVisualSource } from "./useVisualSource";

interface MermaidVisualProps {
  visual: VisualArtifact;
  /** When true, renders expanded (modal-style); otherwise compact card view */
  expanded?: boolean;
}

let mermaidConfigured = false;

async function renderMermaid(id: string, source: string): Promise<string> {
  const mermaid = (await import("mermaid")).default;
  if (!mermaidConfigured) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      htmlLabels: false,
    });
    mermaidConfigured = true;
  }
  const { svg } = await mermaid.render(id, source);
  return svg;
}

export default function MermaidVisual({ visual, expanded = false }: MermaidVisualProps) {
  const [svg, setSvg] = useState<string | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const idRef = useRef(`mermaid-${visual.artifactId.replace(/-/g, "")}`);

  const { source, loading: sourceLoading, error: sourceError } = useVisualSource(visual);

  useEffect(() => {
    setSvg(null);
    setRenderError(null);
    if (sourceLoading) return;
    if (sourceError) {
      setRenderError(sourceError);
      return;
    }
    if (!source.trim()) {
      setRenderError("Mermaid source is empty");
      return;
    }
    let cancelled = false;
    renderMermaid(idRef.current, source).then(
      (result) => { if (!cancelled) setSvg(result); },
      (err) => {
        if (!cancelled) {
          setRenderError(err instanceof Error ? err.message : String(err));
        }
      },
    );
    return () => { cancelled = true; };
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
      {/* Diagram render area */}
      <div
        className={`rounded-lg border border-border bg-white dark:bg-bg-primary overflow-auto flex items-center justify-center p-4 ${
          expanded ? "min-h-[40vh]" : "min-h-[120px] max-h-64"
        }`}
      >
        {renderError ? (
          <div className="text-sm text-red-500 font-mono whitespace-pre-wrap max-w-full break-all" role="alert">
            Mermaid render error: {renderError}
          </div>
        ) : svg ? (
          <div
            className="w-full h-full flex items-center justify-center"
            // eslint-disable-next-line react/no-danger
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        ) : (
          <div className="text-xs text-text-muted animate-pulse">
            {sourceLoading ? "Loading diagram…" : "Rendering diagram…"}
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="flex items-center gap-1 justify-end">
        <button
          onClick={handleCopy}
          title="Copy diagram source"
          className="flex items-center gap-1 px-2 py-1 text-xs rounded hover:bg-bg-primary text-text-muted hover:text-text-primary transition-colors"
          aria-label="Copy diagram source"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? "Copied" : "Copy source"}
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
