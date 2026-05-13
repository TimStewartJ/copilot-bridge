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

function appendResponsiveSvgStyle(style: string): string {
  const trimmed = style.trim();
  const prefix = trimmed && !trimmed.endsWith(";") ? `${trimmed};` : trimmed;
  return `${prefix} width: 100%; max-width: 100%; height: auto;`;
}

export function makeMermaidSvgResponsive(svg: string): string {
  return svg.replace(/<svg\b([^>]*)>/i, (_match, attrs: string) => {
    const hasViewBox = /\sviewBox=(["']).*?\1/i.test(attrs);
    let nextAttrs = hasViewBox
      ? attrs
        .replace(/\swidth=(["']).*?\1/i, "")
        .replace(/\sheight=(["']).*?\1/i, "")
      : attrs;

    if (/\sstyle=/.test(nextAttrs)) {
      nextAttrs = nextAttrs.replace(
        /\sstyle=(["'])(.*?)\1/i,
        (_styleMatch, quote: string, style: string) => ` style=${quote}${appendResponsiveSvgStyle(style)}${quote}`,
      );
    } else {
      nextAttrs += ' style="width: 100%; max-width: 100%; height: auto;"';
    }

    return `<svg${nextAttrs}>`;
  });
}

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
  return makeMermaidSvgResponsive(svg);
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
    <div className="flex w-full min-w-0 flex-col gap-2">
      {/* Diagram render area */}
      <div
        className={`w-full rounded-lg border border-border bg-white dark:bg-bg-primary overflow-auto p-4 ${
          expanded ? "min-h-[40vh] max-h-[75vh]" : "min-h-[160px] max-h-96"
        }`}
      >
        {renderError ? (
          <div className="text-sm text-red-500 font-mono whitespace-pre-wrap max-w-full break-all" role="alert">
            Mermaid render error: {renderError}
          </div>
        ) : svg ? (
          <div
            className="w-full min-w-0"
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
