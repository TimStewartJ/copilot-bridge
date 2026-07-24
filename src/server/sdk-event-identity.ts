export function getSdkEventId(event: unknown): string | undefined {
  if (!event || typeof event !== "object") return undefined;
  const record = event as Record<string, unknown>;
  const value = record.id ?? record.eventId;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function getSdkTurnId(event: unknown): string | undefined {
  if (!event || typeof event !== "object") return undefined;
  const record = event as Record<string, unknown>;
  const data = record.data && typeof record.data === "object"
    ? record.data as Record<string, unknown>
    : undefined;
  const value = data?.turnId ?? record.turnId;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function getAssistantTurnInstanceId(event: unknown, fallback: string): string {
  // Persisted turn-start event ids keep replay and live grouping identical.
  return getSdkEventId(event) ?? fallback;
}
