import { useState, useRef, useEffect, useMemo } from "react";
import { useTagsQuery, useCreateTagMutation } from "../hooks/queries/useTags";
import TagPill from "./TagPill";
import { Plus, Search } from "lucide-react";
import { DS, cx } from "../design/tokens";

interface TagPickerProps {
  /** Currently selected tag IDs (own tags, not inherited) */
  selectedTagIds: string[];
  /** Inherited tag IDs (shown but not removable) */
  inheritedTagIds?: Set<string>;
  /** Called when selection changes (only own tags, not inherited) */
  onChange: (tagIds: string[]) => void;
  /** Compact mode — just a + button */
  compact?: boolean;
  /** Give the compact button a full touch target on a phone. */
  touch?: boolean;
}

export default function TagPicker({
  selectedTagIds,
  inheritedTagIds,
  onChange,
  compact,
  touch = false,
}: TagPickerProps) {
  const { data: allTags = [] } = useTagsQuery();
  const createTagMutation = useCreateTagMutation();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
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
    if (!canCreate || createTagMutation.isPending) return;
    try {
      const tag = await createTagMutation.mutateAsync({ name: search.trim() });
      onChange([...selectedTagIds, tag.id]);
      setSearch("");
    } catch (e) {
      console.error("Failed to create tag:", e);
    }
  };

  return (
    <div ref={containerRef} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-label="Manage tags"
        aria-expanded={open}
        className={cx(
          "inline-flex items-center gap-1 rounded-md text-text-muted transition-colors hover:bg-bg-hover/60 hover:text-text-primary",
          DS.focus,
          compact
            ? touch ? "h-10 w-10 justify-center md:h-6 md:w-6" : "h-5 w-5 justify-center"
            : "h-5 px-1.5 text-[11px] font-medium",
        )}
        title="Manage tags"
      >
        <Plus size={12} aria-hidden="true" />
        {!compact && <span>Tag</span>}
      </button>

      {open && (
        <div className={cx("absolute left-0 z-50 mt-1 w-52 overflow-hidden", DS.surface.floating)}>
          {/* Search */}
          <div className="p-2 border-b border-border">
            <div className="flex items-center gap-1.5 rounded-md bg-bg-hover/40 px-2 py-1">
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

              return (
                <button
                  key={tag.id}
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() => toggle(tag.id)}
                  disabled={isInherited}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors ${
                    isInherited
                      ? "cursor-not-allowed opacity-50"
                      : "cursor-pointer hover:bg-bg-hover/60"
                  }`}
                >
                  <span className={cx(DS.checkbox.base, isSelected ? DS.checkbox.checked : DS.checkbox.unchecked)} aria-hidden="true">
                    {isSelected && "✓"}
                  </span>
                  <TagPill tag={tag} />
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
                disabled={createTagMutation.isPending}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-text-secondary transition-colors hover:bg-bg-hover/60 hover:text-text-primary"
              >
                <Plus size={12} aria-hidden="true" />
                Create "{search.trim()}"
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
