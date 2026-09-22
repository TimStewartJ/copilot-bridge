export type RevisitState = "ready" | "today" | "upcoming" | null;

export function getRevisitState(value?: string, now = new Date()): RevisitState {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  if (parsed.getTime() > now.getTime()) return "upcoming";
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return parsed.getTime() < start.getTime() ? "ready" : "today";
}

export function formatRevisit(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  const date = parsed.toLocaleString(undefined, {
    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
  });
  const state = getRevisitState(value);
  return state === "ready" ? `${date} · ready to revisit` : state === "today" ? `${date} · revisit today` : date;
}

export function toDateTimeInputValue(value?: string): string {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  return new Date(parsed.getTime() - parsed.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function toDateTimeStorageValue(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error("Enter a valid revisit date and time.");
  return parsed.toISOString();
}
