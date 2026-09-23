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
import { ArrowDown, ArrowUp, Check, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import {
  TAG_COLORS,
  TAG_COLOR_BG,
  TAG_COLOR_BORDER,
  TAG_COLOR_DOT,
  TAG_COLOR_TEXT,
} from "../../tag-colors";
import { SettingsSection } from "./SettingsSection";
import { summarizeMcpServerConfig } from "./mcp-display";
import { DS, cx } from "../../design/tokens";
import ContextMenu, { CtxDivider, CtxItem, type ContextMenuPosition } from "../ContextMenu";
import { Button, EmptyHint, IdentitySwatch, SettingList } from "../../design/primitives";

const iconButtonClass =
  cx(DS.button.base, DS.button.icon.sm, DS.button.variant.ghost, "disabled:opacity-30");

export function getNextTagMcpServerIds(currentIds: string[], serverId: string, checked: boolean): string[] {
  return checked
    ? [...new Set([...currentIds, serverId])]
    : currentIds.filter((id) => id !== serverId);
}

function TagMetaBadge({ children }: { children: React.ReactNode }) {
  return (
    <span className={cx(DS.badge.base, "border-border bg-bg-primary text-text-muted")}>
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
  const bg = TAG_COLOR_BG[color] ?? TAG_COLOR_BG.slate;
  const border = TAG_COLOR_BORDER[color] ?? TAG_COLOR_BORDER.slate;
  const text = TAG_COLOR_TEXT[color] ?? TAG_COLOR_TEXT.slate;

  return (
    <span className={cx(DS.badge.base, "max-w-full items-center gap-1.5 text-xs font-semibold", bg, border, text)}>
      <IdentitySwatch color={color} />
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
      <div className="mb-2 text-xs font-semibold tracking-wide text-text-secondary">
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
              className={cx(DS.button.base, DS.button.icon.md, DS.button.variant.ghost, selected && DS.row.selected)}
              title={color}
            >
              <span aria-hidden="true" className={cx("size-4 rounded-[4px]", TAG_COLOR_DOT[color])} />
              {selected && <Check size={12} className="ml-0.5 text-text-primary" />}
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
      className={cx("flex items-start gap-3 rounded-lg border px-3 py-2 text-xs transition-colors", checked
          ? cx(DS.notice.surface, DS.choice.selected, DS.row.selected)
          : "border-border bg-bg-primary hover:bg-bg-hover", disabled ? "cursor-not-allowed opacity-70" : "cursor-pointer")}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(server.id, e.target.checked)}
        className={cx(DS.control.checkbox, "mt-0.5 h-3.5 w-3.5 disabled:opacity-50")}
      />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-mono text-text-primary">{server.name}</span>
          {server.enabledByDefault && (
            <span className={cx(DS.badge.base, DS.row.selected, "shrink-0 text-[9px] text-accent")}>
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
    <section className={DS.layout.formGroup}>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="text-xs font-semibold tracking-wide text-text-secondary">
            MCP Servers
          </div>
          <p className="mt-0.5 text-[10px] leading-4 text-text-faint">
            Select registered servers to attach when this tag is present.
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <TagMetaBadge>{selectedMcpServerIds.size} selected</TagMetaBadge>
          <span className={cx(DS.badge.base, DS.row.selected, "text-accent")}>
            Saved automatically
          </span>
        </div>
      </div>

      {mcpSelectionError && (
        <div className={cx(DS.notice.surface, "mb-2 px-3 py-2 text-[10px] text-error")}>
          {mcpSelectionError}
        </div>
      )}

      {loadingMcpServers ? (
        <div className={cx(DS.layout.formGroup, "text-xs text-text-muted")}>
          Loading MCP servers…
        </div>
      ) : availableMcpServers.length === 0 ? (
        <div className={cx(DS.layout.formGroup, DS.text.empty, "text-xs text-text-faint")}>
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
  const [menu, setMenu] = useState<ContextMenuPosition | null>(null);

  return (
    <div className="min-w-0 py-1 first:pt-0 last:pb-0">
      <div className="flex min-w-0 items-center gap-1">
        <button
          type="button"
          onClick={() => onEdit(tag)}
          className={cx(DS.row.base, DS.row.touch, DS.row.interactive, "flex-1 gap-2.5")}
          aria-label={`Edit ${tag.name}`}
        >
          <TagPillPreview name={tag.name} color={tag.color} />
          {hasInstructions && (
            <span className="min-w-0 flex-1 truncate text-xs text-text-secondary" title={tag.instructions}>
              {tag.instructions}
            </span>
          )}
        </button>

        <button type="button" aria-label={`Actions for ${tag.name}`} aria-haspopup="menu" aria-expanded={Boolean(menu)}
          className={iconButtonClass}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            setMenu({ x: rect.right - 180, y: rect.bottom + 4 });
          }}>
          <MoreHorizontal size={15} />
        </button>
      </div>
      {menu && <ContextMenu position={menu} onClose={() => setMenu(null)}>
        <CtxItem icon={<Pencil size={14} />} label={`Edit ${tag.name}`} onClick={() => { setMenu(null); onEdit(tag); }} />
        {tagCount > 1 && <>
          <CtxItem icon={<ArrowUp size={14} />} label="Move up" disabled={tagIndex === 0} onClick={() => { setMenu(null); onMove(tagIndex, -1); }} />
          <CtxItem icon={<ArrowDown size={14} />} label="Move down" disabled={tagIndex === tagCount - 1} onClick={() => { setMenu(null); onMove(tagIndex, 1); }} />
        </>}
        <CtxDivider />
        <CtxItem icon={<Trash2 size={14} />} label={`Delete ${tag.name}`} className="text-error" onClick={() => { setMenu(null); onDelete(tag); }} />
      </ContextMenu>}
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
    <div className={cx(DS.layout.formGroup, DS.choice.selected)}>
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
          <span className="mb-2 block text-xs font-semibold tracking-wide text-text-secondary">
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
            className={cx(DS.field.input, DS.field.inputSize.md, DS.focus, "outline-none")}
            placeholder="Tag name"
          />
        </label>
        <TagColorPicker value={newColor} onChange={onColorChange} />
      </div>

      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className={cx(DS.button.base, DS.button.size.sm, DS.button.variant.ghost)}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onCreate}
          disabled={!canCreate}
          className={cx(DS.button.base, DS.button.size.sm, DS.button.variant.primary, "disabled:opacity-50")}
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
    <div className={cx(DS.layout.formGroup, DS.choice.selected)}>
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
        <section className={DS.layout.formGroup}>
          <div className="mb-3 text-xs font-semibold tracking-wide text-text-secondary">
            Basics
          </div>
          <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto]">
            <label>
              <span className="mb-2 block text-xs font-semibold tracking-wide text-text-secondary">
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
                className={cx(DS.field.input, DS.field.inputSize.md, DS.focus, "outline-none")}
                placeholder="Tag name"
              />
            </label>
            <TagColorPicker value={editColor} onChange={onColorChange} />
          </div>
        </section>

        <section className={DS.layout.formGroup}>
          <label>
            <span className="mb-2 block text-xs font-semibold tracking-wide text-text-secondary">
              Instructions
            </span>
            <textarea
              value={editInstructions}
              onChange={(e) => onInstructionsChange(e.target.value)}
              placeholder="Custom instructions for sessions with this tag (optional)"
              className={cx(DS.field.input, DS.field.textarea, DS.focus, "min-h-24 resize-y leading-5 outline-none")}
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
          className={cx(DS.button.base, DS.button.size.sm, DS.button.variant.ghost)}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => onSave(tag.id)}
          disabled={!canSave}
          className={cx(DS.button.base, DS.button.size.sm, DS.button.variant.primary, "disabled:opacity-50")}
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
      title="All tags"
      count={tags.length}
      description="Tags can add instructions and MCP servers to the sessions they are on."
      action={
        <Button
          size="sm"
          variant="ghost"
          icon={<Plus size={13} />}
          onClick={() => {
            cancelEditing();
            setAdding(true);
          }}
          disabled={adding}
        >
          Add tag
        </Button>
      }
    >
      <SettingList>
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
          <EmptyHint>No tags yet. Add one to organize tasks and docs.</EmptyHint>
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
      </SettingList>
    </SettingsSection>
  );
}
