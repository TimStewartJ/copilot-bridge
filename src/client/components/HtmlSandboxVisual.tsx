import type { VisualArtifact } from "../api";
import { useVisualSource } from "./useVisualSource";
import { HTML_SANDBOX_PERMISSIONS, type VisualDisplayMode, type VisualViewport } from "./visualDisplay";

interface HtmlSandboxVisualProps {
  visual: VisualArtifact;
  mode?: VisualDisplayMode;
  viewport?: VisualViewport;
}

export default function HtmlSandboxVisual({ visual, mode = "inline" }: HtmlSandboxVisualProps) {
  const needsSourceFallback = !visual.url;
  const { source, loading: sourceLoading } = useVisualSource(visual, { enabled: needsSourceFallback });
  const focusMode = mode === "focus";
  const hasFrameContent = Boolean(visual.url || source || sourceLoading);
  const iframeSourceProps = visual.url
    ? { src: visual.url }
    : source
      ? { srcDoc: source }
      : {};

  if (!hasFrameContent) {
    return (
      <div className="rounded-lg border border-border bg-bg-primary p-4 text-sm text-red-500" role="alert">
        HTML sandbox: content unavailable
      </div>
    );
  }

  return (
    <div className={`flex w-full min-w-0 flex-col ${focusMode ? "h-full min-h-0" : "gap-2"}`}>
      {!focusMode && (
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium text-text-muted bg-bg-primary rounded px-1.5 py-0.5 border border-border">
            Interactive Sandbox
          </span>
        </div>
      )}

      <div
        className={`w-full rounded-lg border border-border overflow-hidden bg-white ${
          focusMode ? "h-full min-h-0" : "min-h-[220px]"
        }`}
      >
        <iframe
          {...iframeSourceProps}
          sandbox={HTML_SANDBOX_PERMISSIONS}
          title={visual.title}
          aria-label={visual.title}
          className={`w-full border-none ${focusMode ? "h-full" : ""}`}
          style={focusMode ? undefined : { height: 280, minHeight: 220 }}
          loading="lazy"
        />
      </div>
    </div>
  );
}
