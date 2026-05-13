import { useEffect, useRef, useState } from "react";
import { Copy, Download, Check } from "lucide-react";
import type { VisualArtifact } from "../api";
import { useVisualSource } from "./useVisualSource";

interface VegaLiteVisualProps {
  visual: VisualArtifact;
  /** When true, renders expanded (modal-style); otherwise compact card view */
  expanded?: boolean;
}

type VegaSpecObject = Record<string, unknown>;
type VegaEmbedResult = {
  finalize?: () => void;
  view?: { finalize: () => void };
};

const RESIZE_DEBOUNCE_MS = 120;
const MIN_WIDTH_DELTA = 8;
const MIN_RESPONSIVE_WIDTH = 120;
const COMPOUND_SPEC_KEYS = ["layer", "hconcat", "vconcat", "concat", "facet", "repeat", "spec"] as const;

interface ResponsiveVegaOptions {
  width: number;
  expanded?: boolean;
}

export interface ResponsiveVegaSpecResult {
  spec: VegaSpecObject;
  injectedWidth: boolean;
  injectedHeight: boolean;
  skippedCompound: boolean;
}

function isRecord(value: unknown): value is VegaSpecObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: VegaSpecObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isCompoundSpec(spec: VegaSpecObject): boolean {
  return COMPOUND_SPEC_KEYS.some((key) => hasOwn(spec, key));
}

function responsiveHeight(width: number, expanded: boolean): number {
  const min = expanded ? 320 : 180;
  const max = expanded ? 640 : 360;
  return Math.round(Math.min(Math.max(width * 0.56, min), max));
}

export function prepareResponsiveVegaSpec(
  rawSpec: unknown,
  { width, expanded = false }: ResponsiveVegaOptions,
): ResponsiveVegaSpecResult {
  if (!isRecord(rawSpec)) throw new Error("Vega-Lite spec must be a JSON object");

  const spec = { ...rawSpec };
  if (width <= 0 || isCompoundSpec(spec)) {
    return {
      spec,
      injectedWidth: false,
      injectedHeight: false,
      skippedCompound: isCompoundSpec(spec),
    };
  }

  const measuredWidth = Math.max(MIN_RESPONSIVE_WIDTH, Math.floor(width));
  const injectedWidth = !hasOwn(spec, "width");
  const injectedHeight = !hasOwn(spec, "height");

  if (injectedWidth) spec.width = measuredWidth;
  if (injectedHeight) spec.height = responsiveHeight(measuredWidth, expanded);

  if ((injectedWidth || injectedHeight) && hasOwn(spec, "width") && hasOwn(spec, "height") && !hasOwn(spec, "autosize")) {
    spec.autosize = { type: "fit", contains: "padding" };
  }

  return {
    spec,
    injectedWidth,
    injectedHeight,
    skippedCompound: false,
  };
}

async function renderVegaLite(container: HTMLElement, spec: VegaSpecObject): Promise<VegaEmbedResult> {
  const vegaEmbed = (await import("vega-embed")).default;
  const result = await vegaEmbed(container, spec as Parameters<typeof vegaEmbed>[1], {
    actions: false,
    renderer: "canvas",
  });
  return result as VegaEmbedResult;
}

function finalizeVegaEmbed(result: VegaEmbedResult | null): void {
  if (!result) return;
  if (result.finalize) {
    result.finalize();
    return;
  }
  result.view?.finalize();
}

export default function VegaLiteVisual({ visual, expanded = false }: VegaLiteVisualProps) {
  const measureRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const embedResultRef = useRef<VegaEmbedResult | null>(null);
  const renderTokenRef = useRef(0);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [rendered, setRendered] = useState(false);
  const [copied, setCopied] = useState(false);
  const [measuredWidth, setMeasuredWidth] = useState(0);

  const { source, loading: sourceLoading, error: sourceError } = useVisualSource(visual);

  useEffect(() => {
    const el = measureRef.current;
    if (!el) return;

    let timeout: ReturnType<typeof setTimeout> | null = null;
    const updateWidth = () => {
      const nextWidth = Math.floor(el.clientWidth);
      if (nextWidth <= 0) return;
      setMeasuredWidth((current) => (
        current > 0 && Math.abs(current - nextWidth) < MIN_WIDTH_DELTA ? current : nextWidth
      ));
    };

    updateWidth();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateWidth);
      return () => {
        window.removeEventListener("resize", updateWidth);
      };
    }

    const observer = new ResizeObserver(() => {
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(updateWidth, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(el);

    return () => {
      observer.disconnect();
      if (timeout) clearTimeout(timeout);
    };
  }, []);

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
    if (measuredWidth <= 0) return;

    let spec: VegaSpecObject;
    try {
      const parsed = JSON.parse(source);
      spec = prepareResponsiveVegaSpec(parsed, { width: measuredWidth, expanded }).spec;
    } catch (err) {
      setRenderError(err instanceof SyntaxError ? "Vega-Lite spec is not valid JSON" : err instanceof Error ? err.message : String(err));
      return;
    }

    if (!containerRef.current) return;
    const el = containerRef.current;
    const token = renderTokenRef.current + 1;
    renderTokenRef.current = token;
    let cancelled = false;
    finalizeVegaEmbed(embedResultRef.current);
    embedResultRef.current = null;
    el.innerHTML = "";

    renderVegaLite(el, spec).then(
      (result) => {
        if (cancelled || renderTokenRef.current !== token) {
          finalizeVegaEmbed(result);
          return;
        }
        embedResultRef.current = result;
        setRendered(true);
      },
      (err) => {
        if (!cancelled) {
          setRenderError(err instanceof Error ? err.message : String(err));
        }
      },
    );

    return () => {
      cancelled = true;
      if (renderTokenRef.current === token) renderTokenRef.current = token + 1;
      finalizeVegaEmbed(embedResultRef.current);
      embedResultRef.current = null;
      if (el) el.innerHTML = "";
    };
  }, [expanded, measuredWidth, source, sourceError, sourceLoading]);

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
      {/* Chart render area */}
      <div
        className={`w-full rounded-lg border border-border bg-white dark:bg-bg-primary overflow-auto p-4 ${
          expanded ? "min-h-[40vh] max-h-[75vh]" : "min-h-[180px] max-h-[28rem]"
        }`}
        style={{ scrollbarGutter: "stable" }}
      >
        <div ref={measureRef} className="relative flex w-full min-w-0 justify-center">
          {renderError ? (
            <div className="text-sm text-red-500 font-mono whitespace-pre-wrap max-w-full break-all" role="alert">
              Vega-Lite render error: {renderError}
            </div>
          ) : (
            <>
            {!rendered && (
              <div className="text-xs text-text-muted animate-pulse absolute">
                {sourceLoading ? "Loading chart…" : "Rendering chart…"}
              </div>
            )}
            <div ref={containerRef} className="w-full min-w-0" />
            </>
          )}
        </div>
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
