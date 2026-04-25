import { useCallback, useMemo } from "react";
import { useLocation, useNavigate } from "react-router-dom";

function formatSearchParams(params: URLSearchParams): string {
  const search = params.toString();
  return search ? `?${search}` : "";
}

export function getSearchWithParam(search: string, paramName: string, paramValue: string): string {
  const next = new URLSearchParams(search);
  next.set(paramName, paramValue);
  return formatSearchParams(next);
}

export function getSearchWithoutParam(search: string, paramName: string): string {
  const next = new URLSearchParams(search);
  next.delete(paramName);
  return formatSearchParams(next);
}

/**
 * Hook for managing overlay state (sheets, modals, dialogs) via URL search params.
 * Opening an overlay pushes a history entry so the back button closes it.
 * Closing uses replace to avoid leaving stale entries in the back stack.
 */
export function useOverlayParam(paramName: string) {
  const location = useLocation();
  const navigate = useNavigate();
  const searchParams = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const value = searchParams.get(paramName);
  const isOpen = value !== null;

  const open = useCallback(
    (paramValue: string = "1") => {
      navigate(
        {
          pathname: location.pathname,
          search: getSearchWithParam(location.search, paramName, paramValue),
          hash: location.hash,
        },
        { replace: false }, // push — creates a back-button stop
      );
    },
    [location.hash, location.pathname, location.search, navigate, paramName],
  );

  const close = useCallback(() => {
    if (!searchParams.has(paramName)) return;
    navigate(
      {
        pathname: location.pathname,
        search: getSearchWithoutParam(location.search, paramName),
        hash: location.hash,
      },
      { replace: true }, // replace — avoids stale entries
    );
  }, [location.hash, location.pathname, location.search, navigate, paramName, searchParams]);

  return { isOpen, value, open, close };
}
