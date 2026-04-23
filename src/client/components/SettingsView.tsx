import { useState, useEffect } from "react";
import {
  fetchGlobalMcpStatus,
  type AppSettings,
  type McpServerConfig,
  type McpServerStatus,
  type Tag,
} from "../api";
import { useSettingsQuery, useSettingsMutation } from "../hooks/queries/useSettings";
import { useTagsQuery } from "../hooks/queries/useTags";
import { Settings, ArrowLeft } from "lucide-react";
import { useAppBack } from "../hooks/useAppBack";
import EmptyState from "./shared/EmptyState";
import {
  SettingsSection,
  SystemPromptSection,
  ModelSection,
  ReasoningEffortSection,
  AppearanceSection,
  ProvidersSection,
  ServerCard,
  ServerEditor,
  TagsSection,
  VoiceInputSection,
  BridgeCommitsSection,
  CopilotUsageSection,
} from "./settings";

export default function SettingsView() {
  const { goBack } = useAppBack();
  const { data: queriedSettings, isLoading: settingsLoading } = useSettingsQuery();
  const settingsMutation = useSettingsMutation();
  const { data: queriedTags = [] } = useTagsQuery();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [draft, setDraft] = useState<AppSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [editingServer, setEditingServer] = useState<string | null>(null);
  const [addingServer, setAddingServer] = useState(false);
  const [mcpStatuses, setMcpStatuses] = useState<Record<string, McpServerStatus>>({});
  const [tags, setTags] = useState<Tag[]>([]);

  const hasChanges =
    settings && draft && JSON.stringify(settings) !== JSON.stringify(draft);

  // Sync settings from query
  useEffect(() => {
    if (queriedSettings && !settings) {
      setSettings(queriedSettings);
      setDraft(structuredClone(queriedSettings));
      setLoading(false);
    }
  }, [queriedSettings, settings]);

  // Sync tags from query
  useEffect(() => {
    setTags(queriedTags);
  }, [queriedTags]);

  // Fetch MCP status on mount
  useEffect(() => {
    fetchGlobalMcpStatus()
      .then((servers) => {
        const map: Record<string, McpServerStatus> = {};
        for (const s of servers) map[s.name] = s;
        setMcpStatuses(map);
      })
      .catch(() => {});
  }, []);

  const handleSave = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const updated = await settingsMutation.mutateAsync(draft);
      setSettings(updated);
      setDraft(structuredClone(updated));
      showToast("Settings saved — changes apply on next session interaction");
    } catch (err) {
      showToast(`Save failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      setSaving(false);
    }
  };

  const handleDiscard = () => {
    if (settings) setDraft(structuredClone(settings));
    setEditingServer(null);
    setAddingServer(false);
  };

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 4000);
  };

  const removeServer = (name: string) => {
    if (!draft) return;
    const next = structuredClone(draft);
    delete next.mcpServers[name];
    setDraft(next);
    if (editingServer === name) setEditingServer(null);
  };

  const updateServer = (
    name: string,
    config: McpServerConfig,
    newName?: string,
  ) => {
    if (!draft) return;
    const next = structuredClone(draft);
    if (newName && newName !== name) {
      delete next.mcpServers[name];
      next.mcpServers[newName] = config;
    } else {
      next.mcpServers[name] = config;
    }
    setDraft(next);
    setEditingServer(null);
    setAddingServer(false);
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-text-muted">
        Loading settings…
      </div>
    );
  }

  if (!draft) {
    return (
      <div className="flex-1 flex items-center justify-center text-error">
        Failed to load settings
      </div>
    );
  }

  const serverEntries = Object.entries(draft.mcpServers);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header */}
      <div className="shrink-0 flex items-center justify-between px-6 py-4 border-b border-border bg-bg-secondary">
        <div className="flex items-center gap-3">
          <button
            onClick={goBack}
            className="text-text-muted hover:text-accent transition-colors text-sm flex items-center gap-1"
          >
            <ArrowLeft size={14} />
            Back
          </button>
          <h1 className="text-lg font-medium text-text-primary flex items-center gap-1.5">
            <Settings size={16} className="text-text-muted" />
            Settings
          </h1>
        </div>
        <div className="flex items-center gap-2">
          {hasChanges && (
            <button
              onClick={handleDiscard}
              className="px-3 py-1.5 text-xs text-text-muted hover:text-text-primary transition-colors"
            >
              Discard
            </button>
          )}
          <button
            onClick={handleSave}
            disabled={!hasChanges || saving}
            className={`px-4 py-1.5 text-xs font-medium rounded-md transition-colors ${
              hasChanges
                ? "bg-accent text-white hover:bg-accent-hover"
                : "bg-bg-elevated text-text-faint cursor-not-allowed"
            }`}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <div className="mx-6 mt-3 px-4 py-2 bg-accent/15 text-accent text-xs rounded-md border border-accent/20">
          {toast}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        <SystemPromptSection draft={draft} setDraft={setDraft} />
        <ModelSection draft={draft} setDraft={setDraft} />
        <ReasoningEffortSection draft={draft} setDraft={setDraft} />
        <AppearanceSection draft={draft} setDraft={setDraft} />
        <ProvidersSection draft={draft} setDraft={setDraft} />
        <VoiceInputSection />
        <BridgeCommitsSection />
        <CopilotUsageSection />
        <TagsSection tags={tags} setTags={setTags} />

        {/* MCP Servers Section */}
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
                    .map(([n]) => n)
                    .filter((n) => n !== name)}
                  onSave={(cfg, newName) => updateServer(name, cfg, newName)}
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
                existingNames={serverEntries.map(([n]) => n)}
                onSave={(cfg, name) => updateServer(name!, cfg, name)}
                onCancel={() => setAddingServer(false)}
                isNew
              />
            )}
          </div>
        </SettingsSection>
      </div>

      {/* Sticky unsaved-changes bar */}
      {hasChanges && (
        <div className="shrink-0 flex items-center justify-between gap-3 px-6 py-3 border-t border-accent/30 bg-accent/10 backdrop-blur">
          <span className="text-xs text-accent font-medium">You have unsaved changes</span>
          <div className="flex items-center gap-2">
            <button
              onClick={handleDiscard}
              className="px-3 py-1.5 text-xs text-text-muted hover:text-text-primary transition-colors"
            >
              Discard
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-1.5 text-xs font-medium rounded-md bg-accent text-white hover:bg-accent-hover transition-colors"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
