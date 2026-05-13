import { useEffect, useState } from "react";
import type { VisualArtifact } from "../api";

export interface VisualSourceState {
  source: string;
  loading: boolean;
  error: string | null;
}

interface UseVisualSourceOptions {
  enabled?: boolean;
}

const sourceTextCache = new Map<string, string>();
const sourcePromiseCache = new Map<string, Promise<string>>();

function loadVisualSource(url: string): Promise<string> {
  const cachedSource = sourceTextCache.get(url);
  if (cachedSource !== undefined) return Promise.resolve(cachedSource);

  const cachedPromise = sourcePromiseCache.get(url);
  if (cachedPromise) return cachedPromise;

  const promise = fetch(url).then(async (response) => {
    if (!response.ok) {
      throw new Error(`Failed to load source (${response.status})`);
    }
    const source = await response.text();
    sourceTextCache.set(url, source);
    return source;
  }).finally(() => {
    sourcePromiseCache.delete(url);
  });

  sourcePromiseCache.set(url, promise);
  return promise;
}

export function hasVisualSource(visual: VisualArtifact): boolean {
  return visual.kind !== "image" && Boolean(visual.source || visual.url);
}

export function useVisualSource(visual: VisualArtifact, options: UseVisualSourceOptions = {}): VisualSourceState {
  const enabled = options.enabled ?? true;
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

    if (!enabled) {
      setState({ source: "", loading: false, error: null });
      return;
    }

    if (!visual.url) {
      setState({ source: "", loading: false, error: "Source is unavailable" });
      return;
    }

    let cancelled = false;
    setState({ source: "", loading: true, error: null });

    loadVisualSource(visual.url).then(
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
  }, [embeddedSource, enabled, visual.kind, visual.url]);

  return state;
}
