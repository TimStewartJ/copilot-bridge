import type { DatabaseSync } from "./db.js";
import {
  assertMcpServerConfig,
  mcpServerConfigsEqual,
  type McpServerConfig,
} from "./mcp-config.js";

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

export function createMcpServerStore(db: DatabaseSync) {
  function listMcpServers(): McpServer[] {
    return (db.prepare("SELECT * FROM mcp_servers ORDER BY name COLLATE NOCASE").all() as any[]).map(hydrate);
  }

  function getMcpServer(id: string): McpServer | undefined {
    const row = db.prepare("SELECT * FROM mcp_servers WHERE id = ?").get(id) as any;
    return row ? hydrate(row) : undefined;
  }

  function getMcpServerByName(name: string): McpServer | undefined {
    const row = db.prepare("SELECT * FROM mcp_servers WHERE name = ? COLLATE NOCASE").get(name) as any;
    return row ? hydrate(row) : undefined;
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
    const current = getMcpServer(id);
    if (!current) throw new Error(`MCP server ${id} not found`);

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
    db.prepare(`UPDATE mcp_servers SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    return getMcpServer(id)!;
  }

  function deleteMcpServer(id: string): void {
    db.prepare("DELETE FROM mcp_servers WHERE id = ?").run(id);
  }

  function setMcpServerEnabledByDefault(id: string, enabledByDefault: boolean): McpServer {
    if (!getMcpServer(id)) throw new Error(`MCP server ${id} not found`);
    return updateMcpServer(id, { enabledByDefault });
  }

  function makeUniqueName(preferredName: string): string {
    const base = normalizeServerName(preferredName);
    const existing = new Set(
      (db.prepare("SELECT name FROM mcp_servers").all() as Array<{ name: string }>)
        .map((row) => row.name.toLocaleLowerCase()),
    );
    if (!existing.has(base.toLocaleLowerCase())) return base;

    const first = `${base} (tag override)`;
    if (!existing.has(first.toLocaleLowerCase())) return first;
    for (let i = 2; i <= 10_000; i++) {
      const candidate = `${base} (tag override ${i})`;
      if (!existing.has(candidate.toLocaleLowerCase())) return candidate;
    }
    throw new Error(`Unable to generate unique MCP server name for "${base}"`);
  }

  function findReusableServerForNameAndConfig(name: string, config: McpServerConfig): McpServer | undefined {
    const normalized = normalizeServerName(name);
    const lowerName = normalized.toLocaleLowerCase();
    return listMcpServers().find((server) => {
      const lowerServerName = server.name.toLocaleLowerCase();
      return (lowerServerName === lowerName || lowerServerName.startsWith(`${lowerName} (`))
        && mcpServerConfigsEqual(server.config, config);
    });
  }

  function ensureMcpServerForNameAndConfig(
    name: string,
    config: McpServerConfig,
    enabledByDefault = false,
  ): McpServer {
    const normalized = normalizeServerName(name);
    const configJson = serializeConfig(config);
    const typedConfig = JSON.parse(configJson) as McpServerConfig;
    const reusable = findReusableServerForNameAndConfig(normalized, typedConfig);
    if (reusable) {
      if (enabledByDefault && !reusable.enabledByDefault) {
        return updateMcpServer(reusable.id, { enabledByDefault: true });
      }
      return reusable;
    }

    return createMcpServer({
      name: makeUniqueName(normalized),
      config: typedConfig,
      enabledByDefault,
    });
  }

  function resolveMcpServers(serverIds?: Iterable<string>): Record<string, McpServerConfig> {
    const servers = serverIds === undefined
      ? (db.prepare("SELECT * FROM mcp_servers WHERE enabledByDefault = 1 ORDER BY name COLLATE NOCASE").all() as any[]).map(hydrate)
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
    ensureMcpServerForNameAndConfig,
    resolveMcpServers,
  };
}

export type McpServerStore = ReturnType<typeof createMcpServerStore>;
