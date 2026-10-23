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

const EMPTY_SOURCE_STATE: VisualSourceState = { source: "", loading: false, error: null };

/**
 * The state a visual's source is in right now, before any fetch this render would start. A source
 * another view already fetched is ready at once, and one still to fetch reads as loading, so a
 * renderer never sees a passing empty source and mistakes it for an empty spec.
 */
function currentSourceState(
  kind: VisualArtifact["kind"],
  url: string | undefined,
  embeddedSource: string | undefined,
  enabled: boolean,
): VisualSourceState {
  if (kind === "image") return EMPTY_SOURCE_STATE;
  if (embeddedSource !== undefined) return { source: embeddedSource, loading: false, error: null };
  if (!enabled) return EMPTY_SOURCE_STATE;
  if (!url) return { source: "", loading: false, error: "Source is unavailable" };
  const cachedSource = sourceTextCache.get(url);
  if (cachedSource !== undefined) return { source: cachedSource, loading: false, error: null };
  return { source: "", loading: true, error: null };
}

function sameSourceState(a: VisualSourceState, b: VisualSourceState): boolean {
  return a.source === b.source && a.loading === b.loading && a.error === b.error;
}

export function useVisualSource(visual: VisualArtifact, options: UseVisualSourceOptions = {}): VisualSourceState {
  const enabled = options.enabled ?? true;
  const embeddedSource = visual.kind !== "image" && typeof visual.source === "string"
    ? visual.source
    : undefined;
  const { kind, url } = visual;
  const [state, setState] = useState<VisualSourceState>(() => currentSourceState(kind, url, embeddedSource, enabled));

  useEffect(() => {
    const next = currentSourceState(kind, url, embeddedSource, enabled);
    setState((current) => sameSourceState(current, next) ? current : next);
    if (!next.loading || !url) return;

    let cancelled = false;
    loadVisualSource(url).then(
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
  }, [embeddedSource, enabled, kind, url]);

  return state;
}
