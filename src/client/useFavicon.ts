import { useEffect } from "react";
import { getFaviconPath } from "./faviconOptions";

/** Swap the document favicon at runtime when the setting changes. */
export function useFavicon(faviconKey?: string) {
  useEffect(() => {
    const path = getFaviconPath(faviconKey);
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
  }, [faviconKey]);
}
