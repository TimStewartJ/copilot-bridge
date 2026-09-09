export function getSearchHighlightTerms(query: string): string[] {
  const terms: string[] = [];
  const pattern = /"([^"]+)"|(\S+)/g;
  for (const match of query.matchAll(pattern)) {
    const term = (match[1] ?? match[2] ?? "").trim();
    if (term) terms.push(term);
  }
  return terms;
}

export function textMatchesSearchQuery(text: string, query: string): boolean {
  const lowerText = text.toLocaleLowerCase();
  const terms = getSearchHighlightTerms(query);
  return terms.length > 0 && terms.every((term) => lowerText.includes(term.toLocaleLowerCase()));
}
