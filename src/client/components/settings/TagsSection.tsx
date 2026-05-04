import { useRef, useState } from "react";
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
import { ArrowDown, ArrowUp, Check, Pencil, Trash2 } from "lucide-react";
import {
  TAG_COLORS,
  TAG_COLOR_BG,
  TAG_COLOR_BORDER,
  TAG_COLOR_DOT,
  TAG_COLOR_TEXT,
} from "../../tag-colors";
import { SettingsSection } from "./SettingsSection";
import EmptyState from "../shared/EmptyState";
import { summarizeMcpServerConfig } from "./mcp-display";

const iconButtonClass =
  "inline-flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-30";

export function getNextTagMcpServerIds(currentIds: string[], serverId: string, checked: boolean): string[] {
  return checked
    ? [...new Set([...currentIds, serverId])]
    : currentIds.filter((id) => id !== serverId);
}

function TagMetaBadge({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border border-border bg-bg-primary px-2 py-0.5 text-[10px] font-medium text-text-muted">
      {children}
    </span>
  );
}

function TagPillPreview({
  name,
  color,
}: {
  name: string;
  color: string;
}) {
  const bg = TAG_COLOR_BG[color] ?? "bg-slate-500/15";
  const border = TAG_COLOR_BORDER[color] ?? "border-slate-500/30";
  const dot = TAG_COLOR_DOT[color] ?? "bg-slate-500";
  const text = TAG_COLOR_TEXT[color] ?? "text-slate-400";

  return (
    <span className={`inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${bg} ${border} ${text}`}>
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
      <span className="truncate">{name || "Untitled tag"}</span>
    </span>
  );
}

function TagColorPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (color: string) => void;
}) {
  return (
    <div>
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
        Color
      </div>
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Tag color">
        {TAG_COLORS.map((color) => {
          const selected = value === color;
          return (
            <button
              key={color}
              type="button"
              onClick={() => onChange(color)}
              aria-label={`Use ${color} tag color`}
              aria-pressed={selected}
              className={`inline-flex h-7 w-7 items-center justify-center rounded-full ${TAG_COLOR_DOT[color]} transition ${
                selected
                  ? "ring-2 ring-accent ring-offset-2 ring-offset-bg-surface"
                  : "opacity-70 hover:scale-105 hover:opacity-100"
              }`}
              title={color}
            >
              {selected && <Check size={14} className="text-white drop-shadow" />}
            </button>
          );
        })}
      </div>
    </div>
  );
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
    <label
      className={`flex items-start gap-3 rounded-lg border px-3 py-2 text-xs transition-colors ${
        checked
          ? "border-accent/30 bg-accent/10"
          : "border-border bg-bg-primary hover:bg-bg-hover"
      } ${disabled ? "cursor-not-allowed opacity-70" : "cursor-pointer"}`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(server.id, e.target.checked)}
        className="mt-0.5 h-3.5 w-3.5 accent-accent disabled:opacity-50"
      />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-mono text-text-primary">{server.name}</span>
          {server.enabledByDefault && (
            <span className="shrink-0 rounded-full bg-accent/15 px-1.5 py-0.5 text-[9px] font-medium text-accent">
              default
            </span>
          )}
        </span>
        <span className="mt-0.5 block truncate text-[10px] text-text-faint">
          {summarizeMcpServerConfig(server.config)}
        </span>
      </span>
    </label>
  );
}

function TagMcpServerPicker({
  tagId,
  availableMcpServers,
  selectedMcpServerIds,
  loadingMcpServers,
  savingMcpSelection,
  mcpSelectionError,
  onChange,
}: {
  tagId: string;
  availableMcpServers: McpServer[];
  selectedMcpServerIds: Set<string>;
  loadingMcpServers: boolean;
  savingMcpSelection: boolean;
  mcpSelectionError: string | null;
  onChange: (tagId: string, serverId: string, checked: boolean) => void;
}) {
  return (
    <section className="rounded-lg border border-border bg-bg-elevated p-3">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
            MCP Servers
          </div>
          <p className="mt-0.5 text-[10px] leading-4 text-text-faint">
            Select registered servers to attach when this tag is present.
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <TagMetaBadge>{selectedMcpServerIds.size} selected</TagMetaBadge>
          <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-medium text-accent">
            Saved automatically
          </span>
        </div>
      </div>

      {mcpSelectionError && (
        <div className="mb-2 rounded-md border border-error/20 bg-error/10 px-3 py-2 text-[10px] text-error">
          {mcpSelectionError}
        </div>
      )}

      {loadingMcpServers ? (
        <div className="rounded-md border border-border bg-bg-primary px-3 py-2 text-xs text-text-muted">
          Loading MCP servers…
        </div>
      ) : availableMcpServers.length === 0 ? (
        <div className="rounded-md border border-dashed border-border bg-bg-primary px-3 py-3 text-xs text-text-faint">
          No registered MCP servers. Add definitions in MCP Servers settings first.
        </div>
      ) : (
        <div className="space-y-1.5">
          {availableMcpServers.map((server) => (
            <TagMcpServerOption
              key={server.id}
              server={server}
              checked={selectedMcpServerIds.has(server.id)}
              disabled={savingMcpSelection}
              onChange={(serverId, checked) => onChange(tagId, serverId, checked)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function TagCard({
  tag,
  tagIndex,
  tagCount,
  onMove,
  onEdit,
  onDelete,
}: {
  tag: Tag;
  tagIndex: number;
  tagCount: number;
  onMove: (index: number, direction: -1 | 1) => void;
  onEdit: (tag: Tag) => void;
  onDelete: (tag: Tag) => void;
}) {
  const hasInstructions = tag.instructions.trim().length > 0;

  return (
    <div className="rounded-xl border border-border bg-bg-surface transition-colors hover:bg-bg-elevated">
      <div className="flex items-stretch">
        <button
          type="button"
          onClick={() => onEdit(tag)}
          className="min-w-0 flex-1 rounded-l-xl bg-transparent p-4 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg-primary"
          aria-label={`Edit ${tag.name}`}
        >
          <div className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <TagPillPreview name={tag.name} color={tag.color} />
              {hasInstructions && <TagMetaBadge>instructions</TagMetaBadge>}
            </div>
            {hasInstructions ? (
              <p className="line-clamp-2 text-xs leading-5 text-text-muted">
                {tag.instructions}
              </p>
            ) : (
              <p className="text-xs text-text-faint">No custom instructions.</p>
            )}
          </div>
        </button>

        <div className="flex shrink-0 items-center gap-1 p-4 pl-0">
          {tagCount > 1 && (
            <>
              <button
                type="button"
                onClick={() => onMove(tagIndex, -1)}
                disabled={tagIndex === 0}
                className={iconButtonClass}
                title="Move up"
                aria-label={`Move ${tag.name} up`}
              >
                <ArrowUp size={13} />
              </button>
              <button
                type="button"
                onClick={() => onMove(tagIndex, 1)}
                disabled={tagIndex === tagCount - 1}
                className={iconButtonClass}
                title="Move down"
                aria-label={`Move ${tag.name} down`}
              >
                <ArrowDown size={13} />
              </button>
            </>
          )}
          <button
            type="button"
            onClick={() => onEdit(tag)}
            className={iconButtonClass}
            title="Edit"
            aria-label={`Edit ${tag.name}`}
          >
            <Pencil size={13} />
          </button>
          <button
            type="button"
            onClick={() => onDelete(tag)}
            className={`${iconButtonClass} hover:text-error`}
            title="Delete"
            aria-label={`Delete ${tag.name}`}
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>
    </div>
  );
}

function CreateTagCard({
  newName,
  newColor,
  saving,
  onNameChange,
  onColorChange,
  onCreate,
  onCancel,
}: {
  newName: string;
  newColor: string;
  saving: boolean;
  onNameChange: (name: string) => void;
  onColorChange: (color: string) => void;
  onCreate: () => void;
  onCancel: () => void;
}) {
  const canCreate = newName.trim().length > 0 && !saving;

  return (
    <div className="rounded-xl border border-accent/20 bg-bg-surface p-4 shadow-sm">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-text-primary">Create tag</h3>
          <p className="mt-0.5 text-xs text-text-muted">
            Add a reusable label for tasks, groups, and docs.
          </p>
        </div>
        <TagPillPreview name={newName} color={newColor} />
      </div>

      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto]">
        <label>
          <span className="mb-2 block text-[11px] font-semibold uppercase tracking-wider text-text-muted">
            Name
          </span>
          <input
            autoFocus
            value={newName}
            onChange={(e) => onNameChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canCreate) onCreate();
              if (e.key === "Escape") onCancel();
            }}
            className="w-full rounded-md border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary outline-none transition-colors placeholder:text-text-faint focus:border-accent"
            placeholder="Tag name"
          />
        </label>
        <TagColorPicker value={newColor} onChange={onColorChange} />
      </div>

      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md px-3 py-1.5 text-xs text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onCreate}
          disabled={!canCreate}
          className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? "Creating…" : "Create"}
        </button>
      </div>
    </div>
  );
}

function EditTagCard({
  tag,
  editName,
  editColor,
  editInstructions,
  saving,
  availableMcpServers,
  selectedMcpServerIds,
  loadingMcpServers,
  savingMcpSelection,
  mcpSelectionError,
  onNameChange,
  onColorChange,
  onInstructionsChange,
  onSave,
  onCancel,
  onMcpSelectionChange,
}: {
  tag: Tag;
  editName: string;
  editColor: string;
  editInstructions: string;
  saving: boolean;
  availableMcpServers: McpServer[];
  selectedMcpServerIds: Set<string>;
  loadingMcpServers: boolean;
  savingMcpSelection: boolean;
  mcpSelectionError: string | null;
  onNameChange: (name: string) => void;
  onColorChange: (color: string) => void;
  onInstructionsChange: (instructions: string) => void;
  onSave: (id: string) => void;
  onCancel: () => void;
  onMcpSelectionChange: (tagId: string, serverId: string, checked: boolean) => void;
}) {
  const canSave = editName.trim().length > 0 && !saving;

  return (
    <div className="rounded-xl border border-accent/20 bg-bg-surface p-4 shadow-sm">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-text-primary">Edit tag</h3>
          <p className="mt-0.5 text-xs text-text-muted">
            Basics and instructions save together. MCP server selections save immediately.
          </p>
        </div>
        <TagPillPreview name={editName} color={editColor} />
      </div>

      <div className="space-y-4">
        <section className="rounded-lg border border-border bg-bg-elevated p-3">
          <div className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
            Basics
          </div>
          <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto]">
            <label>
              <span className="mb-2 block text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                Name
              </span>
              <input
                autoFocus
                value={editName}
                onChange={(e) => onNameChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && canSave) onSave(tag.id);
                  if (e.key === "Escape") onCancel();
                }}
                className="w-full rounded-md border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary outline-none transition-colors placeholder:text-text-faint focus:border-accent"
                placeholder="Tag name"
              />
            </label>
            <TagColorPicker value={editColor} onChange={onColorChange} />
          </div>
        </section>

        <section className="rounded-lg border border-border bg-bg-elevated p-3">
          <label>
            <span className="mb-2 block text-[11px] font-semibold uppercase tracking-wider text-text-muted">
              Instructions
            </span>
            <textarea
              value={editInstructions}
              onChange={(e) => onInstructionsChange(e.target.value)}
              placeholder="Custom instructions for sessions with this tag (optional)"
              className="min-h-24 w-full resize-y rounded-md border border-border bg-bg-primary px-3 py-2 text-xs leading-5 text-text-primary outline-none transition-colors placeholder:text-text-faint focus:border-accent"
              rows={4}
            />
          </label>
        </section>

        <TagMcpServerPicker
          tagId={tag.id}
          availableMcpServers={availableMcpServers}
          selectedMcpServerIds={selectedMcpServerIds}
          loadingMcpServers={loadingMcpServers}
          savingMcpSelection={savingMcpSelection}
          mcpSelectionError={mcpSelectionError}
          onChange={onMcpSelectionChange}
        />
      </div>

      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md px-3 py-1.5 text-xs text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => onSave(tag.id)}
          disabled={!canSave}
          className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
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
  const editLoadRequestRef = useRef(0);
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

  const cancelEditing = () => {
    editLoadRequestRef.current += 1;
    setEditingId(null);
    setLoadingMcpServers(false);
    setMcpSelectionError(null);
  };

  const handleCreate = async () => {
    const trimmedName = newName.trim();
    if (!trimmedName) return;
    try {
      await createTagMutation.mutateAsync({ name: trimmedName, color: newColor });
      setNewName("");
      setNewColor("blue");
      setAdding(false);
    } catch (e) {
      console.error("Failed to create tag:", e);
    }
  };

  const startEditing = async (tag: Tag) => {
    const requestId = editLoadRequestRef.current + 1;
    editLoadRequestRef.current = requestId;
    setAdding(false);
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
      if (editLoadRequestRef.current !== requestId) return;
      setAvailableMcpServers(registryServers);
      setEditMcpServers(selectedServers);
    } catch (e) {
      if (editLoadRequestRef.current !== requestId) return;
      console.error("Failed to load tag MCP servers:", e);
      setAvailableMcpServers([]);
      setEditMcpServers([]);
      setMcpSelectionError(`Failed to load MCP servers: ${e instanceof Error ? e.message : e}`);
    } finally {
      if (editLoadRequestRef.current === requestId) setLoadingMcpServers(false);
    }
  };

  const handleSave = async (id: string) => {
    const trimmedName = editName.trim();
    if (!trimmedName) return;
    try {
      await patchTagMutation.mutateAsync({
        id,
        updates: {
          name: trimmedName,
          color: editColor,
          instructions: editInstructions,
        },
      });
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

  const handleDelete = async (tag: Tag) => {
    const confirmed = window.confirm(
      `Delete tag "${tag.name}"?\n\nThis can't be undone.`,
    );
    if (!confirmed) return;

    try {
      await deleteTagMutation.mutateAsync(tag.id);
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
          type="button"
          onClick={() => {
            cancelEditing();
            setAdding(true);
          }}
          disabled={adding}
          className="rounded-md bg-bg-surface px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          + Add Tag
        </button>
      }
    >
      <div className="space-y-3">
        {tags.map((tag, tagIndex) =>
          editingId === tag.id ? (
            <EditTagCard
              key={tag.id}
              tag={tag}
              editName={editName}
              editColor={editColor}
              editInstructions={editInstructions}
              saving={patchTagMutation.isPending}
              availableMcpServers={availableMcpServers}
              selectedMcpServerIds={selectedMcpServerIds}
              loadingMcpServers={loadingMcpServers}
              savingMcpSelection={savingMcpSelection}
              mcpSelectionError={mcpSelectionError}
              onNameChange={setEditName}
              onColorChange={setEditColor}
              onInstructionsChange={setEditInstructions}
              onSave={handleSave}
              onCancel={cancelEditing}
              onMcpSelectionChange={handleMcpSelectionChange}
            />
          ) : (
            <TagCard
              key={tag.id}
              tag={tag}
              tagIndex={tagIndex}
              tagCount={tags.length}
              onMove={handleMoveTag}
              onEdit={startEditing}
              onDelete={handleDelete}
            />
          ),
        )}

        {tags.length === 0 && !adding && (
          <EmptyState
            message="No tags yet"
            sub="Create one to organize your tasks and docs"
            action={() => setAdding(true)}
            actionLabel="Add tag"
          />
        )}

        {adding && (
          <CreateTagCard
            newName={newName}
            newColor={newColor}
            saving={createTagMutation.isPending}
            onNameChange={setNewName}
            onColorChange={setNewColor}
            onCreate={handleCreate}
            onCancel={() => setAdding(false)}
          />
        )}
      </div>
    </SettingsSection>
  );
}
