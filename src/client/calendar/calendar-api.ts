import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { API_BASE } from "../api";
import type { CalendarEvent, CalendarResponse } from "../../shared/calendar";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}/api/calendar${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => undefined) as { error?: string } | undefined;
    throw new Error(body?.error ?? res.statusText ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

/** The zone the browser shows times in; the server filters the window by its days. */
export function viewerTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** Every calendar query starts with this, so one invalidation refreshes them all. */
export const calendarRootKey = ["calendar"] as const;

export function fetchCalendar(from: string, to: string, options: { taskId?: string; signal?: AbortSignal } = {}): Promise<CalendarResponse> {
  const params = new URLSearchParams({ from, to, timezone: viewerTimeZone(), ...(options.taskId ? { taskId: options.taskId } : {}) });
  return request<CalendarResponse>(`?${params}`, { signal: options.signal });
}

export const fetchCalendarEvent = (id: string) => request<{ event: CalendarEvent }>(`/events/${encodeURIComponent(id)}`).then((body) => body.event);

export type CalendarEventInput = Partial<Omit<CalendarEvent, "id" | "createdBy" | "createdAt" | "updatedAt" | "repeat" | "location" | "notes" | "taskId">> & {
  repeat?: CalendarEvent["repeat"] | null;
  location?: string | null;
  notes?: string | null;
  taskId?: string | null;
};

export const createCalendarEvent = (input: CalendarEventInput) =>
  request<{ event: CalendarEvent }>("/events", { method: "POST", body: JSON.stringify(input) }).then((body) => body.event);
export const updateCalendarEvent = (id: string, input: CalendarEventInput) =>
  request<{ event: CalendarEvent }>(`/events/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(input) }).then((body) => body.event);
export const deleteCalendarEvent = (id: string) =>
  request<{ success: true }>(`/events/${encodeURIComponent(id)}`, { method: "DELETE" });

export function useCalendarQuery(from: string, to: string, options: { taskId?: string; enabled?: boolean } = {}) {
  const timezone = viewerTimeZone();
  return useQuery({
    queryKey: [...calendarRootKey, from, to, timezone, options.taskId ?? null],
    queryFn: ({ signal }) => fetchCalendar(from, to, { taskId: options.taskId, signal }),
    enabled: options.enabled ?? true,
    placeholderData: keepPreviousData,
    // Derived dates and run forecasts move with the clock; a minute is fresh enough.
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
}
