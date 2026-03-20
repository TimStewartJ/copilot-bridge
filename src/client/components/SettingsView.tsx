import { useState, useEffect } from "react";
import {
  fetchSettings,
  patchSettings,
  type AppSettings,
  type McpServerConfig,
} from "../api";

interface SettingsViewProps {
  onGoHome: () => void;
}

export default function SettingsView({ onGoHome }: SettingsViewProps) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [draft, setDraft] = useState<AppSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [editingServer, setEditingServer] = useState<string | null>(null);
  const [addingServer, setAddingServer] = useState(false);

  const hasChanges =
    settings && draft && JSON.stringify(settings) !== JSON.stringify(draft);

  useEffect(() => {
    fetchSettings()
      .then((s) => {
        setSettings(s);
        setDraft(structuredClone(s));
      })
      .catch(() => setToast("Failed to load settings"))
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const updated = await patchSettings(draft);
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
      <div className="flex-1 flex items-center justify-center text-gray-500">
        Loading settings…
      </div>
    );
  }

  if (!draft) {
    return (
      <div className="flex-1 flex items-center justify-center text-red-400">
        Failed to load settings
      </div>
    );
  }

  const serverEntries = Object.entries(draft.mcpServers);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header */}
      <div className="shrink-0 flex items-center justify-between px-6 py-4 border-b border-[#2a2a4a] bg-[#16213e]">
        <div className="flex items-center gap-3">
          <button
            onClick={onGoHome}
            className="text-gray-400 hover:text-indigo-400 transition-colors text-sm"
          >
            ← Back
          </button>
          <h1 className="text-lg font-semibold text-gray-200">⚙️ Settings</h1>
        </div>
        <div className="flex items-center gap-2">
          {hasChanges && (
            <button
              onClick={handleDiscard}
              className="px-3 py-1.5 text-xs text-gray-400 hover:text-gray-200 transition-colors"
            >
              Discard
            </button>
          )}
          <button
            onClick={handleSave}
            disabled={!hasChanges || saving}
            className={`px-4 py-1.5 text-xs font-medium rounded-md transition-colors ${
              hasChanges
                ? "bg-indigo-600 text-white hover:bg-indigo-500"
                : "bg-gray-700 text-gray-500 cursor-not-allowed"
            }`}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <div className="mx-6 mt-3 px-4 py-2 bg-indigo-500/20 text-indigo-300 text-xs rounded-md border border-indigo-500/30">
          {toast}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {/* MCP Servers Section */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <div>
              <h2 className="text-sm font-semibold text-gray-200">
                MCP Servers
              </h2>
              <p className="text-xs text-gray-500 mt-0.5">
                Tool servers attached to every Copilot session. Changes apply on
                next interaction.
              </p>
            </div>
            <button
              onClick={() => setAddingServer(true)}
              disabled={addingServer}
              className="px-3 py-1.5 text-xs font-medium bg-[#2a2a4a] text-gray-300 hover:bg-[#3a3a5a] rounded-md transition-colors"
            >
              + Add Server
            </button>
          </div>

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
                  onEdit={() => setEditingServer(name)}
                  onRemove={() => removeServer(name)}
                />
              ),
            )}

            {serverEntries.length === 0 && !addingServer && (
              <div className="text-center py-8 text-gray-600 text-xs">
                No MCP servers configured. Add one to enable tool access.
              </div>
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
        </section>
      </div>
    </div>
  );
}

// ── Server Card (read-only display) ──────────────────────────────

function ServerCard({
  name,
  config,
  onEdit,
  onRemove,
}: {
  name: string;
  config: McpServerConfig;
  onEdit: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="bg-[#1e1e3a] border border-[#2a2a4a] rounded-lg p-4 group">
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-indigo-400">
              {name}
            </span>
            <span className="text-[10px] px-1.5 py-0.5 bg-green-500/20 text-green-400 rounded-full">
              active
            </span>
          </div>
          <div className="mt-2 space-y-1">
            <div className="text-xs text-gray-400">
              <span className="text-gray-600">command:</span>{" "}
              <code className="text-gray-300">{config.command}</code>
            </div>
            {config.args.length > 0 && (
              <div className="text-xs text-gray-400">
                <span className="text-gray-600">args:</span>{" "}
                <code className="text-gray-300 break-all">
                  {config.args.join(" ")}
                </code>
              </div>
            )}
            {config.tools && config.tools.length > 0 && (
              <div className="text-xs text-gray-400">
                <span className="text-gray-600">tools:</span>{" "}
                <code className="text-gray-300">
                  {config.tools.join(", ")}
                </code>
              </div>
            )}
            {config.env && Object.keys(config.env).length > 0 && (
              <div className="text-xs text-gray-400">
                <span className="text-gray-600">env:</span>{" "}
                <code className="text-gray-300">
                  {Object.keys(config.env).join(", ")}
                </code>
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={onEdit}
            className="p-1.5 text-gray-500 hover:text-indigo-400 transition-colors"
            title="Edit"
          >
            ✏️
          </button>
          <button
            onClick={onRemove}
            className="p-1.5 text-gray-500 hover:text-red-400 transition-colors"
            title="Remove"
          >
            🗑️
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Server Editor (add/edit form) ────────────────────────────────

function ServerEditor({
  name: initialName,
  config: initialConfig,
  existingNames,
  onSave,
  onCancel,
  isNew,
}: {
  name: string;
  config: McpServerConfig;
  existingNames: string[];
  onSave: (config: McpServerConfig, name?: string) => void;
  onCancel: () => void;
  isNew?: boolean;
}) {
  const [name, setName] = useState(initialName);
  const [command, setCommand] = useState(initialConfig.command);
  const [argsText, setArgsText] = useState(initialConfig.args.join("\n"));
  const [toolsText, setToolsText] = useState(
    initialConfig.tools?.join(", ") ?? "*",
  );
  const [envText, setEnvText] = useState(
    initialConfig.env
      ? Object.entries(initialConfig.env)
          .map(([k, v]) => `${k}=${v}`)
          .join("\n")
      : "",
  );

  const nameError =
    name.trim() === ""
      ? "Name is required"
      : existingNames.includes(name.trim())
        ? "Name already exists"
        : null;

  const commandError = command.trim() === "" ? "Command is required" : null;

  const canSave = !nameError && !commandError;

  const handleSubmit = () => {
    if (!canSave) return;

    const args = argsText
      .split("\n")
      .map((a) => a.trim())
      .filter(Boolean);
    const tools = toolsText
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const env: Record<string, string> = {};
    for (const line of envText.split("\n")) {
      const eq = line.indexOf("=");
      if (eq > 0) {
        env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
      }
    }

    const cfg: McpServerConfig = { command: command.trim(), args };
    if (tools.length > 0) cfg.tools = tools;
    if (Object.keys(env).length > 0) cfg.env = env;

    onSave(cfg, name.trim());
  };

  return (
    <div className="bg-[#1e1e3a] border border-indigo-500/30 rounded-lg p-4 space-y-3">
      <div className="text-xs font-semibold text-indigo-400 mb-2">
        {isNew ? "Add MCP Server" : `Edit: ${initialName}`}
      </div>

      {/* Name */}
      <Field label="Name" error={nameError}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. ado, github, filesystem"
          className="w-full bg-[#2a2a4a] text-gray-200 text-xs px-3 py-2 rounded-md border border-[#3a3a5a] focus:border-indigo-500 focus:outline-none"
          autoFocus={isNew}
        />
      </Field>

      {/* Command */}
      <Field label="Command" error={commandError}>
        <input
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          placeholder="e.g. npx, mcp-remote, node"
          className="w-full bg-[#2a2a4a] text-gray-200 text-xs px-3 py-2 rounded-md border border-[#3a3a5a] focus:border-indigo-500 focus:outline-none"
        />
      </Field>

      {/* Args */}
      <Field label="Arguments (one per line)">
        <textarea
          value={argsText}
          onChange={(e) => setArgsText(e.target.value)}
          placeholder={"mcp\nremote\n--url\nhttps://..."}
          rows={4}
          className="w-full bg-[#2a2a4a] text-gray-200 text-xs px-3 py-2 rounded-md border border-[#3a3a5a] focus:border-indigo-500 focus:outline-none font-mono resize-y"
        />
      </Field>

      {/* Tools */}
      <Field label="Tools filter (comma-separated)">
        <input
          value={toolsText}
          onChange={(e) => setToolsText(e.target.value)}
          placeholder="* (all tools)"
          className="w-full bg-[#2a2a4a] text-gray-200 text-xs px-3 py-2 rounded-md border border-[#3a3a5a] focus:border-indigo-500 focus:outline-none"
        />
      </Field>

      {/* Env */}
      <Field label="Environment variables (KEY=VALUE, one per line)">
        <textarea
          value={envText}
          onChange={(e) => setEnvText(e.target.value)}
          placeholder="API_KEY=abc123"
          rows={2}
          className="w-full bg-[#2a2a4a] text-gray-200 text-xs px-3 py-2 rounded-md border border-[#3a3a5a] focus:border-indigo-500 focus:outline-none font-mono resize-y"
        />
      </Field>

      {/* Actions */}
      <div className="flex justify-end gap-2 pt-1">
        <button
          onClick={onCancel}
          className="px-3 py-1.5 text-xs text-gray-400 hover:text-gray-200 transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={handleSubmit}
          disabled={!canSave}
          className={`px-4 py-1.5 text-xs font-medium rounded-md transition-colors ${
            canSave
              ? "bg-indigo-600 text-white hover:bg-indigo-500"
              : "bg-gray-700 text-gray-500 cursor-not-allowed"
          }`}
        >
          {isNew ? "Add" : "Update"}
        </button>
      </div>
    </div>
  );
}

// ── Field wrapper ────────────────────────────────────────────────

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string | null;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-1">
        {label}
      </label>
      {children}
      {error && <p className="text-[10px] text-red-400 mt-0.5">{error}</p>}
    </div>
  );
}
