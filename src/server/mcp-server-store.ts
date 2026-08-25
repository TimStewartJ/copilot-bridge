import type { DatabaseSync } from "./db.js";
import {
  assertMcpServerConfig,
  type McpServerConfig,
} from "./mcp-config.js";
import { hydrateRowSafely, hydrateRowsSafely, type RowHydrationContext } from "./store-row-hydration.js";
import { runInOwnOrOuterTransaction } from "./db-transaction.js";

export interface McpServer {
  id: string;
  name: string;
  config: McpServerConfig;
  enabledByDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateMcpServerInput {
  name: string;
  config: McpServerConfig;
  enabledByDefault?: boolean;
}

export interface UpdateMcpServerInput {
  name?: string;
  config?: McpServerConfig;
  enabledByDefault?: boolean;
}

function normalizeServerName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("MCP server name is required");
  return trimmed;
}

function serializeConfig(config: McpServerConfig): string {
  assertMcpServerConfig(config);
  try {
    return JSON.stringify(config);
  } catch {
    throw new Error("Invalid MCP server config");
  }
}

function hydrate(row: any): McpServer {
  const config = JSON.parse(row.config) as unknown;
  assertMcpServerConfig(config);
  return {
    id: row.id,
    name: row.name,
    config,
    enabledByDefault: row.enabledByDefault === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * A single unreadable `mcp_servers` row must not break every registry read.
 * `listMcpServers()` feeds session creation, settings sync, and the MCP settings
 * UI, so throwing here would leave the user unable to even delete the bad row.
 * Reads skip it; writes stay strictly validated.
 */
const MCP_SERVER_HYDRATION: RowHydrationContext<any> = {
  store: "mcp-servers",
  describeRow: (row) => `${String(row?.id ?? "<no id>")} ("${String(row?.name ?? "")}")`,
};

export function createMcpServerStore(db: DatabaseSync) {
  function listMcpServers(): McpServer[] {
    const rows = db.prepare("SELECT * FROM mcp_servers ORDER BY name COLLATE NOCASE").all() as any[];
    return hydrateRowsSafely(rows, hydrate, MCP_SERVER_HYDRATION);
  }

  function getMcpServer(id: string): McpServer | undefined {
    const row = db.prepare("SELECT * FROM mcp_servers WHERE id = ?").get(id) as any;
    return row ? hydrateRowSafely(row, hydrate, MCP_SERVER_HYDRATION) : undefined;
  }

  function getMcpServerByName(name: string): McpServer | undefined {
    const row = db.prepare("SELECT * FROM mcp_servers WHERE name = ? COLLATE NOCASE").get(name) as any;
    return row ? hydrateRowSafely(row, hydrate, MCP_SERVER_HYDRATION) : undefined;
  }

  function assertUniqueName(name: string, excludingId?: string): void {
    const row = excludingId
      ? db.prepare("SELECT id FROM mcp_servers WHERE name = ? COLLATE NOCASE AND id != ?").get(name, excludingId) as any
      : db.prepare("SELECT id FROM mcp_servers WHERE name = ? COLLATE NOCASE").get(name) as any;
    if (row) throw new Error(`MCP server name "${name}" already exists`);
  }

  function createMcpServer(input: CreateMcpServerInput): McpServer {
    const name = normalizeServerName(input.name);
    const configJson = serializeConfig(input.config);
    assertUniqueName(name);

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO mcp_servers (id, name, config, enabledByDefault, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, name, configJson, input.enabledByDefault ? 1 : 0, now, now);

    return getMcpServer(id)!;
  }

  function updateMcpServer(id: string, updates: UpdateMcpServerInput): McpServer {
    // Existence is checked against the raw row, not the hydrated one, so a server
    // whose stored config has become unreadable can still be repaired by writing a
    // valid config instead of reporting a confusing "not found".
    const exists = db.prepare("SELECT 1 AS found FROM mcp_servers WHERE id = ?").get(id) as { found?: number } | undefined;
    if (exists?.found !== 1) throw new Error(`MCP server ${id} not found`);

    const fields: string[] = ["updatedAt = ?"];
    const values: any[] = [new Date().toISOString()];

    if (updates.name !== undefined) {
      const name = normalizeServerName(updates.name);
      assertUniqueName(name, id);
      fields.push("name = ?");
      values.push(name);
    }
    if (updates.config !== undefined) {
      fields.push("config = ?");
      values.push(serializeConfig(updates.config));
    }
    if (updates.enabledByDefault !== undefined) {
      fields.push("enabledByDefault = ?");
      values.push(updates.enabledByDefault ? 1 : 0);
    }

    values.push(id);
    // The write and its read-back are one unit: if the stored config is still
    // unreadable after the update, the caller gets an error AND the row is left
    // untouched, instead of a 400 over a change that actually committed.
    // Joins settings-store's transaction when called from its default sync.
    return runInOwnOrOuterTransaction(db, () => {
      db.prepare(`UPDATE mcp_servers SET ${fields.join(", ")} WHERE id = ?`).run(...values);
      const updated = getMcpServer(id);
      if (!updated) {
        throw new Error(`MCP server ${id} has an unreadable stored config; supply a valid config to repair it`);
      }
      return updated;
    });
  }

  function deleteMcpServer(id: string): void {
    db.prepare("DELETE FROM mcp_servers WHERE id = ?").run(id);
  }

  function setMcpServerEnabledByDefault(id: string, enabledByDefault: boolean): McpServer {
    return updateMcpServer(id, { enabledByDefault });
  }

  function resolveMcpServers(serverIds?: Iterable<string>): Record<string, McpServerConfig> {
    const servers = serverIds === undefined
      // Default resolution must survive one unreadable row: it runs on every
      // session start, so throwing here would block session creation entirely.
      // Explicitly requested ids stay strict — silently dropping a dependency
      // the caller asked for would be worse than failing.
      ? hydrateRowsSafely(
        db.prepare("SELECT * FROM mcp_servers WHERE enabledByDefault = 1 ORDER BY name COLLATE NOCASE").all() as any[],
        hydrate,
        MCP_SERVER_HYDRATION,
      )
      : [...serverIds].map((id) => {
        const server = getMcpServer(id);
        if (!server) throw new Error(`MCP server ${id} not found`);
        return server;
      });

    const resolved: Record<string, McpServerConfig> = {};
    for (const server of servers) {
      resolved[server.name] = server.config;
    }
    return resolved;
  }

  return {
    listMcpServers,
    getMcpServer,
    getMcpServerByName,
    createMcpServer,
    updateMcpServer,
    deleteMcpServer,
    setMcpServerEnabledByDefault,
    resolveMcpServers,
  };
}

export type McpServerStore = ReturnType<typeof createMcpServerStore>;
