import { useCallback, useLayoutEffect, useMemo } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { isRecord } from "../../shared/is-record";

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

const OVERLAY_OWNER = "bridgeOverlayParam";

/**
 * Hook for managing overlay state (sheets, modals, dialogs) via URL search params.
 * Opening an overlay pushes a history entry so the back button closes it.
 * Closing pops entries opened by this hook and replaces direct-linked overlay URLs.
 */
export function useOverlayParam(paramName: string) {
  const location = useLocation();
  const navigate = useNavigate();
  const searchParams = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const value = searchParams.get(paramName);
  const isOpen = value !== null;
  const owned = isRecord(location.state) && location.state[OVERLAY_OWNER] === paramName;
  // A save can finish after Back, or even after Forward has reopened the same history entry.
  const visit = useMemo(() => ({ active: false }), [location.key]);
  useLayoutEffect(() => {
    visit.active = true;
    return () => { visit.active = false; };
  }, [visit]);

  const open = useCallback(
    (paramValue: string = "1", options: { replace?: boolean } = {}) => {
      if (searchParams.get(paramName) === paramValue) return;
      const search = getSearchWithParam(location.search, paramName, paramValue);
      const replace = options.replace === true;
      // A pushed entry remembers its owner across reloads; replacing a cold link does not claim it.
      const state = replace ? location.state : { ...location.state, [OVERLAY_OWNER]: paramName };
      navigate(
        {
          pathname: location.pathname,
          search,
          hash: location.hash,
        },
        { replace, state },
      );
    },
    [location.hash, location.pathname, location.state, navigate, paramName, searchParams],
  );

  const close = useCallback(() => {
    if (!visit.active || !isOpen) return;
    visit.active = false;
    if (owned) {
      navigate(-1);
      return;
    }

    navigate(
      {
        pathname: location.pathname,
        search: getSearchWithoutParam(location.search, paramName),
        hash: location.hash,
      },
      { replace: true, state: location.state }, // direct link — stay on the current page
    );
  }, [visit, isOpen, owned, location.hash, location.pathname, location.search, location.state, navigate, paramName]);

  return { isOpen, value, open, close };
}
