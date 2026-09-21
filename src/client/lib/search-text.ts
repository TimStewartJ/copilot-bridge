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
import { stripMarkdownInline } from "../components/docs/docs-model";

/** Notes and documents are Markdown; chat excerpts stay literal so code matches are not rewritten. */
export function formatSearchExcerpt(text: string, query = ""): string {
  const plain = stripMarkdownInline(text
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-+*]\s+(?:\[[ xX]\]\s+)?)/gm, "")
    .replace(/```[^\r\n]*\r?\n/g, "")
    .replace(/(?:^|\s)\|(?:\s*:?-+:?\s*\|)+/g, " "));
  const original = text.toLocaleLowerCase();
  const cleaned = plain.toLocaleLowerCase();
  const removesMatch = getSearchHighlightTerms(query).some((term) => {
    const value = term.toLocaleLowerCase();
    return original.includes(value) && !cleaned.includes(value);
  });
  return removesMatch ? text : plain || text;
}
