export interface ClientTelemetrySpan {
  name: string;
  duration: number;
  sessionId?: string;
  metadata?: Record<string, unknown>;
}

interface QueuedTelemetrySpan extends ClientTelemetrySpan {
  id: string;
}

interface EventTargetLike {
  addEventListener?(type: string, listener: () => void): void;
  removeEventListener?(type: string, listener: () => void): void;
}

interface NavigatorLike {
  sendBeacon?: (url: string, data?: BodyInit | null) => boolean;
}

interface FetchResponseLike {
  ok: boolean;
}

interface TelemetryBatcherOptions {
  apiBase: string;
  fetchFn?: (input: string, init?: RequestInit) => Promise<FetchResponseLike>;
  document?: EventTargetLike & { visibilityState?: string };
  window?: EventTargetLike;
  navigator?: NavigatorLike;
  flushIntervalMs?: number;
  maxBatchSize?: number;
  maxQueueSize?: number;
  flushTimeoutMs?: number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

const DEFAULT_FLUSH_INTERVAL_MS = 1_500;
const DEFAULT_MAX_BATCH_SIZE = 10;
const DEFAULT_MAX_QUEUE_SIZE = 200;
const DEFAULT_FLUSH_TIMEOUT_MS = 5_000;

export function createTelemetryBatcher(options: TelemetryBatcherOptions) {
  const endpoint = `${options.apiBase}/api/telemetry/batch`;
  const fetchFn = options.fetchFn ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const doc = options.document ?? (typeof document !== "undefined" ? document : undefined);
  const win = options.window ?? (typeof window !== "undefined" ? window : undefined);
  const nav = options.navigator ?? (typeof navigator !== "undefined" ? navigator : undefined);
  const flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const maxBatchSize = options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
  const maxQueueSize = options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;
  const flushTimeoutMs = options.flushTimeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS;
  const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
  const createSpanId = (() => {
    let counter = 0;
    return () => {
      counter += 1;
      if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
      }
      return `telemetry-${Date.now()}-${counter}`;
    };
  })();

  let queue: QueuedTelemetrySpan[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let flushInFlight: Promise<void> | null = null;
  let inFlightBatch: QueuedTelemetrySpan[] | null = null;
  let inFlightAbort: AbortController | null = null;
  let listenersBound = false;

  const clearScheduledFlush = () => {
    if (flushTimer) {
      clearTimeoutFn(flushTimer);
      flushTimer = null;
    }
  };

  const scheduleFlush = () => {
    if (flushTimer || flushInFlight || queue.length === 0) return;
    flushTimer = setTimeoutFn(() => {
      flushTimer = null;
      void flush();
    }, flushIntervalMs);
  };

  const installLifecycleHandlers = () => {
    if (listenersBound) return;
    listenersBound = true;
    const onPageHide = () => { flushSync(); };
    const onVisibilityChange = () => {
      if (doc?.visibilityState === "hidden") flushSync();
    };
    win?.addEventListener?.("pagehide", onPageHide);
    doc?.addEventListener?.("visibilitychange", onVisibilityChange);
    cleanup = () => {
      clearScheduledFlush();
      win?.removeEventListener?.("pagehide", onPageHide);
      doc?.removeEventListener?.("visibilitychange", onVisibilityChange);
      listenersBound = false;
    };
  };

  let cleanup = () => { clearScheduledFlush(); };

  const trimQueue = () => {
    if (queue.length > maxQueueSize) {
      queue = queue.slice(queue.length - maxQueueSize);
    }
  };

  const postBatch = async (
    spans: QueuedTelemetrySpan[],
    keepalive = false,
    signal?: AbortSignal,
  ): Promise<void> => {
    const res = await fetchFn(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spans }),
      ...(signal ? { signal } : {}),
      ...(keepalive ? { keepalive: true } : {}),
    });
    if (!res.ok) throw new Error("Telemetry batch request failed");
  };

  const takeBatch = (): QueuedTelemetrySpan[] => queue.splice(0, maxBatchSize);

  const restoreInFlightBatch = () => {
    if (!inFlightBatch) return;
    inFlightAbort?.abort();
    queue = [...inFlightBatch, ...queue];
    inFlightBatch = null;
    inFlightAbort = null;
    trimQueue();
  };

  async function flush(): Promise<void> {
    if (flushInFlight || queue.length === 0) return flushInFlight ?? Promise.resolve();
    clearScheduledFlush();
    flushInFlight = (async () => {
      while (queue.length > 0) {
        const batch = takeBatch();
        inFlightBatch = batch;
        const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
        inFlightAbort = controller;
        let timeoutId: ReturnType<typeof setTimeout> | null = null;
        try {
          await Promise.race([
            postBatch(batch, false, controller?.signal),
            new Promise<never>((_, reject) => {
              timeoutId = setTimeoutFn(() => {
                controller?.abort();
                reject(new Error("Telemetry batch flush timed out"));
              }, flushTimeoutMs);
            }),
          ]);
          if (inFlightBatch === batch) inFlightBatch = null;
        } catch {
          controller?.abort();
          if (inFlightBatch === batch) {
            queue = [...batch, ...queue];
            inFlightBatch = null;
            trimQueue();
          }
          scheduleFlush();
          break;
        } finally {
          if (timeoutId) clearTimeoutFn(timeoutId);
          if (inFlightAbort === controller) inFlightAbort = null;
        }
      }
    })().finally(() => {
      flushInFlight = null;
      if (queue.length > 0) scheduleFlush();
    });
    return flushInFlight;
  }

  function flushSync(): void {
    clearScheduledFlush();
    restoreInFlightBatch();
    if (queue.length === 0) return;
    while (queue.length > 0) {
      const batch = takeBatch();
      try {
        const payload = new Blob([JSON.stringify({ spans: batch })], { type: "application/json" });
        if (nav?.sendBeacon?.(endpoint, payload)) {
          continue;
        }
      } catch {
        // Fall through to keepalive fetch below.
      }
      void postBatch(batch, true).catch(() => {
        queue = [...batch, ...queue];
        trimQueue();
        scheduleFlush();
      });
    }
  }

  function enqueue(span: ClientTelemetrySpan): void {
    installLifecycleHandlers();
    queue.push({ ...span, id: createSpanId() });
    trimQueue();
    if (queue.length >= maxBatchSize) {
      void flush();
      return;
    }
    scheduleFlush();
  }

  function getPendingCount(): number {
    return queue.length;
  }

  return { enqueue, flush, flushSync, getPendingCount, dispose: () => cleanup() };
}
