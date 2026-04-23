import { useEffect, useCallback } from "react";
import { useLocation, useNavigate } from "react-router-dom";

function getAppBackHistoryKey(pathname: string, search: string) {
  if (pathname !== "/settings") {
    return pathname + search;
  }

  const params = new URLSearchParams(search);
  params.delete("group");
  const normalizedSearch = params.toString();
  return normalizedSearch ? `${pathname}?${normalizedSearch}` : pathname;
}

const MAX_STACK_SIZE = 50;

let appBackStack: string[] = [];
let currentHistoryKey: string | null = null;
let currentUrl: string | null = null;
let isGoingBack = false;

/**
 * Tracks an app-internal navigation stack and provides a consistent
 * back-navigation function. Falls back to "/" if no prior app page exists,
 * avoiding the unreliable `window.history.length` check that can navigate
 * outside the app.
 */
export function useAppBack() {
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    const historyKey = getAppBackHistoryKey(location.pathname, location.search);
    const nextUrl = location.pathname + location.search;

    if (isGoingBack) {
      // Back-navigation: don't push the departing page onto the stack
      isGoingBack = false;
    } else if (currentHistoryKey && currentUrl && currentHistoryKey !== historyKey) {
      appBackStack.push(currentUrl);
      if (appBackStack.length > MAX_STACK_SIZE) {
        appBackStack = appBackStack.slice(-MAX_STACK_SIZE);
      }
    }

    currentHistoryKey = historyKey;
    currentUrl = nextUrl;
  }, [location.pathname, location.search]);

  const goBack = useCallback(() => {
    isGoingBack = true;
    const prev = appBackStack.pop();

    if (prev) {
      navigate(prev);
    } else {
      navigate("/");
    }
  }, [navigate]);

  const canGoBack = appBackStack.length > 0;

  return { goBack, canGoBack };
}
