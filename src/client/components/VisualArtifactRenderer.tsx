import type { VisualArtifact } from "../api";
import HtmlSandboxVisual from "./HtmlSandboxVisual";
import MermaidVisual from "./MermaidVisual";
import VegaLiteVisual from "./VegaLiteVisual";
import type { VisualDisplayMode, VisualViewport } from "./visualDisplay";

interface VisualArtifactRendererProps {
  visual: VisualArtifact;
  mode: VisualDisplayMode;
  viewport?: VisualViewport;
}

function ImageVisual({ visual, mode }: VisualArtifactRendererProps) {
  const altText = visual.altText ?? visual.title;

  if (mode === "focus") {
    return (
      <div
        className="flex h-full min-h-0 w-full items-center justify-center overflow-auto bg-bg-primary"
      >
        <img
          src={visual.url}
          alt={altText}
          className="max-h-full max-w-full object-contain"
        />
      </div>
    );
  }

  return (
    <img
      src={visual.url}
      alt={altText}
      className="max-h-80 w-full rounded-lg border border-border bg-bg-primary object-contain transition-opacity hover:opacity-95"
    />
  );
}

export default function VisualArtifactRenderer({ visual, mode, viewport }: VisualArtifactRendererProps) {
  if (visual.kind === "mermaid") {
    return <MermaidVisual visual={visual} mode={mode} viewport={viewport} />;
  }
  if (visual.kind === "vega-lite") {
    return <VegaLiteVisual visual={visual} mode={mode} viewport={viewport} />;
  }
  if (visual.kind === "html") {
    return <HtmlSandboxVisual visual={visual} mode={mode} viewport={viewport} />;
  }
  return <ImageVisual visual={visual} mode={mode} viewport={viewport} />;
}
