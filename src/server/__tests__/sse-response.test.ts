import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { openSseConnection } from "../sse-response.js";

describe("openSseConnection", () => {
  it("flushes a queued terminal event before closing a backpressured response", () => {
    const req = new EventEmitter();
    const res = new EventEmitter() as EventEmitter & {
      writableEnded: boolean;
      writeHead: ReturnType<typeof vi.fn>;
      flushHeaders: ReturnType<typeof vi.fn>;
      write: ReturnType<typeof vi.fn>;
      end: ReturnType<typeof vi.fn>;
    };
    res.writableEnded = false;
    res.writeHead = vi.fn();
    res.flushHeaders = vi.fn();
    res.end = vi.fn(() => {
      res.writableEnded = true;
    });
    res.write = vi.fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);

    const connection = openSseConnection(req as any, res as any);
    connection.send({ type: "delta", content: "working" });
    connection.send({ type: "done", content: "complete" }, "terminal-1", true);

    expect(res.end).not.toHaveBeenCalled();
    res.emit("drain");

    expect(res.write).toHaveBeenLastCalledWith(
      "id: terminal-1\ndata: {\"type\":\"done\",\"content\":\"complete\"}\n\n",
    );
    expect(res.end).toHaveBeenCalledOnce();
    expect(connection.closed).toBe(true);
  });

  it("closes after a second drain when the queued terminal write re-blocks", () => {
    const req = new EventEmitter();
    const res = new EventEmitter() as EventEmitter & {
      writableEnded: boolean;
      writeHead: ReturnType<typeof vi.fn>;
      flushHeaders: ReturnType<typeof vi.fn>;
      write: ReturnType<typeof vi.fn>;
      end: ReturnType<typeof vi.fn>;
    };
    res.writableEnded = false;
    res.writeHead = vi.fn();
    res.flushHeaders = vi.fn();
    res.end = vi.fn(() => {
      res.writableEnded = true;
    });
    res.write = vi.fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false);

    const connection = openSseConnection(req as any, res as any);
    connection.send({ type: "delta", content: "working" });
    connection.send({ type: "done", content: "complete" }, "terminal-1", true);

    res.emit("drain");
    expect(connection.closed).toBe(false);
    res.emit("drain");
    expect(connection.closed).toBe(true);
    expect(res.end).toHaveBeenCalledOnce();
  });
});
