import { vi } from "vitest";

// vi.waitFor and vi.waitUntil poll every 50ms but default to a 1s budget, and
// Vitest has no config option to change that. Most waits here poll background
// work that does real filesystem, SQLite, or HTTP work, and the full suite runs
// with one worker per core while the live bridge and other validations share
// the machine. Under that load ordinary tests can stall for 10-24s. A polling
// budget is a hang guard, not a performance assertion: passing checks still
// return on the first satisfied poll. Keep it inside the shared test timeout so
// a real hang reports the last assertion error. Pass an explicit timeout to opt out.
export const WAIT_FOR_DEFAULT_TIMEOUT_MS = 20_000;

type WaitOptions = number | { timeout?: number; interval?: number } | undefined;

export function withDefaultTimeout(options: WaitOptions): number | { timeout: number; interval?: number } {
  if (typeof options === "number") return options;
  return { ...options, timeout: options?.timeout ?? WAIT_FOR_DEFAULT_TIMEOUT_MS };
}

const waitFor = vi.waitFor;
const waitUntil = vi.waitUntil;
vi.waitFor = ((callback, options) => waitFor(callback, withDefaultTimeout(options))) as typeof vi.waitFor;
vi.waitUntil = ((callback, options) => waitUntil(callback, withDefaultTimeout(options))) as typeof vi.waitUntil;
