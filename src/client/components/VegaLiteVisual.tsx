import { useEffect, useRef, useState } from "react";
import type { VisualArtifact } from "../api";
import { useVisualSource } from "./useVisualSource";
import type { VisualDisplayMode, VisualViewport } from "./visualDisplay";

interface VegaLiteVisualProps {
  visual: VisualArtifact;
  mode?: VisualDisplayMode;
  viewport?: VisualViewport;
}

type VegaSpecObject = Record<string, unknown>;
type VegaEmbedResult = {
  finalize?: () => void;
  view?: { finalize: () => void };
};

const RESIZE_DEBOUNCE_MS = 120;
const MIN_WIDTH_DELTA = 8;
const MIN_RESPONSIVE_WIDTH = 120;
const MIN_RESPONSIVE_HEIGHT = 120;
const VIEWER_PADDING = 32;
const COMPOUND_SPEC_KEYS = ["layer", "hconcat", "vconcat", "concat", "facet", "repeat", "spec"] as const;

interface ResponsiveVegaOptions {
  width: number;
  height?: number;
  mode?: VisualDisplayMode;
}

export interface ResponsiveVegaSpecResult {
  spec: VegaSpecObject;
  injectedWidth: boolean;
  injectedHeight: boolean;
  injectedViewConfig: boolean;
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

function responsiveHeight(width: number, mode: VisualDisplayMode, height?: number): number {
  const fallbackMax = mode === "focus" ? 640 : 360;
  const availableMax = height && height > 0 ? Math.max(MIN_RESPONSIVE_HEIGHT, Math.floor(height)) : fallbackMax;
  const targetMin = mode === "focus" ? 320 : 180;
  const min = Math.min(targetMin, availableMax);
  return Math.round(Math.min(Math.max(width * 0.56, min), availableMax));
}

function withResponsiveViewConfig(
  spec: VegaSpecObject,
  width: number,
  height: number,
): { spec: VegaSpecObject; injected: boolean } {
  const config = isRecord(spec.config) ? { ...spec.config } : {};
  const view = isRecord(config.view) ? { ...config.view } : {};
  let injected = false;

  if (!hasOwn(view, "continuousWidth")) {
    view.continuousWidth = width;
    injected = true;
  }
  if (!hasOwn(view, "continuousHeight")) {
    view.continuousHeight = height;
    injected = true;
  }

  if (!injected) return { spec, injected: false };
  return {
    spec: {
      ...spec,
      config: {
        ...config,
        view,
      },
    },
    injected: true,
  };
}

export function prepareResponsiveVegaSpec(
  rawSpec: unknown,
  { width, height, mode = "inline" }: ResponsiveVegaOptions,
): ResponsiveVegaSpecResult {
  if (!isRecord(rawSpec)) throw new Error("Vega-Lite spec must be a JSON object");

  const spec = { ...rawSpec };
  const compound = isCompoundSpec(spec);
  if (width <= 0) {
    return {
      spec,
      injectedWidth: false,
      injectedHeight: false,
      injectedViewConfig: false,
      skippedCompound: compound,
    };
  }

  const measuredWidth = Math.max(MIN_RESPONSIVE_WIDTH, Math.floor(width));
  const measuredHeight = responsiveHeight(measuredWidth, mode, height);

  if (compound) {
    const configured = withResponsiveViewConfig(spec, measuredWidth, measuredHeight);
    return {
      spec: configured.spec,
      injectedWidth: false,
      injectedHeight: false,
      injectedViewConfig: configured.injected,
      skippedCompound: true,
    };
  }

  const injectedWidth = !hasOwn(spec, "width");
  const injectedHeight = !hasOwn(spec, "height");

  if (injectedWidth) spec.width = measuredWidth;
  if (injectedHeight) spec.height = measuredHeight;

  if ((injectedWidth || injectedHeight) && hasOwn(spec, "width") && hasOwn(spec, "height") && !hasOwn(spec, "autosize")) {
    spec.autosize = { type: "fit", contains: "padding" };
  }

  return {
    spec,
    injectedWidth,
    injectedHeight,
    injectedViewConfig: false,
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

function contentWidth(viewport?: VisualViewport): number | undefined {
  return viewport?.width ? Math.max(MIN_RESPONSIVE_WIDTH, Math.floor(viewport.width - VIEWER_PADDING)) : undefined;
}

function contentHeight(viewport?: VisualViewport): number | undefined {
  return viewport?.height ? Math.max(MIN_RESPONSIVE_HEIGHT, Math.floor(viewport.height - VIEWER_PADDING)) : undefined;
}

export default function VegaLiteVisual({ visual, mode = "inline", viewport }: VegaLiteVisualProps) {
  const measureRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const embedResultRef = useRef<VegaEmbedResult | null>(null);
  const renderTokenRef = useRef(0);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [rendered, setRendered] = useState(false);
  const [measuredWidth, setMeasuredWidth] = useState(0);

  const { source, loading: sourceLoading, error: sourceError } = useVisualSource(visual);
  const viewportWidth = contentWidth(viewport);
  const viewportHeight = contentHeight(viewport);
  const effectiveWidth = viewportWidth ?? measuredWidth;
  const focusMode = mode === "focus";

  useEffect(() => {
    if (viewportWidth) return;
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
  }, [viewportWidth]);

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
    if (effectiveWidth <= 0) return;

    let spec: VegaSpecObject;
    try {
      const parsed = JSON.parse(source);
      spec = prepareResponsiveVegaSpec(parsed, { width: effectiveWidth, height: viewportHeight, mode }).spec;
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
  }, [effectiveWidth, mode, source, sourceError, sourceLoading, viewportHeight]);

  return (
    <div className={`flex w-full min-w-0 flex-col ${focusMode ? "h-full min-h-0" : ""}`}>
      <div
        className={`w-full rounded-lg border border-border bg-white dark:bg-bg-primary overflow-auto p-4 ${
          focusMode ? "h-full min-h-0" : "min-h-[180px] max-h-[28rem]"
        }`}
        style={{ scrollbarGutter: "stable" }}
      >
        <div ref={measureRef} className="relative flex min-h-full w-full min-w-0 justify-center">
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
    </div>
  );
}
