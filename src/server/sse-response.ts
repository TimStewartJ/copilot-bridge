import type express from "express";

const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_RETRY_MS = 1_000;
const MAX_QUEUED_BYTES = 1024 * 1024;

export interface SseConnection {
  send(data: unknown, id?: string, closeAfter?: boolean): boolean;
  close(): void;
  readonly closed: boolean;
}

export function openSseConnection(
  req: express.Request,
  res: express.Response,
  onClose?: () => void,
): SseConnection {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();

  let isClosed = false;
  let blocked = false;
  let closeAfterFlush = false;
  let queuedBytes = 0;
  const queue: string[] = [];

  const close = () => {
    if (isClosed) return;
    isClosed = true;
    clearInterval(heartbeat);
    queue.length = 0;
    queuedBytes = 0;
    onClose?.();
    if (!res.writableEnded) res.end();
  };

  const write = (chunk: string, closeAfter = false): boolean => {
    if (isClosed || res.writableEnded) return false;
    if (blocked) {
      queuedBytes += Buffer.byteLength(chunk);
      if (queuedBytes > MAX_QUEUED_BYTES) {
        close();
        return false;
      }
      queue.push(chunk);
      closeAfterFlush ||= closeAfter;
      return true;
    }
    try {
      blocked = !res.write(chunk);
      if (closeAfter) close();
      return true;
    } catch {
      close();
      return false;
    }
  };

  const flushQueue = () => {
    if (isClosed) return;
    blocked = false;
    while (queue.length > 0 && !blocked) {
      const chunk = queue.shift()!;
      queuedBytes -= Buffer.byteLength(chunk);
      try {
        blocked = !res.write(chunk);
      } catch {
        close();
        return;
      }
    }
    if (!blocked && queue.length === 0 && closeAfterFlush) {
      closeAfterFlush = false;
      close();
    }
  };

  const heartbeat = setInterval(() => {
    if (!blocked) write(": heartbeat\n\n");
  }, DEFAULT_HEARTBEAT_MS);

  res.on("drain", flushQueue);
  res.on("error", close);
  req.on("close", close);

  write(`retry: ${DEFAULT_RETRY_MS}\n\n`);
  write(": connected\n\n");

  return {
    send(data, id, closeAfter = false) {
      const idLine = id ? `id: ${id.replace(/[\r\n]/g, "")}\n` : "";
      return write(`${idLine}data: ${JSON.stringify(data)}\n\n`, closeAfter);
    },
    close,
    get closed() {
      return isClosed;
    },
  };
}
