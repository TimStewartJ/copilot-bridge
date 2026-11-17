// Rejects request fields an endpoint does not know, so a typo is an error instead of ignored.

export function findUnknownFields(input: unknown, allowedFields: readonly string[]): string[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];
  const allowed = new Set(allowedFields);
  return Object.keys(input as Record<string, unknown>)
    .filter((key) => !allowed.has(key))
    .sort();
}

export function formatUnknownFieldsError(fields: readonly string[]): string {
  return fields.length === 1
    ? `Unknown field: "${fields[0]}"`
    : `Unknown fields: ${fields.map((field) => `"${field}"`).join(", ")}`;
}
