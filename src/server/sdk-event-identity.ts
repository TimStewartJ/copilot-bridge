export function getSdkEventId(event: unknown): string | undefined {
  if (!event || typeof event !== "object") return undefined;
  const record = event as Record<string, unknown>;
  const value = record.id ?? record.eventId;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function getSdkAgentId(event: unknown): string | undefined {
  if (!event || typeof event !== "object") return undefined;
  const value = (event as Record<string, unknown>).agentId;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function isSdkSubagentSessionError(event: unknown): boolean {
  if (!event || typeof event !== "object") return false;
  return (event as Record<string, unknown>).type === "session.error"
    && getSdkAgentId(event) !== undefined;
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
