import { createElement } from "react";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invalidateFocusProtectionQueries } from "./lib/focus-query-invalidation";
import { queryKeys } from "./queryClient";
import { createReactDomHarness, type ReactDomHarness } from "./test-react-harness";
import { useStatusStream, type StatusEvent } from "./useStatusStream";

vi.mock("./api", () => ({ API_BASE: "/staging/protection" }));

class TestEventSource {
  static current: TestEventSource;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();
  constructor(readonly url: string) { TestEventSource.current = this; }
}

let harness: ReactDomHarness;
let client: QueryClient;

beforeEach(async () => {
  vi.stubGlobal("EventSource", TestEventSource);
  harness = await createReactDomHarness();
  client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } });
});
afterEach(async () => { await harness.cleanup(); client.clear(); vi.unstubAllGlobals(); });

describe("Focus protection status-stream messages", () => {
  it.each(["focus:protection-changed", "focus:protection-cleared"] as const)("delivers %s and invalidates server-derived protection and admitted work", async (type) => {
    const keys = [
      queryKeys.focusProtectionCurrent, queryKeys.focusProtectionHistory, queryKeys.focusSnapshot,
      queryKeys.focusDeliveries, queryKeys.sessions(), queryKeys.taskSchedules("task-1"),
    ];
    for (const key of keys) client.setQueryData(key, "last known");
    client.setQueryData(queryKeys.settings, "settings");
    const events: StatusEvent[] = [];
    let invalidation: Promise<void> | undefined;
    function Probe() {
      useStatusStream((event) => {
        events.push(event);
        if (event.type === "focus:protection-changed" || event.type === "focus:protection-cleared") {
          invalidation = invalidateFocusProtectionQueries(client);
        }
      });
      return null;
    }
    await harness.render(createElement(Probe));
    const event: StatusEvent = { type, protectionWindowId: "protection-1", reason: "server-boundary" };
    await harness.act(async () => {
      TestEventSource.current.onmessage?.({ data: JSON.stringify(event) });
      await invalidation;
    });
    expect(TestEventSource.current.url).toBe("/staging/protection/api/status-stream");
    expect(events).toEqual([event]);
    for (const key of keys) {
      expect(client.getQueryState(key)?.isInvalidated, JSON.stringify(key)).toBe(true);
      expect(client.getQueryData(key)).toBe("last known");
    }
    expect(client.getQueryState(queryKeys.settings)?.isInvalidated).toBe(false);
    await harness.render(null);
    expect(TestEventSource.current.close).toHaveBeenCalledOnce();
  });
});
