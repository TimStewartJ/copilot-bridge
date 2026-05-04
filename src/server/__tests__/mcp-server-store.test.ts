import { beforeEach, describe, expect, it } from "vitest";
import { setupTestDb } from "./helpers.js";
import { createMcpServerStore, type McpServerStore } from "../mcp-server-store.js";
import type { DatabaseSync } from "../db.js";

let db: DatabaseSync;
let store: McpServerStore;

beforeEach(() => {
  db = setupTestDb();
  store = createMcpServerStore(db);
});

describe("mcp-server-store", () => {
  it("creates, lists, updates, toggles, resolves, and deletes registry servers", () => {
    const local = store.createMcpServer({
      name: "Local",
      config: { command: "echo", args: ["ok"] },
      enabledByDefault: true,
    });
    const remote = store.createMcpServer({
      name: "Remote",
      config: { type: "http", url: "https://example.test/mcp" },
    });

    expect(store.listMcpServers().map((server) => server.name)).toEqual(["Local", "Remote"]);
    expect(store.resolveMcpServers()).toEqual({ Local: { command: "echo", args: ["ok"] } });
    expect(store.resolveMcpServers([remote.id, local.id])).toEqual({
      Remote: { type: "http", url: "https://example.test/mcp" },
      Local: { command: "echo", args: ["ok"] },
    });

    const updated = store.updateMcpServer(local.id, {
      name: "Renamed",
      config: { command: "printf", args: ["ok"], env: { DEBUG: "1" } },
      enabledByDefault: false,
    });
    expect(updated).toMatchObject({
      id: local.id,
      name: "Renamed",
      enabledByDefault: false,
      config: { command: "printf", args: ["ok"], env: { DEBUG: "1" } },
    });

    expect(store.setMcpServerEnabledByDefault(remote.id, true).enabledByDefault).toBe(true);
    expect(store.resolveMcpServers()).toEqual({
      Remote: { type: "http", url: "https://example.test/mcp" },
    });

    store.deleteMcpServer(remote.id);
    expect(store.getMcpServer(remote.id)).toBeUndefined();
    expect(store.resolveMcpServers()).toEqual({});
  });

  it("enforces case-insensitive unique names", () => {
    const first = store.createMcpServer({ name: "Linear", config: { command: "linear", args: [] } });

    expect(() =>
      store.createMcpServer({ name: "linear", config: { command: "other", args: [] } })
    ).toThrow(/already exists/);
    expect(() => store.updateMcpServer(first.id, { name: "LINEAR" })).not.toThrow();
  });

  it("validates basic MCP config shape", () => {
    expect(() =>
      store.createMcpServer({
        name: "bad-local",
        config: { command: "echo" } as any,
      })
    ).toThrow(/Invalid MCP server config/);

    expect(() =>
      store.createMcpServer({
        name: "bad-remote",
        config: { type: "http", headers: { Authorization: 1 } } as any,
      })
    ).toThrow(/Invalid MCP server config/);
  });

  it("rejects blank names, missing IDs, and invalid update configs without corrupting rows", () => {
    const server = store.createMcpServer({
      name: "  GitHub  ",
      config: { command: "github-mcp", args: [] },
      enabledByDefault: true,
    });

    expect(server.name).toBe("GitHub");
    expect(() =>
      store.createMcpServer({ name: "   ", config: { command: "blank", args: [] } })
    ).toThrow(/name is required/);
    expect(() => store.resolveMcpServers(["missing-server"])).toThrow(/not found/);
    expect(() => store.setMcpServerEnabledByDefault("missing-server", true)).toThrow(/not found/);
    expect(() =>
      store.updateMcpServer(server.id, { config: { type: "http", url: "" } as any })
    ).toThrow(/Invalid MCP server config/);
    expect(store.getMcpServer(server.id)).toMatchObject({
      name: "GitHub",
      config: { command: "github-mcp", args: [] },
      enabledByDefault: true,
    });
  });

  it("can ensure distinct generated names for same-name tag overrides", () => {
    const global = store.createMcpServer({
      name: "linear",
      config: { type: "http", url: "https://global.example/mcp" },
      enabledByDefault: true,
    });

    const sameConfig = store.ensureMcpServerForNameAndConfig(
      "LINEAR",
      { type: "http", url: "https://global.example/mcp" },
      false,
    );
    const override = store.ensureMcpServerForNameAndConfig(
      "linear",
      { type: "http", url: "https://override.example/mcp" },
      false,
    );
    const overrideAgain = store.ensureMcpServerForNameAndConfig(
      "linear",
      { type: "http", url: "https://override.example/mcp" },
      false,
    );

    expect(sameConfig.id).toBe(global.id);
    expect(override.name).toMatch(/^linear \(tag override/);
    expect(overrideAgain.id).toBe(override.id);
    expect(store.listMcpServers()).toHaveLength(2);
  });
});
