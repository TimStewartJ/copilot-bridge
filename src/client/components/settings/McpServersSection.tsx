import { useEffect, useState } from "react";
import {
  createMcpServer,
  deleteMcpServer,
  fetchGlobalMcpStatus,
  fetchMcpServers,
  updateMcpServer,
  type McpServer,
  type McpServerConfig,
  type McpServerStatus,
} from "../../api";
import EmptyState from "../shared/EmptyState";
import { ServerCard } from "./ServerCard";
import { ServerEditor } from "./ServerEditor";
import { SettingsSection } from "./SettingsSection";

function sortServers(servers: McpServer[]): McpServer[] {
  return [...servers].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

export function McpServersSection({
  resetSignal,
}: {
  resetSignal: number;
}) {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loadingServers, setLoadingServers] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingServerId, setEditingServerId] = useState<string | null>(null);
  const [addingServer, setAddingServer] = useState(false);
  const [savingServerId, setSavingServerId] = useState<string | null>(null);
  const [mcpStatuses, setMcpStatuses] = useState<Record<string, McpServerStatus>>({});

  const loadServers = async () => {
    setLoadingServers(true);
    setError(null);
    try {
      setServers(sortServers(await fetchMcpServers()));
    } catch (err) {
      console.error("Failed to load MCP server registry:", err);
      setError(`Failed to load MCP servers: ${err instanceof Error ? err.message : err}`);
      setServers([]);
    } finally {
      setLoadingServers(false);
    }
  };

  const loadStatuses = async () => {
    try {
      const statuses = await fetchGlobalMcpStatus();
      const map: Record<string, McpServerStatus> = {};
      for (const server of statuses) map[server.name] = server;
      setMcpStatuses(map);
    } catch {
      setMcpStatuses({});
    }
  };

  useEffect(() => {
    loadServers();
    loadStatuses();
  }, []);

  useEffect(() => {
    setEditingServerId(null);
    setAddingServer(false);
  }, [resetSignal]);

  const setUpdatedServer = (server: McpServer) => {
    setServers((current) => sortServers(current.map((item) => (item.id === server.id ? server : item))));
  };

  const removeServer = async (server: McpServer) => {
    setSavingServerId(server.id);
    setError(null);
    try {
      await deleteMcpServer(server.id);
      setServers((current) => current.filter((item) => item.id !== server.id));
      if (editingServerId === server.id) setEditingServerId(null);
      await loadStatuses();
    } catch (err) {
      console.error("Failed to delete MCP server:", err);
      setError(`Failed to delete MCP server: ${err instanceof Error ? err.message : err}`);
    } finally {
      setSavingServerId(null);
    }
  };

  const updateServerConfig = async (
    server: McpServer,
    config: McpServerConfig,
    newName?: string,
  ) => {
    setSavingServerId(server.id);
    setError(null);
    try {
      const updated = await updateMcpServer(server.id, {
        name: newName ?? server.name,
        config,
      });
      setUpdatedServer(updated);
      setEditingServerId(null);
      await loadStatuses();
    } catch (err) {
      console.error("Failed to update MCP server:", err);
      setError(`Failed to update MCP server: ${err instanceof Error ? err.message : err}`);
    } finally {
      setSavingServerId(null);
    }
  };

  const addServer = async (config: McpServerConfig, name?: string) => {
    if (!name) return;
    setSavingServerId("__new__");
    setError(null);
    try {
      const created = await createMcpServer({
        name,
        config,
        enabledByDefault: false,
      });
      setServers((current) => sortServers([...current, created]));
      setAddingServer(false);
      await loadStatuses();
    } catch (err) {
      console.error("Failed to create MCP server:", err);
      setError(`Failed to create MCP server: ${err instanceof Error ? err.message : err}`);
    } finally {
      setSavingServerId(null);
    }
  };

  const toggleEnabledByDefault = async (server: McpServer, enabledByDefault: boolean) => {
    setSavingServerId(server.id);
    setError(null);
    try {
      setUpdatedServer(await updateMcpServer(server.id, { enabledByDefault }));
      await loadStatuses();
    } catch (err) {
      console.error("Failed to update MCP server default state:", err);
      setError(`Failed to update MCP server default state: ${err instanceof Error ? err.message : err}`);
    } finally {
      setSavingServerId(null);
    }
  };

  const existingNames = servers.map((server) => server.name);

  return (
    <SettingsSection
      title="MCP Servers"
      description="Registered tool servers. Enable by default to attach a server to every session; tags can select additional registered servers."
      action={
        <button
          onClick={() => setAddingServer(true)}
          disabled={addingServer || loadingServers}
          className="px-3 py-1.5 text-xs font-medium bg-bg-surface text-text-secondary hover:bg-bg-hover rounded-md transition-colors disabled:opacity-50"
        >
          + Add Server
        </button>
      }
    >
      <div className="space-y-2">
        {error && (
          <div className="rounded-md border border-error/20 bg-error/10 px-3 py-2 text-xs text-error">
            {error}
          </div>
        )}

        {servers.map((server) =>
          editingServerId === server.id ? (
            <ServerEditor
              key={server.id}
              name={server.name}
              config={server.config}
              existingNames={existingNames.filter((name) => name !== server.name)}
              onSave={(nextConfig, newName) => updateServerConfig(server, nextConfig, newName)}
              onCancel={() => setEditingServerId(null)}
            />
          ) : (
            <ServerCard
              key={server.id}
              name={server.name}
              config={server.config}
              status={mcpStatuses[server.name]}
              enabledByDefault={server.enabledByDefault}
              defaultToggleDisabled={savingServerId === server.id}
              onToggleEnabledByDefault={(enabled) => toggleEnabledByDefault(server, enabled)}
              onEdit={() => setEditingServerId(server.id)}
              onRemove={() => removeServer(server)}
            />
          ),
        )}

        {loadingServers && (
          <div className="rounded-md border border-border bg-bg-elevated px-3 py-2 text-xs text-text-muted">
            Loading MCP servers…
          </div>
        )}

        {!loadingServers && servers.length === 0 && !addingServer && (
          <EmptyState
            message="No MCP servers"
            sub="Add one to enable tool access"
          />
        )}

        {addingServer && (
          <ServerEditor
            name=""
            config={{ command: "", args: [] }}
            existingNames={existingNames}
            onSave={addServer}
            onCancel={() => setAddingServer(false)}
            isNew
          />
        )}
      </div>
    </SettingsSection>
  );
}
