import { useEffect, useRef } from "react";
import { useLocation, useNavigate, useNavigationType, type Location, type NavigationType } from "react-router-dom";

function searchFallback(actual: Location): Location {
  const from = new URLSearchParams(actual.search).get("from");
  const url = from?.startsWith("/") && !from.startsWith("//") && !from.includes("\\")
    ? new URL(from, "http://bridge.local")
    : null;
  return {
    ...actual,
    pathname: url && url.pathname !== "/search" ? url.pathname : "/",
    search: url && url.pathname !== "/search" ? url.search : "",
    hash: url && url.pathname !== "/search" ? url.hash : "",
    state: null,
  };
}

export function useSearchBackground() {
  const actual = useLocation();
  const navigate = useNavigate();
  const actualNavigationType = useNavigationType();
  const background = useRef<{ location: Location; navigationType: NavigationType } | null>(null);
  const wasOpen = useRef(false);
  const locallyOpened = useRef(false);
  const returnFocus = useRef<Element | null>(null);
  const restoreFocus = useRef(false);
  const open = actual.pathname === "/search";
  // Keep the entire location stable while query/filter changes update the overlay URL.
  if (open && !wasOpen.current) {
    locallyOpened.current = background.current !== null && actualNavigationType === "PUSH";
    // Capture before committing inert to the background, which blurs its focused control.
    returnFocus.current = typeof document === "undefined" ? null : document.activeElement;
  }
  if (!open && !(wasOpen.current && background.current?.location.key === actual.key)) {
    background.current = { location: actual, navigationType: actualNavigationType };
  }
  wasOpen.current = open;
  const location = open
    ? background.current?.location ?? searchFallback(actual)
    : actual;
  const navigationType = background.current?.navigationType ?? actualNavigationType;
  useEffect(() => {
    if (open || !restoreFocus.current) return;
    restoreFocus.current = false;
    const target = returnFocus.current;
    if (target?.isConnected && "focus" in target && typeof target.focus === "function") target.focus();
    returnFocus.current = null;
  }, [open]);
  const close = () => {
    restoreFocus.current = true;
    if (locallyOpened.current) navigate(-1);
    else navigate(`${location.pathname}${location.search}${location.hash}`, { replace: true, state: location.state });
  };
  return { actual, location, navigationType, open, close };
}
