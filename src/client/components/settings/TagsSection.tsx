import { useState } from "react";
import {
  fetchTagMcpServers,
  setTagMcpServer,
  removeTagMcpServer,
  type Tag,
  type McpServerConfig,
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

export function TagsSection({
  tags,
  setTags,
}: {
  tags: Tag[];
  setTags: (t: Tag[]) => void;
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
  const [editMcpServers, setEditMcpServers] = useState<TagMcpServer[]>([]);
  const [addingMcp, setAddingMcp] = useState(false);
  const [mcpName, setMcpName] = useState("");
  const [mcpCommand, setMcpCommand] = useState("");
  const [mcpArgs, setMcpArgs] = useState("");

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
    setAddingMcp(false);
    try {
      const servers = await fetchTagMcpServers(tag.id);
      setEditMcpServers(servers);
    } catch {
      setEditMcpServers([]);
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

  const handleAddMcp = async (tagId: string) => {
    if (!mcpName.trim() || !mcpCommand.trim()) return;
    try {
      const config: McpServerConfig = {
        command: mcpCommand.trim(),
        args: mcpArgs.trim() ? mcpArgs.trim().split("\n") : [],
      };
      await setTagMcpServer(tagId, mcpName.trim(), config);
      setEditMcpServers((prev) => [...prev, { serverName: mcpName.trim(), config }]);
      setMcpName("");
      setMcpCommand("");
      setMcpArgs("");
      setAddingMcp(false);
    } catch (e) {
      console.error("Failed to add MCP server:", e);
    }
  };

  const handleRemoveMcp = async (tagId: string, serverName: string) => {
    try {
      await removeTagMcpServer(tagId, serverName);
      setEditMcpServers((prev) => prev.filter((s) => s.serverName !== serverName));
    } catch (e) {
      console.error("Failed to remove MCP server:", e);
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

  return (
    <SettingsSection
      title="Tags"
      description="Organize tasks, groups, and docs. Tags can carry custom instructions and MCP servers."
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
              {/* MCP Servers for this tag */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[11px] font-semibold text-text-muted uppercase tracking-wider">MCP Servers</span>
                  <button
                    onClick={() => setAddingMcp(true)}
                    className="text-[10px] text-accent hover:text-accent-hover"
                  >
                    + Add
                  </button>
                </div>
                {editMcpServers.map((srv) => (
                  <div key={srv.serverName} className="flex items-center gap-2 bg-bg-primary rounded px-2 py-1 mb-1 text-xs">
                    <span className="font-mono text-text-primary flex-1 truncate">{srv.serverName}</span>
                    <span className="text-text-faint truncate">{srv.config.command}</span>
                    <button
                      onClick={() => handleRemoveMcp(tag.id, srv.serverName)}
                      className="text-text-faint hover:text-error shrink-0"
                    >
                      <Trash2 size={10} />
                    </button>
                  </div>
                ))}
                {editMcpServers.length === 0 && !addingMcp && (
                  <div className="text-[10px] text-text-faint py-1">No tag-specific MCP servers</div>
                )}
                {addingMcp && (
                  <div className="bg-bg-primary rounded p-2 space-y-1.5 mt-1">
                    <input
                      autoFocus
                      value={mcpName}
                      onChange={(e) => setMcpName(e.target.value)}
                      placeholder="Server name"
                      className="w-full text-xs bg-bg-surface border border-border rounded px-2 py-1 text-text-primary outline-none focus:border-accent"
                    />
                    <input
                      value={mcpCommand}
                      onChange={(e) => setMcpCommand(e.target.value)}
                      placeholder="Command (e.g. npx, uvx)"
                      className="w-full text-xs bg-bg-surface border border-border rounded px-2 py-1 text-text-primary outline-none focus:border-accent"
                    />
                    <textarea
                      value={mcpArgs}
                      onChange={(e) => setMcpArgs(e.target.value)}
                      placeholder="Args (one per line)"
                      className="w-full text-xs bg-bg-surface border border-border rounded px-2 py-1 text-text-primary outline-none focus:border-accent resize-none"
                      rows={2}
                    />
                    <div className="flex justify-end gap-2">
                      <button onClick={() => setAddingMcp(false)} className="text-[10px] text-text-muted hover:text-text-primary px-1.5 py-0.5">Cancel</button>
                      <button
                        onClick={() => handleAddMcp(tag.id)}
                        disabled={!mcpName.trim() || !mcpCommand.trim()}
                        className="text-[10px] bg-accent text-white px-2 py-0.5 rounded hover:bg-accent-hover disabled:opacity-50"
                      >
                        Add
                      </button>
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
