import { useCallback } from "react";
import { useSearchParams } from "react-router-dom";

/**
 * Hook for managing overlay state (sheets, modals, dialogs) via URL search params.
 * Opening an overlay pushes a history entry so the back button closes it.
 * Closing uses replace to avoid leaving stale entries in the back stack.
 */
export function useOverlayParam(paramName: string) {
  const [searchParams, setSearchParams] = useSearchParams();
  const value = searchParams.get(paramName);
  const isOpen = value !== null;

  const open = useCallback(
    (paramValue: string = "1") => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set(paramName, paramValue);
          return next;
        },
        { replace: false }, // push — creates a back-button stop
      );
    },
    [paramName, setSearchParams],
  );

  const close = useCallback(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete(paramName);
        return next;
      },
      { replace: true }, // replace — avoids stale entries
    );
  }, [paramName, setSearchParams]);

  return { isOpen, value, open, close };
}
