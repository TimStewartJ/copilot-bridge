import { useEffect, useState } from "react";
import {
  fetchGlobalMcpStatus,
  type AppSettings,
  type McpServerConfig,
  type McpServerStatus,
} from "../../api";
import EmptyState from "../shared/EmptyState";
import { ServerCard } from "./ServerCard";
import { ServerEditor } from "./ServerEditor";
import { SettingsSection } from "./SettingsSection";

export function McpServersSection({
  draft,
  onDraftChange,
  resetSignal,
}: {
  draft: AppSettings;
  onDraftChange: (nextDraft: AppSettings) => void;
  resetSignal: number;
}) {
  const [editingServer, setEditingServer] = useState<string | null>(null);
  const [addingServer, setAddingServer] = useState(false);
  const [mcpStatuses, setMcpStatuses] = useState<Record<string, McpServerStatus>>({});

  useEffect(() => {
    fetchGlobalMcpStatus()
      .then((servers) => {
        const map: Record<string, McpServerStatus> = {};
        for (const server of servers) map[server.name] = server;
        setMcpStatuses(map);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    setEditingServer(null);
    setAddingServer(false);
  }, [resetSignal]);

  const serverEntries = Object.entries(draft.mcpServers);

  const removeServer = (name: string) => {
    const next = structuredClone(draft);
    delete next.mcpServers[name];
    onDraftChange(next);
    if (editingServer === name) setEditingServer(null);
  };

  const updateServer = (
    name: string,
    config: McpServerConfig,
    newName?: string,
  ) => {
    const next = structuredClone(draft);
    if (newName && newName !== name) {
      delete next.mcpServers[name];
      next.mcpServers[newName] = config;
    } else {
      next.mcpServers[name] = config;
    }
    onDraftChange(next);
    setEditingServer(null);
    setAddingServer(false);
  };

  return (
    <SettingsSection
      title="MCP Servers"
      description="Tool servers attached to every Copilot session. Changes apply on next interaction."
      action={
        <button
          onClick={() => setAddingServer(true)}
          disabled={addingServer}
          className="px-3 py-1.5 text-xs font-medium bg-bg-surface text-text-secondary hover:bg-bg-hover rounded-md transition-colors"
        >
          + Add Server
        </button>
      }
    >
      <div className="space-y-2">
        {serverEntries.map(([name, cfg]) =>
          editingServer === name ? (
            <ServerEditor
              key={name}
              name={name}
              config={cfg}
              existingNames={serverEntries
                .map(([existingName]) => existingName)
                .filter((existingName) => existingName !== name)}
              onSave={(nextConfig, newName) => updateServer(name, nextConfig, newName)}
              onCancel={() => setEditingServer(null)}
            />
          ) : (
            <ServerCard
              key={name}
              name={name}
              config={cfg}
              status={mcpStatuses[name]}
              onEdit={() => setEditingServer(name)}
              onRemove={() => removeServer(name)}
            />
          ),
        )}

        {serverEntries.length === 0 && !addingServer && (
          <EmptyState
            message="No MCP servers"
            sub="Add one to enable tool access"
          />
        )}

        {addingServer && (
          <ServerEditor
            name=""
            config={{ command: "", args: [] }}
            existingNames={serverEntries.map(([name]) => name)}
            onSave={(config, name) => updateServer(name!, config, name)}
            onCancel={() => setAddingServer(false)}
            isNew
          />
        )}
      </div>
    </SettingsSection>
  );
}
