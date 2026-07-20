import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("server tunnel boundaries", () => {
  it("keeps devtunnel process management and startup notifications out of the server", () => {
    const source = readFileSync(join(process.cwd(), "src", "server", "index.ts"), "utf8");

    expect(source).toContain('from "./public-url.js"');
    expect(source).not.toContain("devtunnel");
    expect(source).not.toContain("discoverTunnelUrl");
    expect(source).not.toContain("notifyWebhook");
  });

  it("keeps server restart and rollback paths independent from tunnel restarts", () => {
    const source = readFileSync(join(process.cwd(), "src", "launcher.ts"), "utf8");

    expect(source.match(/tunnelSupervisor\.start\(\)/g)).toHaveLength(1);
    expect(source).not.toContain("startTunnel(");
    expect(source).not.toContain("ensureTunnelAfterRollback");
    expect(source).not.toContain("BRIDGE_TUNNEL_URL");
  });
});
