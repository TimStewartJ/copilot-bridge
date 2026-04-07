// Theme context — provides theme preference with server-side persistence.

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import { patchSettings, type ThemePreference } from "./api";
import { useSettingsQuery } from "./hooks/queries/useSettings";

type EffectiveTheme = "light" | "dark";

interface ThemeContextValue {
  /** User preference: "light" | "dark" | "system" */
  theme: ThemePreference;
  /** Resolved theme after system preference resolution */
  effectiveTheme: EffectiveTheme;
  /** Update preference (persisted to server) */
  setTheme: (t: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

function resolveTheme(pref: ThemePreference): EffectiveTheme {
  if (pref === "system") {
    return window.matchMedia("(prefers-color-scheme: light)").matches
      ? "light"
      : "dark";
  }
  return pref;
}

function applyTheme(effective: EffectiveTheme) {
  document.documentElement.setAttribute("data-theme", effective);

  // Update meta theme-color for mobile browser chrome
  const meta = document.querySelector<HTMLMetaElement>(
    'meta[name="theme-color"]',
  );
  if (meta) {
    meta.content = effective === "light" ? "#ffffff" : "#09090b";
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, _setTheme] = useState<ThemePreference>("dark");
  const [effectiveTheme, setEffectiveTheme] = useState<EffectiveTheme>("dark");
  const [loaded, setLoaded] = useState(false);

  const { data: settings } = useSettingsQuery();

  // Sync theme from server settings (on initial load and when settings change)
  useEffect(() => {
    if (!settings) return;
    const pref = settings.theme ?? "dark";
    _setTheme(pref);
    const eff = resolveTheme(pref);
    setEffectiveTheme(eff);
    applyTheme(eff);
    setLoaded(true);
  }, [settings]);

  // Apply default theme immediately while loading
  useEffect(() => {
    if (!loaded) applyTheme("dark");
  }, [loaded]);

  // Listen for system preference changes when in "system" mode
  useEffect(() => {
    if (theme !== "system") return;

    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const handler = () => {
      const eff = resolveTheme("system");
      setEffectiveTheme(eff);
      applyTheme(eff);
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [theme]);

  const setTheme = useCallback(
    (next: ThemePreference) => {
      _setTheme(next);
      const eff = resolveTheme(next);
      setEffectiveTheme(eff);
      applyTheme(eff);
      // Persist to server (fire-and-forget)
      patchSettings({ theme: next }).catch(() => {});
    },
    [],
  );

  // Don't render children until we've loaded the theme to avoid flash
  if (!loaded) return null;

  return (
    <ThemeContext.Provider value={{ theme, effectiveTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
