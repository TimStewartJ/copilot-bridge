import { useCallback, useEffect, useMemo, useRef } from "react";
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

function getLocationSignature(pathname: string, search: string, hash: string): string {
  return `${pathname}\n${search}\n${hash}`;
}

/**
 * Hook for managing overlay state (sheets, modals, dialogs) via URL search params.
 * Opening an overlay pushes a history entry so the back button closes it.
 * Closing pops entries opened by this hook and replaces direct-linked overlay URLs.
 */
export function useOverlayParam(paramName: string) {
  const location = useLocation();
  const navigate = useNavigate();
  const ownedLocationKeysRef = useRef<Set<string>>(new Set());
  const pendingOwnedLocationSignatureRef = useRef<string | null>(null);
  const searchParams = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const value = searchParams.get(paramName);
  const isOpen = value !== null;
  const locationSignature = getLocationSignature(location.pathname, location.search, location.hash);

  useEffect(() => {
    if (pendingOwnedLocationSignatureRef.current === locationSignature && isOpen) {
      ownedLocationKeysRef.current.add(location.key);
      pendingOwnedLocationSignatureRef.current = null;
      return;
    }

    if (pendingOwnedLocationSignatureRef.current !== null) {
      pendingOwnedLocationSignatureRef.current = null;
    }
  }, [isOpen, location.key, locationSignature]);

  const open = useCallback(
    (paramValue: string = "1") => {
      if (searchParams.get(paramName) === paramValue) return;
      const search = getSearchWithParam(location.search, paramName, paramValue);
      pendingOwnedLocationSignatureRef.current = getLocationSignature(location.pathname, search, location.hash);
      navigate(
        {
          pathname: location.pathname,
          search,
          hash: location.hash,
        },
        { replace: false }, // push — creates a back-button stop
      );
    },
    [location.hash, location.pathname, location.search, navigate, paramName, searchParams],
  );

  const close = useCallback(() => {
    if (!searchParams.has(paramName)) return;
    pendingOwnedLocationSignatureRef.current = null;

    if (ownedLocationKeysRef.current.has(location.key)) {
      navigate(-1);
      return;
    }

    navigate(
      {
        pathname: location.pathname,
        search: getSearchWithoutParam(location.search, paramName),
        hash: location.hash,
      },
      { replace: true }, // direct link — stay on the current page
    );
  }, [location.hash, location.key, location.pathname, location.search, navigate, paramName, searchParams]);

  return { isOpen, value, open, close };
}
