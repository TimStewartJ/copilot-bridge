export interface CloseHttpServerOptions {
  forceAfterMs?: number;
  timeoutMs?: number;
}

export interface ClosableHttpServer {
  listening: boolean;
  close(callback: (error?: Error) => void): unknown;
  closeAllConnections?(): void;
  closeIdleConnections?(): void;
}

const DEFAULT_FORCE_AFTER_MS = 500;
const DEFAULT_TIMEOUT_MS = 3_000;

export async function closeHttpServer(
  server: ClosableHttpServer,
  options: CloseHttpServerOptions = {},
): Promise<void> {
  if (!server.listening) return;

  const forceAfterMs = options.forceAfterMs ?? DEFAULT_FORCE_AFTER_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (forceAfterMs < 0 || timeoutMs <= forceAfterMs) {
    throw new Error("HTTP server close timeout must be greater than the force-close delay");
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (forceTimer) clearTimeout(forceTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (error) reject(error);
      else resolve();
    };

    try {
      server.close((error) => finish(error ?? undefined));
      server.closeIdleConnections?.();
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (settled) return;

    forceTimer = setTimeout(() => {
      server.closeAllConnections?.();
    }, forceAfterMs);
    forceTimer.unref?.();
    timeoutTimer = setTimeout(() => {
      finish(new Error(`HTTP server did not close within ${timeoutMs}ms`));
    }, timeoutMs);
    timeoutTimer.unref?.();
  });
}
