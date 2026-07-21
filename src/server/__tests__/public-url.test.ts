import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTestDir } from "./helpers.js";
import { writeTunnelRuntimeState } from "../tunnel-runtime-state.js";

const ENV_KEYS = [
  "BRIDGE_PUBLIC_BASE_URL",
  "BRIDGE_TRUST_PROXY",
  "BRIDGE_ENABLE_TUNNEL",
  "BRIDGE_DATA_DIR",
] as const;

async function loadPublicUrl(
  env: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {},
) {
  vi.resetModules();
  const isolatedEnv = {
    BRIDGE_DATA_DIR: makeTestDir("public-url"),
    ...env,
  };
  for (const key of ENV_KEYS) {
    vi.stubEnv(key, isolatedEnv[key]);
  }
  return import("../public-url.js");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("public URL helpers", () => {
  it("builds preview URLs from an explicit public base URL", async () => {
    const publicUrl = await loadPublicUrl({
      BRIDGE_PUBLIC_BASE_URL: "https://bridge.example.com/base/",
    });

    expect(publicUrl.getPublicBaseUrl()).toBe("https://bridge.example.com/base");
    expect(publicUrl.buildPublicUrl("/staging/preview-123/")).toBe(
      "https://bridge.example.com/base/staging/preview-123/",
    );
  });

  it("reads the launcher-published tunnel URL without invoking the CLI", async () => {
    const dataDir = makeTestDir("public-url-runtime");
    writeTunnelRuntimeState(dataDir, {
      url: "https://bridge-123.devtunnels.ms",
      port: 3333,
      process: { pid: 123, startMarker: "started-123" },
      updatedAt: new Date().toISOString(),
    });
    const publicUrl = await loadPublicUrl({ BRIDGE_DATA_DIR: dataDir });

    expect(publicUrl.getPublicBaseUrl()).toBe("https://bridge-123.devtunnels.ms");
    expect(publicUrl.buildPublicUrl("/staging/preview-123/")).toBe(
      "https://bridge-123.devtunnels.ms/staging/preview-123/",
    );
  });

  it("ignores launcher tunnel state when tunnel management is disabled", async () => {
    const dataDir = makeTestDir("public-url-disabled");
    writeTunnelRuntimeState(dataDir, {
      url: "https://stale.devtunnels.ms",
      port: 3333,
      process: null,
      updatedAt: new Date().toISOString(),
    });
    const publicUrl = await loadPublicUrl({
      BRIDGE_DATA_DIR: dataDir,
      BRIDGE_ENABLE_TUNNEL: "false",
    });

    expect(publicUrl.getPublicBaseUrl()).toBeUndefined();
  });

  it("learns a public origin only from trusted forwarded headers", async () => {
    const publicUrl = await loadPublicUrl({ BRIDGE_TRUST_PROXY: "true" });
    const req = {
      headers: {
        "x-forwarded-host": "bridge.example.com",
        "x-forwarded-proto": "https",
      },
      protocol: "http",
      get(name: string) {
        return this.headers[name as keyof typeof this.headers];
      },
    };

    expect(publicUrl.rememberRequestOrigin(req as never)).toBe("https://bridge.example.com");
    expect(publicUrl.getPublicBaseUrl()).toBe("https://bridge.example.com");
  });

  it("does not learn a public origin from untrusted requests", async () => {
    const publicUrl = await loadPublicUrl();
    const req = {
      headers: { host: "evil.example" },
      protocol: "http",
      get(name: string) {
        return this.headers[name as keyof typeof this.headers];
      },
    };

    expect(publicUrl.rememberRequestOrigin(req as never)).toBeUndefined();
    expect(publicUrl.getPublicBaseUrl()).toBeUndefined();
  });
});
