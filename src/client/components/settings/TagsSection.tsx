import { useState } from "react";
import {
  fetchMcpServers,
  fetchTagMcpServers,
  setTagMcpServerRefs,
  type McpServer,
  type Tag,
  type TagMcpServer,
} from "../../api";
import {
  useCreateTagMutation,
  usePatchTagMutation,
  useDeleteTagMutation,
  useReorderTagsMutation,
} from "../../hooks/queries/useTags";
import { Pencil, Trash2, ArrowUp, ArrowDown } from "lucide-react";
import { TAG_COLORS } from "../../tag-colors";
import { TAG_COLOR_TEXT, TAG_COLOR_DOT } from "../../tag-colors";
import { SettingsSection } from "./SettingsSection";
import EmptyState from "../shared/EmptyState";
import { summarizeMcpServerConfig } from "./mcp-display";

export function getNextTagMcpServerIds(currentIds: string[], serverId: string, checked: boolean): string[] {
  return checked
    ? [...new Set([...currentIds, serverId])]
    : currentIds.filter((id) => id !== serverId);
}

export function TagMcpServerOption({
  server,
  checked,
  disabled,
  onChange,
}: {
  server: McpServer;
  checked: boolean;
  disabled: boolean;
  onChange: (serverId: string, checked: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-2 bg-bg-primary rounded px-2 py-1.5 text-xs">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(server.id, e.target.checked)}
        className="mt-0.5 h-3.5 w-3.5 accent-accent disabled:opacity-50"
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="font-mono text-text-primary truncate">{server.name}</span>
          {server.enabledByDefault && (
            <span className="rounded-full bg-accent/15 px-1.5 py-0.5 text-[9px] text-accent">
              default
            </span>
          )}
        </span>
        <span className="block truncate text-[10px] text-text-faint">
          {summarizeMcpServerConfig(server.config)}
        </span>
      </span>
    </label>
  );
}

export function TagsSection({
  tags,
}: {
  tags: Tag[];
}) {
  const createTagMutation = useCreateTagMutation();
  const patchTagMutation = usePatchTagMutation();
  const deleteTagMutation = useDeleteTagMutation();
  const reorderTagsMutation = useReorderTagsMutation();
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState<string>("blue");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editColor, setEditColor] = useState("");
  const [editInstructions, setEditInstructions] = useState("");
  const [availableMcpServers, setAvailableMcpServers] = useState<McpServer[]>([]);
  const [editMcpServers, setEditMcpServers] = useState<TagMcpServer[]>([]);
  const [loadingMcpServers, setLoadingMcpServers] = useState(false);
  const [savingMcpSelection, setSavingMcpSelection] = useState(false);
  const [mcpSelectionError, setMcpSelectionError] = useState<string | null>(null);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    try {
      await createTagMutation.mutateAsync({ name: newName.trim(), color: newColor });
      setNewName("");
      setNewColor("blue");
      setAdding(false);
    } catch (e) {
      console.error("Failed to create tag:", e);
    }
  };

  const startEditing = async (tag: Tag) => {
    setEditingId(tag.id);
    setEditName(tag.name);
    setEditColor(tag.color);
    setEditInstructions(tag.instructions);
    setEditMcpServers([]);
    setMcpSelectionError(null);
    setLoadingMcpServers(true);
    try {
      const [registryServers, selectedServers] = await Promise.all([
        fetchMcpServers(),
        fetchTagMcpServers(tag.id),
      ]);
      setAvailableMcpServers(registryServers);
      setEditMcpServers(selectedServers);
    } catch (e) {
      console.error("Failed to load tag MCP servers:", e);
      setAvailableMcpServers([]);
      setEditMcpServers([]);
      setMcpSelectionError(`Failed to load MCP servers: ${e instanceof Error ? e.message : e}`);
    } finally {
      setLoadingMcpServers(false);
    }
  };

  const handleSave = async (id: string) => {
    try {
      await patchTagMutation.mutateAsync({ id, updates: { name: editName, color: editColor, instructions: editInstructions } });
      setEditingId(null);
    } catch (e) {
      console.error("Failed to update tag:", e);
    }
  };

  const handleMcpSelectionChange = async (tagId: string, serverId: string, checked: boolean) => {
    const currentIds = editMcpServers.map((server) => server.serverId);
    const nextIds = getNextTagMcpServerIds(currentIds, serverId, checked);
    setSavingMcpSelection(true);
    setMcpSelectionError(null);
    try {
      setEditMcpServers(await setTagMcpServerRefs(tagId, nextIds));
    } catch (e) {
      console.error("Failed to update tag MCP servers:", e);
      setMcpSelectionError(`Failed to update MCP server selection: ${e instanceof Error ? e.message : e}`);
    } finally {
      setSavingMcpSelection(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteTagMutation.mutateAsync(id);
    } catch (e) {
      console.error("Failed to delete tag:", e);
    }
  };

  const handleMoveTag = (index: number, direction: -1 | 1) => {
    const newIndex = index + direction;
    if (newIndex < 0 || newIndex >= tags.length) return;
    const ids = tags.map((t) => t.id);
    [ids[index], ids[newIndex]] = [ids[newIndex], ids[index]];
    reorderTagsMutation.mutate(ids);
  };

  const selectedMcpServerIds = new Set(editMcpServers.map((server) => server.serverId));

  return (
    <SettingsSection
      title="Tags"
      description="Organize tasks, groups, and docs. Tags can carry custom instructions and select registered MCP servers."
      action={
        <button
          onClick={() => setAdding(true)}
          disabled={adding}
          className="px-3 py-1.5 text-xs font-medium bg-bg-surface text-text-secondary hover:bg-bg-hover rounded-md transition-colors"
        >
          + Add Tag
        </button>
      }
    >
      <div className="space-y-2">
        {tags.map((tag, tagIndex) =>
          editingId === tag.id ? (
            <div key={tag.id} className="bg-bg-surface border border-border rounded-lg p-3 space-y-3">
              <div className="flex items-center gap-2">
                <input
                  autoFocus
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="flex-1 text-sm bg-bg-primary border border-border rounded px-2 py-1 text-text-primary outline-none focus:border-accent"
                  placeholder="Tag name"
                />
                <div className="flex gap-1">
                  {TAG_COLORS.map((c) => (
                    <button
                      key={c}
                      onClick={() => setEditColor(c)}
                      className={`w-5 h-5 rounded-full ${TAG_COLOR_DOT[c]} ${editColor === c ? "ring-2 ring-accent ring-offset-1 ring-offset-bg-surface" : "opacity-60 hover:opacity-100"}`}
                      title={c}
                    />
                  ))}
                </div>
              </div>
              <textarea
                value={editInstructions}
                onChange={(e) => setEditInstructions(e.target.value)}
                placeholder="Custom instructions for sessions with this tag (optional)"
                className="w-full text-xs bg-bg-primary border border-border rounded px-2 py-1.5 text-text-primary outline-none focus:border-accent resize-none"
                rows={3}
              />
              <div>
                <div className="mb-1">
                  <span className="text-[11px] font-semibold text-text-muted uppercase tracking-wider">MCP Servers</span>
                  <p className="mt-0.5 text-[10px] text-text-faint">
                    Select registered servers to add when this tag is present. Selections save immediately; edit definitions in MCP Servers settings.
                  </p>
                </div>
                {mcpSelectionError && (
                  <div className="mb-2 rounded border border-error/20 bg-error/10 px-2 py-1 text-[10px] text-error">
                    {mcpSelectionError}
                  </div>
                )}
                {loadingMcpServers ? (
                  <div className="text-[10px] text-text-faint py-1">Loading MCP servers…</div>
                ) : availableMcpServers.length === 0 ? (
                  <div className="text-[10px] text-text-faint py-1">
                    No registered MCP servers. Add definitions in MCP Servers settings first.
                  </div>
                ) : (
                  <div className="space-y-1">
                    {availableMcpServers.map((server) => (
                      <TagMcpServerOption
                        key={server.id}
                        server={server}
                        checked={selectedMcpServerIds.has(server.id)}
                        disabled={savingMcpSelection}
                        onChange={(serverId, checked) => handleMcpSelectionChange(tag.id, serverId, checked)}
                      />
                    ))}
                  </div>
                )}
                {editMcpServers.length > 0 && (
                  <div className="mt-2 rounded bg-bg-primary px-2 py-1.5">
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-text-faint">
                      Selected for this tag
                    </div>
                    <div className="mt-1 space-y-0.5">
                      {editMcpServers.map((server) => (
                        <div key={server.serverId} className="flex gap-2 text-[10px] text-text-muted">
                          <span className="font-mono text-text-secondary">{server.serverName}</span>
                          <span className="truncate text-text-faint">{summarizeMcpServerConfig(server.config)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
              <div className="flex justify-end gap-2">
                <button onClick={() => setEditingId(null)} className="text-xs text-text-muted hover:text-text-primary px-2 py-1">
                  Cancel
                </button>
                <button
                  onClick={() => handleSave(tag.id)}
                  className="text-xs bg-accent text-white px-3 py-1 rounded hover:bg-accent-hover"
                >
                  Save
                </button>
              </div>
            </div>
          ) : (
            <div key={tag.id} className="flex items-center gap-3 bg-bg-surface border border-border rounded-lg px-3 py-2.5 group">
              <span className={`w-3 h-3 rounded-full shrink-0 ${TAG_COLOR_DOT[tag.color] ?? "bg-slate-500"}`} />
              <div className="flex-1 min-w-0">
                <div className={`text-sm font-medium ${TAG_COLOR_TEXT[tag.color] ?? "text-slate-400"}`}>
                  {tag.name}
                </div>
                {tag.instructions && (
                  <div className="text-[10px] text-text-faint mt-0.5 truncate">
                    {tag.instructions.slice(0, 80)}{tag.instructions.length > 80 ? "…" : ""}
                  </div>
                )}
              </div>
              <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                {tags.length > 1 && (
                  <>
                    <button
                      onClick={() => handleMoveTag(tagIndex, -1)}
                      disabled={tagIndex === 0}
                      className="p-1 text-text-muted hover:text-text-primary rounded disabled:opacity-30"
                      title="Move up"
                    >
                      <ArrowUp size={12} />
                    </button>
                    <button
                      onClick={() => handleMoveTag(tagIndex, 1)}
                      disabled={tagIndex === tags.length - 1}
                      className="p-1 text-text-muted hover:text-text-primary rounded disabled:opacity-30"
                      title="Move down"
                    >
                      <ArrowDown size={12} />
                    </button>
                  </>
                )}
                <button
                  onClick={() => startEditing(tag)}
                  className="p-1 text-text-muted hover:text-text-primary rounded"
                  title="Edit"
                >
                  <Pencil size={12} />
                </button>
                <button
                  onClick={() => handleDelete(tag.id)}
                  className="p-1 text-text-muted hover:text-error rounded"
                  title="Delete"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
          ),
        )}

        {tags.length === 0 && !adding && (
          <EmptyState
            message="No tags yet"
            sub="Create one to organize your tasks and docs"
          />
        )}

        {adding && (
          <div className="bg-bg-surface border border-border rounded-lg p-3 space-y-3">
            <div className="flex items-center gap-2">
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleCreate(); if (e.key === "Escape") setAdding(false); }}
                className="flex-1 text-sm bg-bg-primary border border-border rounded px-2 py-1 text-text-primary outline-none focus:border-accent"
                placeholder="Tag name"
              />
              <div className="flex gap-1">
                {TAG_COLORS.map((c) => (
                  <button
                    key={c}
                    onClick={() => setNewColor(c)}
                    className={`w-5 h-5 rounded-full ${TAG_COLOR_DOT[c]} ${newColor === c ? "ring-2 ring-accent ring-offset-1 ring-offset-bg-surface" : "opacity-60 hover:opacity-100"}`}
                    title={c}
                  />
                ))}
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setAdding(false)} className="text-xs text-text-muted hover:text-text-primary px-2 py-1">
                Cancel
              </button>
              <button
                onClick={handleCreate}
                disabled={!newName.trim()}
                className="text-xs bg-accent text-white px-3 py-1 rounded hover:bg-accent-hover disabled:opacity-50"
              >
                Create
              </button>
            </div>
          </div>
        )}
      </div>
    </SettingsSection>
  );
}
