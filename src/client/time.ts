/** Shared time formatting utility */

export function timeAgo(dateStr?: string): string {
  if (!dateStr) return "";
  const diff = Date.now() - new Date(dateStr).getTime();
  if (diff < 0) {
    const absDiff = -diff;
    if (absDiff < 60_000) return "in <1m";
    if (absDiff < 3_600_000) return `in ${Math.round(absDiff / 60_000)}m`;
    if (absDiff < 86_400_000) return `in ${Math.round(absDiff / 3_600_000)}h`;
    return `in ${Math.round(absDiff / 86_400_000)}d`;
  }
  if (diff < 60_000) return "<1m ago";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}
