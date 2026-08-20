/** Yield so long in-memory loops do not starve other event-loop work. */
export async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * Map `items` with at most `concurrency` mappers in flight, preserving order.
 * Bounded fan-out keeps large filesystem scans from flooding the libuv threadpool
 * and starving unrelated reads; the periodic yield keeps the event loop responsive.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let processedCount = 0;
  let aborted = false;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      if (aborted) break;
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) break;

      try {
        results[index] = await mapper(items[index]!, index);
      } catch (error) {
        aborted = true;
        throw error;
      }
      processedCount += 1;
      if (processedCount % 128 === 0) {
        await yieldToEventLoop();
      }
    }
  }));

  return results;
}
