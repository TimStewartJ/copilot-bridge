/** Reasoning effort levels, from least to most deliberate. */
export const REASONING_EFFORT_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

function rank(level: string): number {
  return (REASONING_EFFORT_LEVELS as readonly string[]).indexOf(level);
}

/** Requested level, else nearest below, else lowest; undefined means leave the model's setting. */
export function resolveSupportedReasoningEffort(
  requested: string | undefined,
  supported: readonly string[] | undefined,
): string | undefined {
  if (!requested || !supported?.length) return undefined;
  if (supported.includes(requested)) return requested;
  const requestedRank = rank(requested);
  if (requestedRank < 0) return undefined;
  const known = supported
    .map((level) => ({ level, rank: rank(level) }))
    .filter((entry) => entry.rank >= 0)
    .sort((a, b) => a.rank - b.rank);
  if (known.length === 0) return undefined;
  const atOrBelow = known.filter((entry) => entry.rank <= requestedRank).at(-1);
  return (atOrBelow ?? known[0]!).level;
}

/** Supported levels in canonical order, for pickers. Unknown levels keep their place at the end. */
export function sortReasoningEfforts(levels: readonly string[]): string[] {
  return [...levels].sort((a, b) => {
    const left = rank(a);
    const right = rank(b);
    if (left < 0 || right < 0) return left < 0 && right < 0 ? 0 : left < 0 ? 1 : -1;
    return left - right;
  });
}
