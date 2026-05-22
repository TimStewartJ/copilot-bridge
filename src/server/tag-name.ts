export function normalizeTagNameKey(name: string): string {
  return name.normalize("NFC").toUpperCase();
}

export function tagNamesMatch(a: string, b: string): boolean {
  return normalizeTagNameKey(a) === normalizeTagNameKey(b);
}
