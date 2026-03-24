import { useEffect } from "react";
import { getFaviconPath } from "./faviconOptions";
import { useTheme } from "./useTheme";

/** Swap the document favicon at runtime when the setting or theme changes. */
export function useFavicon(faviconKey?: string) {
  const { effectiveTheme } = useTheme();

  useEffect(() => {
    const path = getFaviconPath(faviconKey, effectiveTheme);
    const link =
      document.querySelector<HTMLLinkElement>('link[rel="icon"]') ??
      (() => {
        const el = document.createElement("link");
        el.rel = "icon";
        el.type = "image/svg+xml";
        document.head.appendChild(el);
        return el;
      })();
    link.href = path;
  }, [faviconKey, effectiveTheme]);
}
