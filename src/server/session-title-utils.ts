export function normalizeSessionTitle(rawTitle: unknown): string {
  return typeof rawTitle === "string"
    ? rawTitle.trim().replace(/^["']|["']$/g, "").replace(/\s+/g, " ")
    : "";
}
