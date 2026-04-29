import { useEffect, useState } from "react";
import type { VisualArtifact } from "../api";

export interface VisualSourceState {
  source: string;
  loading: boolean;
  error: string | null;
}

export function hasVisualSource(visual: VisualArtifact): boolean {
  return visual.kind !== "image" && Boolean(visual.source || visual.url);
}

export function useVisualSource(visual: VisualArtifact): VisualSourceState {
  const embeddedSource = visual.kind !== "image" && typeof visual.source === "string"
    ? visual.source
    : undefined;
  const [state, setState] = useState<VisualSourceState>({
    source: embeddedSource ?? "",
    loading: false,
    error: null,
  });

  useEffect(() => {
    if (visual.kind === "image") {
      setState({ source: "", loading: false, error: null });
      return;
    }

    if (embeddedSource !== undefined) {
      setState({ source: embeddedSource, loading: false, error: null });
      return;
    }

    if (!visual.url) {
      setState({ source: "", loading: false, error: "Source is unavailable" });
      return;
    }

    let cancelled = false;
    setState({ source: "", loading: true, error: null });

    fetch(visual.url).then(
      async (response) => {
        if (!response.ok) {
          throw new Error(`Failed to load source (${response.status})`);
        }
        return response.text();
      },
    ).then(
      (source) => {
        if (!cancelled) setState({ source, loading: false, error: null });
      },
      (error) => {
        if (!cancelled) {
          setState({
            source: "",
            loading: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, [embeddedSource, visual.kind, visual.url]);

  return state;
}
