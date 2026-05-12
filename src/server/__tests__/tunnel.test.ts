import { afterEach, describe, expect, it, vi } from "vitest";
import { testExecutablePath } from "./test-paths.js";

const execSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execSync: execSyncMock,
}));

const ENV_KEYS = [
  "BRIDGE_PUBLIC_BASE_URL",
  "BRIDGE_TUNNEL_NAME",
  "BRIDGE_TUNNEL_URL",
  "BRIDGE_TRUST_PROXY",
  "BRIDGE_ENABLE_TUNNEL",
  "BRIDGE_DISTRIBUTION_MODE",
  "BRIDGE_STATE_ROOT",
  "BRIDGE_DATA_DIR",
  "USERDOMAIN",
  "USERNAME",
  "COMPUTERNAME",
] as const;

async function loadTunnelModule(env: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {}) {
  vi.resetModules();
  for (const key of ENV_KEYS) {
    vi.stubEnv(key, env[key]);
  }
  return import("../tunnel.js");
}

afterEach(() => {
  vi.unstubAllEnvs();
  execSyncMock.mockReset();
  vi.resetModules();
});

describe("public URL helpers", () => {
  it("keeps the shared tunnel name in development mode", async () => {
    const tunnel = await loadTunnelModule({
      BRIDGE_DISTRIBUTION_MODE: "development",
      BRIDGE_DATA_DIR: "C:\\Users\\Ada\\AppData\\Local\\CopilotBridge\\data",
    });

    expect(tunnel.resolveBridgeTunnelName(process.env)).toBe("copilot-bridge");
  });

  it("uses a deterministic per-install tunnel name in release mode", async () => {
    const tunnel = await loadTunnelModule({
      BRIDGE_DISTRIBUTION_MODE: "release",
      USERDOMAIN: "CONTOSO",
      USERNAME: "ada",
      COMPUTERNAME: "ADA-PC",
      BRIDGE_DATA_DIR: "C:\\Users\\Ada\\AppData\\Local\\CopilotBridge\\data",
    });

    const first = tunnel.resolveBridgeTunnelName(process.env);
    const second = tunnel.resolveBridgeTunnelName(process.env);
    const differentStateRoot = tunnel.resolveBridgeTunnelName({
      ...process.env,
      BRIDGE_DATA_DIR: "C:\\Users\\Ada\\AppData\\Local\\OtherBridge\\data",
    });

    expect(first).toMatch(/^copilot-bridge-[a-f0-9]{8}$/);
    expect(second).toBe(first);
    expect(differentStateRoot).toMatch(/^copilot-bridge-[a-f0-9]{8}$/);
    expect(differentStateRoot).not.toBe(first);
  });

  it("lets explicit tunnel names override release defaults", async () => {
    const tunnel = await loadTunnelModule({
      BRIDGE_DISTRIBUTION_MODE: "release",
      BRIDGE_TUNNEL_NAME: "tim-bridge",
      BRIDGE_DATA_DIR: "C:\\Users\\Ada\\AppData\\Local\\CopilotBridge\\data",
    });

    expect(tunnel.resolveBridgeTunnelName(process.env)).toBe("tim-bridge");
  });

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

  it("disables devtunnel CLI usage via BRIDGE_ENABLE_TUNNEL", async () => {
    const tunnel = await loadTunnelModule({
      BRIDGE_ENABLE_TUNNEL: "false",
    });

    expect(tunnel.getDevtunnelCliStatus()).toEqual({
      enabled: false,
      available: false,
      reason: "Dev tunnel disabled by BRIDGE_ENABLE_TUNNEL",
    });
    expect(tunnel.canUseDevtunnelCli()).toBe(false);
    expect(tunnel.discoverTunnelUrl()).toBeUndefined();
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it("ignores stale tunnel URLs when BRIDGE_ENABLE_TUNNEL is false", async () => {
    const tunnel = await loadTunnelModule({
      BRIDGE_ENABLE_TUNNEL: "false",
      BRIDGE_TUNNEL_URL: "https://stale.devtunnels.ms",
    });

    expect(tunnel.getTunnelUrl()).toBeUndefined();
    expect(tunnel.getPublicBaseUrl()).toBeUndefined();
    expect(tunnel.buildPublicUrl("/staging/preview-123/")).toBeUndefined();
  });

  it("reads BRIDGE_ENABLE_TUNNEL dynamically after import", async () => {
    execSyncMock.mockReturnValue(testExecutablePath("devtunnel"));
    const tunnel = await loadTunnelModule();

    vi.stubEnv("BRIDGE_ENABLE_TUNNEL", "false");

    expect(tunnel.getDevtunnelCliStatus()).toEqual({
      enabled: false,
      available: false,
      reason: "Dev tunnel disabled by BRIDGE_ENABLE_TUNNEL",
    });
    expect(tunnel.canUseDevtunnelCli()).toBe(false);
    expect(tunnel.discoverTunnelUrl()).toBeUndefined();
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it("uses the deterministic release tunnel name for devtunnel discovery", async () => {
    execSyncMock.mockImplementation((command: string) => {
      if (command.includes("devtunnel show")) {
        return "Connect via browser: https://generated.devtunnels.ms";
      }
      return testExecutablePath("devtunnel");
    });
    const tunnel = await loadTunnelModule({
      BRIDGE_DISTRIBUTION_MODE: "release",
      USERDOMAIN: "CONTOSO",
      USERNAME: "ada",
      COMPUTERNAME: "ADA-PC",
      BRIDGE_DATA_DIR: "C:\\Users\\Ada\\AppData\\Local\\CopilotBridge\\data",
    });

    expect(tunnel.discoverTunnelUrl()).toBe("https://generated.devtunnels.ms");
    const showCall = execSyncMock.mock.calls.find(([command]) => String(command).startsWith("devtunnel show"));
    expect(showCall?.[0]).toMatch(/^devtunnel show copilot-bridge-[a-f0-9]{8}$/);
  });

  it("reports missing devtunnel binary as unavailable", async () => {
    execSyncMock.mockImplementation(() => {
      throw new Error("not found");
    });

    const tunnel = await loadTunnelModule();

    expect(tunnel.getDevtunnelCliStatus()).toEqual({
      enabled: true,
      available: false,
      reason: "Dev tunnel unavailable: devtunnel not installed or not in PATH",
    });
    expect(tunnel.canUseDevtunnelCli()).toBe(false);
    expect(tunnel.discoverTunnelUrl()).toBeUndefined();
  });
});
