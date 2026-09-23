import { useEffect } from "react";
import { Monitor, Pause, Sparkles } from "lucide-react";
import type { AppSettings, MotionPreference, ThemePreference } from "../../api";
import { FAVICON_OPTIONS, DEFAULT_FAVICON, faviconAssetUrl, type FaviconOption } from "../../faviconOptions";
import { useTheme } from "../../useTheme";
import ThemePicker from "../ThemePicker";
import { SettingsSection } from "./SettingsSection";
import { DS, cx } from "../../design/tokens";
import { Details, SegmentedControl } from "../../design/primitives";

const MOTION_OPTIONS: { value: MotionPreference; label: string; title: string; Icon: typeof Monitor }[] = [
  { value: "system", label: "System", title: "Follow this device's reduced-motion setting", Icon: Monitor },
  { value: "reduce", label: "Reduced", title: "Always reduce motion", Icon: Pause },
  { value: "full", label: "Full", title: "Always allow motion", Icon: Sparkles },
];

export function AppearanceSection({
  draft,
  setDraft,
}: {
  draft: AppSettings;
  setDraft: (d: AppSettings) => void;
}) {
  const { theme, savedTheme, previewTheme, effectiveTheme, motion, savedMotion, previewMotion } = useTheme();
  const currentFavicon = draft.favicon ?? DEFAULT_FAVICON;
  const bridgeOptions = FAVICON_OPTIONS.filter((o) => o.group === "bridge");
  const altOptions = FAVICON_OPTIONS.filter((o) => o.group === "alt");
  useEffect(() => {
    previewTheme(draft.theme ?? savedTheme);
    return () => previewTheme(null);
  }, [draft.theme, savedTheme, previewTheme]);
  useEffect(() => {
    previewMotion(draft.motion ?? savedMotion);
    return () => previewMotion(null);
  }, [draft.motion, savedMotion, previewMotion]);

  const selectFavicon = (key: string) => {
    const next = structuredClone(draft);
    next.favicon = key;
    setDraft(next);
  };

  const handleThemeChange = (t: ThemePreference) => {
    const next = structuredClone(draft);
    next.theme = t;
    setDraft(next);
  };

  const handleMotionChange = (m: MotionPreference) => {
    const next = structuredClone(draft);
    next.motion = m;
    setDraft(next);
  };

  return (
    <SettingsSection
      title="Appearance"
      description="Preview your theme and motion here. Save to keep them, or Discard to restore the saved appearance."
    >
      <div className={DS.layout.formGroup}>
        {/* Theme */}
        <div>
          <p className="text-xs text-text-faint mb-2">Theme</p>
          <ThemePicker value={theme} onChange={handleThemeChange} />
        </div>

        <div>
          <p className="text-xs text-text-faint mb-2">Reduced motion</p>
          <SegmentedControl
            ariaLabel="Reduced motion"
            value={motion}
            onChange={handleMotionChange}
            onReselect={handleMotionChange}
            options={MOTION_OPTIONS.map(({ value, label, title, Icon }) => ({ value, label, title, icon: <Icon size={14} /> }))}
          />
          <p className={cx(DS.field.help, "mt-2")}>
            System follows this device&apos;s setting. Reduced or Full overrides it on every device.
          </p>
        </div>

        <Details label="App icon" detail={FAVICON_OPTIONS.find((option) => option.key === currentFavicon)?.label}>
          <div className="space-y-4 pt-2">
            <div>
              <p className="text-xs text-text-secondary mb-2">Icon — Bridge</p>
              <div className="flex flex-wrap gap-3">
                {bridgeOptions.map((opt) => (
                  <FaviconTile key={opt.key} option={opt} selected={currentFavicon === opt.key} onSelect={selectFavicon} effectiveTheme={effectiveTheme} />
                ))}
              </div>
            </div>
            <div>
              <p className="text-xs text-text-secondary mb-2">Icon — Alternative</p>
              <div className="flex flex-wrap gap-3">
                {altOptions.map((opt) => (
                  <FaviconTile key={opt.key} option={opt} selected={currentFavicon === opt.key} onSelect={selectFavicon} effectiveTheme={effectiveTheme} />
                ))}
              </div>
            </div>
          </div>
        </Details>
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
  const src = faviconAssetUrl(effectiveTheme === "light" ? option.lightPath : option.path);
  return (
    <button
      onClick={() => onSelect(option.key)}
      type="button"
      aria-pressed={selected}
      className={cx(DS.choice.option, "flex-col justify-center gap-1.5", selected ? DS.choice.selected : DS.choice.unselected)}
      title={option.label}
    >
      <img
        src={src}
        alt={option.label}
        className="w-10 h-10 rounded-md"
      />
      <span className={cx("text-[10px]", selected ? "text-accent font-medium" : "text-text-muted")}>
        {option.label}
      </span>
    </button>
  );
}
