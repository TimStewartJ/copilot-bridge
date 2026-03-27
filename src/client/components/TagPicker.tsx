import { useState, useRef, useEffect, useMemo } from "react";
import type { Tag } from "../api";
import { createTag } from "../api";
import TagPill from "./TagPill";
import { TAG_COLOR_BG, TAG_COLOR_TEXT } from "../tag-colors";
import { Plus, Search } from "lucide-react";

interface TagPickerProps {
  /** All available tags */
  allTags: Tag[];
  /** Currently selected tag IDs (own tags, not inherited) */
  selectedTagIds: string[];
  /** Inherited tag IDs (shown but not removable) */
  inheritedTagIds?: Set<string>;
  /** Called when selection changes (only own tags, not inherited) */
  onChange: (tagIds: string[]) => void;
  /** Called when a new tag is created */
  onTagCreated?: (tag: Tag) => void;
  /** Compact mode — just a + button */
  compact?: boolean;
}

export default function TagPicker({
  allTags,
  selectedTagIds,
  inheritedTagIds,
  onChange,
  onTagCreated,
  compact,
}: TagPickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setSearch("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Focus input on open
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const filtered = useMemo(() => {
    if (!search) return allTags;
    const q = search.toLowerCase();
    return allTags.filter((t) => t.name.toLowerCase().includes(q));
  }, [allTags, search]);

  const selectedSet = useMemo(() => new Set(selectedTagIds), [selectedTagIds]);
  const allSelectedSet = useMemo(() => {
    const s = new Set(selectedTagIds);
    if (inheritedTagIds) for (const id of inheritedTagIds) s.add(id);
    return s;
  }, [selectedTagIds, inheritedTagIds]);

  const canCreate = search.trim() && !allTags.some((t) => t.name.toLowerCase() === search.trim().toLowerCase());

  const toggle = (tagId: string) => {
    if (inheritedTagIds?.has(tagId)) return;
    if (selectedSet.has(tagId)) {
      onChange(selectedTagIds.filter((id) => id !== tagId));
    } else {
      onChange([...selectedTagIds, tagId]);
    }
  };

  const handleCreate = async () => {
    if (!canCreate || creating) return;
    setCreating(true);
    try {
      const tag = await createTag(search.trim());
      onTagCreated?.(tag);
      onChange([...selectedTagIds, tag.id]);
      setSearch("");
    } catch (e) {
      console.error("Failed to create tag:", e);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div ref={containerRef} className="relative inline-block">
      <button
        onClick={() => setOpen(!open)}
        className={`inline-flex items-center gap-1 text-text-muted hover:text-text-primary transition-colors ${
          compact
            ? "p-0.5"
            : "text-[10px] px-1.5 py-0.5 rounded-full bg-bg-hover hover:bg-bg-elevated"
        }`}
        title="Manage tags"
      >
        <Plus size={compact ? 12 : 10} />
        {!compact && <span>Tag</span>}
      </button>

      {open && (
        <div className="absolute z-50 mt-1 left-0 w-52 bg-bg-secondary border border-border rounded-lg shadow-xl overflow-hidden">
          {/* Search */}
          <div className="p-2 border-b border-border">
            <div className="flex items-center gap-1.5 bg-bg-surface rounded px-2 py-1">
              <Search size={12} className="text-text-faint shrink-0" />
              <input
                ref={inputRef}
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && canCreate) handleCreate();
                  if (e.key === "Escape") { setOpen(false); setSearch(""); }
                }}
                placeholder="Search or create…"
                className="w-full bg-transparent text-xs text-text-primary outline-none placeholder:text-text-faint"
              />
            </div>
          </div>

          {/* Tag list */}
          <div className="max-h-48 overflow-y-auto p-1">
            {filtered.map((tag) => {
              const isSelected = allSelectedSet.has(tag.id);
              const isInherited = inheritedTagIds?.has(tag.id);
              const bg = TAG_COLOR_BG[tag.color] ?? "bg-slate-500/15";
              const text = TAG_COLOR_TEXT[tag.color] ?? "text-slate-400";

              return (
                <button
                  key={tag.id}
                  onClick={() => toggle(tag.id)}
                  disabled={isInherited}
                  className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs transition-colors ${
                    isInherited
                      ? "opacity-50 cursor-not-allowed"
                      : "hover:bg-bg-hover cursor-pointer"
                  }`}
                >
                  <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center text-[9px] ${
                    isSelected ? "bg-accent border-accent text-white" : "border-border"
                  }`}>
                    {isSelected && "✓"}
                  </span>
                  <span className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${bg} ${text}`}>
                    {tag.name}
                  </span>
                  {isInherited && (
                    <span className="text-[9px] text-text-faint ml-auto">inherited</span>
                  )}
                </button>
              );
            })}

            {filtered.length === 0 && !canCreate && (
              <div className="text-xs text-text-faint text-center py-3">No tags found</div>
            )}

            {/* Create new tag */}
            {canCreate && (
              <button
                onClick={handleCreate}
                disabled={creating}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-bg-hover transition-colors text-accent"
              >
                <Plus size={12} />
                Create "{search.trim()}"
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
