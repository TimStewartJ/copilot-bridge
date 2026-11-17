/** Yield so long in-memory loops do not starve other event-loop work. */
export async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Ordered map with bounded concurrency so big fs scans don't flood the libuv threadpool. */
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
