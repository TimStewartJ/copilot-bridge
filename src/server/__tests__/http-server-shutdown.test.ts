import { afterEach, describe, expect, it, vi } from "vitest";
import { closeHttpServer, type ClosableHttpServer } from "../http-server-shutdown.js";

function fakeServer(
  options: { closeError?: Error; finishOnForce?: boolean } = {},
): ClosableHttpServer & {
  close: ReturnType<typeof vi.fn>;
  closeIdleConnections: ReturnType<typeof vi.fn>;
  closeAllConnections: ReturnType<typeof vi.fn>;
} {
  let callback: ((error?: Error) => void) | undefined;
  const server = {
    listening: true,
    close: vi.fn((next: (error?: Error) => void) => {
      callback = next;
      if (options.closeError) next(options.closeError);
      return server;
    }),
    closeIdleConnections: vi.fn(),
    closeAllConnections: vi.fn(() => {
      if (options.finishOnForce) callback?.();
    }),
  };
  return server;
}

describe("closeHttpServer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("force-closes long-lived connections after the grace period", async () => {
    vi.useFakeTimers();
    const server = fakeServer({ finishOnForce: true });

    const closing = closeHttpServer(server, { forceAfterMs: 50, timeoutMs: 500 });
    expect(server.close).toHaveBeenCalledOnce();
    expect(server.closeIdleConnections).toHaveBeenCalledOnce();
    expect(server.closeAllConnections).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(50);
    await expect(closing).resolves.toBeUndefined();
    expect(server.closeAllConnections).toHaveBeenCalledOnce();
  });

  it("rejects close errors without waiting for the deadline", async () => {
    const error = new Error("close failed");
    const server = fakeServer({ closeError: error });

    await expect(closeHttpServer(server)).rejects.toBe(error);
    expect(server.closeIdleConnections).toHaveBeenCalledOnce();
    expect(server.closeAllConnections).not.toHaveBeenCalled();
  });

  it("rejects instead of hanging when force-close does not finish", async () => {
    vi.useFakeTimers();
    const server = fakeServer();

    const closing = closeHttpServer(server, { forceAfterMs: 50, timeoutMs: 200 });
    const rejected = expect(closing).rejects.toThrow("HTTP server did not close within 200ms");
    await vi.advanceTimersByTimeAsync(200);

    await rejected;
    expect(server.closeAllConnections).toHaveBeenCalledOnce();
  });
});
