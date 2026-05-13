import { useEffect, useRef, useState } from "react";
import type { VisualArtifact } from "../api";
import { useVisualSource } from "./useVisualSource";
import type { VisualDisplayMode, VisualViewport } from "./visualDisplay";

interface MermaidVisualProps {
  visual: VisualArtifact;
  mode?: VisualDisplayMode;
  viewport?: VisualViewport;
}

let mermaidConfigured = false;

function responsiveSvgStyle(mode: VisualDisplayMode, hasViewBox: boolean): string {
  if (mode === "focus" && hasViewBox) {
    return "width: 100%; height: 100%; max-width: 100%; max-height: 100%;";
  }
  if (mode === "focus") {
    return "max-width: 100%; max-height: 100%; width: auto; height: auto;";
  }
  return "width: 100%; max-width: 100%; height: auto;";
}

function appendResponsiveSvgStyle(style: string, mode: VisualDisplayMode, hasViewBox: boolean): string {
  const trimmed = style.trim();
  const prefix = trimmed && !trimmed.endsWith(";") ? `${trimmed};` : trimmed;
  return `${prefix} ${responsiveSvgStyle(mode, hasViewBox)}`.trim();
}

export function makeMermaidSvgResponsive(svg: string, mode: VisualDisplayMode = "inline"): string {
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
        (_styleMatch, quote: string, style: string) => ` style=${quote}${appendResponsiveSvgStyle(style, mode, hasViewBox)}${quote}`,
      );
    } else {
      nextAttrs += ` style="${responsiveSvgStyle(mode, hasViewBox)}"`;
    }

    return `<svg${nextAttrs}>`;
  });
}

async function renderMermaid(id: string, source: string, mode: VisualDisplayMode): Promise<string> {
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
  return makeMermaidSvgResponsive(svg, mode);
}

export default function MermaidVisual({ visual, mode = "inline", viewport }: MermaidVisualProps) {
  const [svg, setSvg] = useState<string | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const idRef = useRef(`mermaid-${mode}-${visual.artifactId.replace(/-/g, "")}`);
  const focusMode = mode === "focus";

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
    renderMermaid(idRef.current, source, mode).then(
      (result) => { if (!cancelled) setSvg(result); },
      (err) => {
        if (!cancelled) {
          setRenderError(err instanceof Error ? err.message : String(err));
        }
      },
    );
    return () => { cancelled = true; };
  }, [mode, source, sourceError, sourceLoading]);

  return (
    <div className={`flex w-full min-w-0 flex-col ${focusMode ? "h-full min-h-0" : ""}`}>
      <div
        className={`w-full rounded-lg border border-border bg-white dark:bg-bg-primary overflow-auto p-4 ${
          focusMode ? "flex h-full min-h-0 items-center justify-center" : "min-h-[160px] max-h-96"
        }`}
        style={focusMode && viewport?.height ? { maxHeight: viewport.height } : undefined}
      >
        {renderError ? (
          <div className="text-sm text-red-500 font-mono whitespace-pre-wrap max-w-full break-all" role="alert">
            Mermaid render error: {renderError}
          </div>
        ) : svg ? (
          <div
            className={focusMode ? "flex h-full min-h-0 w-full items-center justify-center" : "w-full min-w-0"}
            // eslint-disable-next-line react/no-danger
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        ) : (
          <div className="text-xs text-text-muted animate-pulse">
            {sourceLoading ? "Loading diagram…" : "Rendering diagram…"}
          </div>
        )}
      </div>
    </div>
  );
}
