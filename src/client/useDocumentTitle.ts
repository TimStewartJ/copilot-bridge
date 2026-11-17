import { useEffect } from "react";

/** A nullish title leaves `document.title` alone, so a deeper route can own the tab title. */
export function useDocumentTitle(title: string | null | undefined): void {
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (!title || document.title === title) return;
    document.title = title;
  }, [title]);
}
