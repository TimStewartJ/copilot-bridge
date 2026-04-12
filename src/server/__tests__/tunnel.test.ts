import { afterEach, describe, expect, it, vi } from "vitest";

const ENV_KEYS = [
  "BRIDGE_PUBLIC_BASE_URL",
  "BRIDGE_TUNNEL_URL",
  "BRIDGE_TRUST_PROXY",
] as const;

const originalEnv = new Map<string, string | undefined>(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

async function loadTunnelModule(env: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {}) {
  vi.resetModules();
  for (const key of ENV_KEYS) {
    const value = env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  return import("../tunnel.js");
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  vi.resetModules();
});

describe("public URL helpers", () => {
  it("builds preview URLs from an explicit public base URL", async () => {
    const tunnel = await loadTunnelModule({
      BRIDGE_PUBLIC_BASE_URL: "https://bridge.example.com/base/",
      BRIDGE_TUNNEL_URL: "https://fallback.devtunnels.ms",
    });

    expect(tunnel.getPublicBaseUrl()).toBe("https://bridge.example.com/base");
    expect(tunnel.buildPublicUrl("/staging/preview-123/")).toBe(
      "https://bridge.example.com/base/staging/preview-123/",
    );
  });

  it("learns a proxied public origin from forwarded headers when trust proxy is enabled", async () => {
    const tunnel = await loadTunnelModule({
      BRIDGE_TRUST_PROXY: "true",
    });

    const req = {
      headers: {
        host: "127.0.0.1:4141",
        "x-forwarded-host": "bridge.example.com",
        "x-forwarded-proto": "https",
      },
      protocol: "http",
      get(name: string) {
        return this.headers[name as keyof typeof this.headers];
      },
    };

    expect(tunnel.rememberRequestOrigin(req as any)).toBe("https://bridge.example.com");
    expect(tunnel.getPublicBaseUrl()).toBe("https://bridge.example.com");
  });

  it("prefers a tunnel URL over a learned localhost origin", async () => {
    const tunnel = await loadTunnelModule({
      BRIDGE_TUNNEL_URL: "https://bridge-123.devtunnels.ms",
      BRIDGE_TRUST_PROXY: "true",
    });

    const req = {
      headers: {
        host: "localhost:4141",
        "x-forwarded-host": "localhost:4141",
        "x-forwarded-proto": "http",
      },
      protocol: "http",
      get(name: string) {
        return this.headers[name as keyof typeof this.headers];
      },
    };

    expect(tunnel.rememberRequestOrigin(req as any)).toBe("http://localhost:4141");
    expect(tunnel.getPublicBaseUrl()).toBe("https://bridge-123.devtunnels.ms");
    expect(tunnel.buildPublicUrl("/staging/preview-123/")).toBe(
      "https://bridge-123.devtunnels.ms/staging/preview-123/",
    );
  });

  it("keeps the relative-path fallback when only localhost has been observed", async () => {
    const tunnel = await loadTunnelModule({
      BRIDGE_TRUST_PROXY: "true",
    });

    const req = {
      headers: {
        host: "localhost:4141",
        "x-forwarded-host": "localhost:4141",
        "x-forwarded-proto": "http",
      },
      protocol: "http",
      get(name: string) {
        return this.headers[name as keyof typeof this.headers];
      },
    };

    expect(tunnel.rememberRequestOrigin(req as any)).toBe("http://localhost:4141");
    expect(tunnel.getPublicBaseUrl()).toBeUndefined();
    expect(tunnel.buildPublicUrl("/staging/preview-123/")).toBeUndefined();
  });

  it("does not learn a public origin from untrusted direct requests", async () => {
    const tunnel = await loadTunnelModule();

    const req = {
      headers: { host: "evil.example" },
      protocol: "http",
      get(name: string) {
        return this.headers[name as keyof typeof this.headers];
      },
    };

    expect(tunnel.rememberRequestOrigin(req as any)).toBeUndefined();
    expect(tunnel.getPublicBaseUrl()).toBeUndefined();
  });

  it("ignores malformed tunnel URL overrides", async () => {
    const tunnel = await loadTunnelModule({
      BRIDGE_TUNNEL_URL: "not-a-url",
    });

    expect(tunnel.getTunnelUrl()).toBeUndefined();
    expect(tunnel.buildPublicUrl("/staging/preview-123/")).toBeUndefined();
  });
});
