import { useEffect, useState } from "react";
import { DS } from "../../design/tokens";
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
import { ServerCard } from "./ServerCard";
import { ServerEditor } from "./ServerEditor";
import { SettingsSection } from "./SettingsSection";
import { Button, EmptyHint, Notice, SettingList } from "../../design/primitives";
import { Plus } from "lucide-react";

function sortServers(servers: McpServer[]): McpServer[] {
  return [...servers].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

export function McpServersSection() {
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

  const setUpdatedServer = (server: McpServer) => {
    setServers((current) => sortServers(current.map((item) => (item.id === server.id ? server : item))));
  };

  const removeServer = async (server: McpServer) => {
    const confirmed = window.confirm(
      `Delete MCP server "${server.name}"?\n\nThis can't be undone.`,
    );
    if (!confirmed) return;
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
      title="MCP servers"
      description="Switch on to attach a server to every new session."
      action={
        <Button size="sm" variant="ghost" icon={<Plus size={13} />} onClick={() => setAddingServer(true)} disabled={addingServer || loadingServers}>
          Add server
        </Button>
      }
    >
      <SettingList>
        {error && <Notice tone="danger" className="mb-2">{error}</Notice>}

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

        {loadingServers && <p role="status" className={DS.field.help}>Loading MCP servers…</p>}

        {!loadingServers && servers.length === 0 && !addingServer && (
          <EmptyHint>No MCP servers yet. Add one to give sessions tools.</EmptyHint>
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
      </SettingList>
    </SettingsSection>
  );
}
