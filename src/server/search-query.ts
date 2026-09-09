export interface ParsedSearchQuery {
  fts: string;
  keywords: string[];
}

export function parseSearchQuery(query: string): ParsedSearchQuery {
  const keywords: string[] = [];
  const pattern = /"([^"]+)"|(\S+)/g;
  for (const match of query.matchAll(pattern)) {
    const keyword = (match[1] ?? match[2] ?? "").trim();
    if (keyword) keywords.push(keyword);
  }

  return {
    keywords,
    fts: keywords
      .map((keyword) => `"${keyword.replaceAll('"', '""')}"`)
      .join(" "),
  };
}

export function createPlainSearchSnippet(content: string, keywords: readonly string[], maxLength = 240): string {
  const plain = content.replace(/\s+/g, " ").trim();
  if (plain.length <= maxLength) return plain;

  const lower = plain.toLocaleLowerCase();
  const firstMatch = keywords.reduce((earliest, keyword) => {
    const index = lower.indexOf(keyword.toLocaleLowerCase());
    return index >= 0 && (earliest < 0 || index < earliest) ? index : earliest;
  }, -1);
  const center = firstMatch >= 0 ? firstMatch : 0;
  const start = Math.max(0, Math.min(center - Math.floor(maxLength / 3), plain.length - maxLength));
  const end = Math.min(plain.length, start + maxLength);
  return `${start > 0 ? "..." : ""}${plain.slice(start, end)}${end < plain.length ? "..." : ""}`;
}
