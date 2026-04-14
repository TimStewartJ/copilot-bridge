import type { AppSettings, ThemePreference } from "../../api";
import { FAVICON_OPTIONS, DEFAULT_FAVICON, type FaviconOption } from "../../faviconOptions";
import { useTheme } from "../../useTheme";
import ThemePicker from "../ThemePicker";
import { SettingsSection } from "./SettingsSection";

export function AppearanceSection({
  draft,
  setDraft,
}: {
  draft: AppSettings;
  setDraft: (d: AppSettings) => void;
}) {
  const { theme, setTheme, effectiveTheme } = useTheme();
  const currentFavicon = draft.favicon ?? DEFAULT_FAVICON;
  const bridgeOptions = FAVICON_OPTIONS.filter((o) => o.group === "bridge");
  const altOptions = FAVICON_OPTIONS.filter((o) => o.group === "alt");

  const selectFavicon = (key: string) => {
    const next = structuredClone(draft);
    next.favicon = key;
    setDraft(next);
  };

  const handleThemeChange = (t: ThemePreference) => {
    setTheme(t);
    const next = structuredClone(draft);
    next.theme = t;
    setDraft(next);
  };

  return (
    <SettingsSection
      title="Appearance"
      description="Customize the look and feel of the app."
    >
      <div className="bg-bg-elevated border border-border rounded-md p-4 space-y-5">
        {/* Theme */}
        <div>
          <p className="text-xs text-text-faint mb-2">Theme</p>
          <ThemePicker value={theme} onChange={handleThemeChange} />
        </div>

        {/* Favicon — Bridge variants */}
        <div>
          <p className="text-xs text-text-faint mb-2">Icon — Bridge</p>
          <div className="flex flex-wrap gap-3">
            {bridgeOptions.map((opt) => (
              <FaviconTile key={opt.key} option={opt} selected={currentFavicon === opt.key} onSelect={selectFavicon} effectiveTheme={effectiveTheme} />
            ))}
          </div>
        </div>

        {/* Favicon — Alt variants */}
        <div>
          <p className="text-xs text-text-faint mb-2">Icon — Alternative</p>
          <div className="flex flex-wrap gap-3">
            {altOptions.map((opt) => (
              <FaviconTile key={opt.key} option={opt} selected={currentFavicon === opt.key} onSelect={selectFavicon} effectiveTheme={effectiveTheme} />
            ))}
          </div>
        </div>
      </div>
    </SettingsSection>
  );
}

function FaviconTile({
  option,
  selected,
  onSelect,
  effectiveTheme,
}: {
  option: FaviconOption;
  selected: boolean;
  onSelect: (key: string) => void;
  effectiveTheme: "light" | "dark";
}) {
  const src = effectiveTheme === "light" ? option.lightPath : option.path;
  return (
    <button
      onClick={() => onSelect(option.key)}
      className={`flex flex-col items-center gap-1.5 p-2 rounded-lg transition-all cursor-pointer
        ${selected
          ? "ring-2 ring-accent bg-accent/10"
          : "hover:bg-bg-hover border border-transparent hover:border-border"
        }`}
      title={option.label}
    >
      <img
        src={src}
        alt={option.label}
        className="w-10 h-10 rounded-md"
      />
      <span className={`text-[10px] ${selected ? "text-accent font-medium" : "text-text-muted"}`}>
        {option.label}
      </span>
    </button>
  );
}
