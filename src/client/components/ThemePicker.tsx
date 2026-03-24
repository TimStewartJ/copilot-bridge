import { Sun, Moon, Monitor } from "lucide-react";
import type { ThemePreference } from "../api";

const OPTIONS: { value: ThemePreference; label: string; Icon: typeof Sun }[] = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
  { value: "system", label: "System", Icon: Monitor },
];

interface Props {
  value: ThemePreference;
  onChange: (t: ThemePreference) => void;
}

export default function ThemePicker({ value, onChange }: Props) {
  return (
    <div className="flex gap-1.5">
      {OPTIONS.map(({ value: v, label, Icon }) => {
        const active = value === v;
        return (
          <button
            key={v}
            onClick={() => onChange(v)}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md transition-all cursor-pointer
              ${active
                ? "bg-accent text-white font-medium"
                : "bg-bg-surface text-text-muted hover:text-text-secondary hover:bg-bg-hover border border-transparent hover:border-border"
              }`}
            title={label}
          >
            <Icon size={14} />
            {label}
          </button>
        );
      })}
    </div>
  );
}
