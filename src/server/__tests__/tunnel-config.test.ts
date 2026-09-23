import { describe, expect, it } from "vitest";
import { normalizeTunnelName, resolveTunnelConfig } from "../tunnel-config.js";

describe("tunnel config", () => {
  it("hosts no tunnel when nothing is configured", () => {
    expect(resolveTunnelConfig({})).toEqual({ tunnels: [], warnings: [] });
    expect(resolveTunnelConfig({ BRIDGE_TUNNEL_NAMES: "" })).toEqual({ tunnels: [], warnings: [] });
    expect(resolveTunnelConfig({ BRIDGE_TUNNEL_NAMES: " , " })).toEqual({ tunnels: [], warnings: [] });
  });

  it("reads an ordered list with the primary tunnel first", () => {
    expect(resolveTunnelConfig({
      BRIDGE_TUNNEL_NAMES: " Bridge-Work, GitHub:bridge-gh bad.name\nbridge-work,,github:bad.name other-one ",
    })).toEqual({
      tunnels: [
        { name: "bridge-work", auth: "cli" },
        { name: "bridge-gh", auth: "github" },
        { name: "other-one", auth: "cli" },
      ],
      warnings: [
        expect.stringContaining('Skipping invalid tunnel name "bad.name"'),
        expect.stringContaining('Skipping invalid tunnel name "github:bad.name"'),
      ],
    });
  });

  it("keeps a legacy single tunnel name working until the list is set", () => {
    expect(resolveTunnelConfig({ BRIDGE_TUNNEL_NAME: "Tim-Bridge" })).toEqual({
      tunnels: [{ name: "tim-bridge", auth: "cli" }],
      warnings: ["BRIDGE_TUNNEL_NAME is deprecated; rename it to BRIDGE_TUNNEL_NAMES"],
    });
    expect(resolveTunnelConfig({ BRIDGE_TUNNEL_NAME: "tim-bridge", BRIDGE_ENABLE_TUNNEL: "false" }))
      .toEqual({ tunnels: [], warnings: [] });
    expect(resolveTunnelConfig({ BRIDGE_TUNNEL_NAMES: "", BRIDGE_TUNNEL_NAME: "tim-bridge" })).toEqual({
      tunnels: [],
      warnings: ["BRIDGE_TUNNEL_NAMES is set, so BRIDGE_TUNNEL_NAME and BRIDGE_ENABLE_TUNNEL are ignored"],
    });
  });

  it("validates tunnel names", () => {
    expect(normalizeTunnelName(" Copilot-Bridge ")).toBe("copilot-bridge");
    expect(normalizeTunnelName("bad.name")).toBeNull();
    expect(normalizeTunnelName("-leading")).toBeNull();
    expect(normalizeTunnelName("ab")).toBeNull();
  });
});
