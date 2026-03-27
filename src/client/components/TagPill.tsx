import type { Tag } from "../api";
import { TAG_COLOR_BG, TAG_COLOR_TEXT } from "../tag-colors";
import { X } from "lucide-react";

interface TagPillProps {
  tag: Tag;
  size?: "xs" | "sm";
  inherited?: boolean;
  onRemove?: () => void;
}

export default function TagPill({ tag, size = "xs", inherited, onRemove }: TagPillProps) {
  const bg = TAG_COLOR_BG[tag.color] ?? "bg-slate-500/15";
  const text = TAG_COLOR_TEXT[tag.color] ?? "text-slate-400";

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full font-medium leading-none ${bg} ${text} ${
        inherited ? "ring-1 ring-current/20 opacity-75" : ""
      } ${size === "xs" ? "text-[10px] px-1.5 py-0.5" : "text-xs px-2 py-0.5"}`}
      title={inherited ? `Inherited from group` : tag.name}
    >
      <span className="truncate max-w-[100px]">{tag.name}</span>
      {onRemove && (
        <button
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          className="hover:opacity-70 -mr-0.5"
        >
          <X size={size === "xs" ? 10 : 12} />
        </button>
      )}
    </span>
  );
}

export function TagPillList({
  tags,
  inheritedTagIds,
  size = "xs",
  onRemove,
  max,
}: {
  tags: Tag[];
  inheritedTagIds?: Set<string>;
  size?: "xs" | "sm";
  onRemove?: (tagId: string) => void;
  max?: number;
}) {
  const display = max ? tags.slice(0, max) : tags;
  const remaining = max ? tags.length - max : 0;

  return (
    <div className="flex flex-wrap gap-1 items-center">
      {display.map((tag) => (
        <TagPill
          key={tag.id}
          tag={tag}
          size={size}
          inherited={inheritedTagIds?.has(tag.id)}
          onRemove={onRemove && !inheritedTagIds?.has(tag.id) ? () => onRemove(tag.id) : undefined}
        />
      ))}
      {remaining > 0 && (
        <span className="text-[10px] text-text-faint">+{remaining}</span>
      )}
    </div>
  );
}
