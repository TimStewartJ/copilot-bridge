import { useEffect } from "react";

/**
 * Keep `document.title` in sync with the supplied title.
 * A nullish title is a no-op so a route owner further down the tree can keep
 * ownership of the tab title without the parent fighting it.
 */
export function useDocumentTitle(title: string | null | undefined): void {
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (!title || document.title === title) return;
    document.title = title;
  }, [title]);
}
