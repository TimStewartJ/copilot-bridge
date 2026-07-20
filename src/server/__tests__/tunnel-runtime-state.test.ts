import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTestDir } from "./helpers.js";
import {
  clearTunnelRuntimeState,
  readTunnelRuntimeState,
  TUNNEL_RUNTIME_STATE_FILE_NAME,
  writeTunnelRuntimeState,
} from "../tunnel-runtime-state.js";

describe("tunnel runtime state", () => {
  it("round-trips the public URL and exact process identity", () => {
    const dataDir = makeTestDir("tunnel-runtime-state");
    const state = {
      url: "https://bridge.devtunnels.ms",
      port: 3333,
      process: { pid: 123, startMarker: "started-123" },
      updatedAt: "2026-07-20T00:00:00.000Z",
    };

    writeTunnelRuntimeState(dataDir, state);

    expect(readTunnelRuntimeState(dataDir)).toEqual(state);
    clearTunnelRuntimeState(dataDir);
    expect(readTunnelRuntimeState(dataDir)).toBeNull();
  });

  it("rejects malformed state instead of exposing a bad public URL", () => {
    const dataDir = makeTestDir("tunnel-runtime-invalid");
    writeFileSync(
      join(dataDir, TUNNEL_RUNTIME_STATE_FILE_NAME),
      JSON.stringify({ url: "not-a-url", port: 3333 }),
      "utf8",
    );

    expect(readTunnelRuntimeState(dataDir)).toBeNull();
  });

  it("retains an exact starting-process lease before the URL is known", () => {
    const dataDir = makeTestDir("tunnel-runtime-starting");
    const state = {
      url: null,
      port: 3333,
      process: { pid: 123, startMarker: "started-123" },
      updatedAt: "2026-07-20T00:00:00.000Z",
    };

    writeTunnelRuntimeState(dataDir, state);

    expect(readTunnelRuntimeState(dataDir)).toEqual(state);
  });
});
