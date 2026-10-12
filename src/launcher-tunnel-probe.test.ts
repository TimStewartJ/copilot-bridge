import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getCliTunnelConnectCredential,
  parseTunnelConnectCredential,
  probeTunnelHealth,
} from "./launcher-tunnel-probe.js";

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: execFileMock }));
const url = "https://bridge.example.devtunnels.ms/api/health";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  execFileMock.mockReset();
});

describe("tunnel connect credentials", () => {
  it("uses an asynchronous connect-only CLI command with a deadline and parses its expiry", async () => {
    const expiration = new Date(Date.now() + 3600_000).toISOString();
    execFileMock.mockImplementation((_file, _args, _options, callback) =>
      callback(null, JSON.stringify({ token: "connect-secret", expiration })));
    await expect(getCliTunnelConnectCredential("work")).resolves.toEqual({
      accessToken: "connect-secret", expiresAt: Date.parse(expiration),
    });
    expect(execFileMock).toHaveBeenCalledWith("devtunnel", ["token", "work", "--scopes", "connect", "--json"],
      expect.objectContaining({ timeout: 30_000, windowsHide: true }), expect.any(Function));
  });

  it("does not expose CLI output in errors", async () => {
    execFileMock.mockImplementation((_file, _args, _options, callback) =>
      callback(Object.assign(new Error("stdout contains connect-secret"), { killed: true }), "connect-secret"));
    await expect(getCliTunnelConnectCredential("work")).rejects.toThrow("timed out after 30000ms");
    execFileMock.mockImplementation((_file, _args, _options, callback) =>
      callback(null, '{"token":"connect-secret","expiration":"invalid"}'));
    await expect(getCliTunnelConnectCredential("work")).rejects.toThrow("invalid connect token or expiry");
  });

  it("refuses missing or expired connect credentials", () => {
    expect(() => parseTunnelConnectCredential(undefined)).toThrow("No tunnel connect token");
    expect(() => parseTunnelConnectCredential("token", new Date(Date.now() - 1).toISOString())).toThrow("future expiry");
  });
});

describe("authenticated forwarding health", () => {
  it("validates Bridge JSON and never forwards credentials through redirects", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true, agentBackend: { state: "reconnecting" } }));
    expect((await probeTunnelHealth(fetchMock, url, 100, { accessToken: "secret" })).kind).toBe("healthy");
    expect(fetchMock).toHaveBeenCalledWith(url, expect.objectContaining({
      redirect: "manual", headers: { "X-Tunnel-Authorization": "tunnel secret" },
    }));
  });

  it.each([
    new Response("not json"),
    Response.json({ ok: false }),
    Response.json({ unrelated: true }),
    new Response(null, { status: 204 }),
  ])("does not mistake a successful HTTP status for Bridge health", async (response) => {
    const fetchMock = vi.fn(async () => response);
    expect((await probeTunnelHealth(fetchMock, url, 100)).kind).toBe("forwarding");
  });

  it("uses sign-in redirects only as front-door reachability, not forwarding health", async () => {
    const fetchMock = vi.fn(async () => new Response(null, {
      status: 302, headers: { location: "https://global.rel.tunnels.api.visualstudio.com/auth/aad" },
    }));
    expect((await probeTunnelHealth(fetchMock, url, 100, { accessToken: "secret" })).kind).toBe("auth");
    expect((await probeTunnelHealth(fetchMock, url, 100, { frontDoor: true })).kind).toBe("healthy");
  });

  it.each([401, 403])("separates HTTP %i authentication failures from host failures", async (status) => {
    expect((await probeTunnelHealth(vi.fn(async () => new Response(null, { status })), url, 100)).kind).toBe("auth");
  });

  it("refuses to send a token to an unexpected origin", async () => {
    const fetchMock = vi.fn();
    expect((await probeTunnelHealth(fetchMock, "https://example.com/api/health", 100, { accessToken: "secret" })).kind).toBe("auth");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("distinguishes a TCP connection timeout from an unanswered forwarding request", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed", { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } });
    });
    expect(await probeTunnelHealth(fetchMock, url, 100)).toMatchObject({
      kind: "network", detail: "connection establishment failed (UND_ERR_CONNECT_TIMEOUT)",
    });
  });

  it("classifies socket resets for a separate front-door check", async () => {
    expect(await probeTunnelHealth(vi.fn(async () => {
      throw new TypeError("fetch failed", { cause: { code: "UND_ERR_SOCKET" } });
    }), url, 100)).toMatchObject({
      kind: "transport", detail: "connection reset before Bridge health (UND_ERR_SOCKET)",
    });
  });

  it("bounds stalled response bodies, not just response headers", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (_url, init?: RequestInit) => {
      const response = Response.json({ ok: true });
      vi.spyOn(response, "json").mockImplementation(() => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      }));
      return response;
    });
    const promise = probeTunnelHealth(fetchMock, url, 25);
    await vi.advanceTimersByTimeAsync(25);
    expect(await promise).toMatchObject({ kind: "timeout", durationMs: 25 });
  });
});
