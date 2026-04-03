import { useRef, useEffect, useCallback } from "react";
import { useLocation, useNavigate } from "react-router-dom";

/**
 * Tracks an app-internal navigation stack and provides a consistent
 * back-navigation function. Falls back to "/" if no prior app page exists,
 * avoiding the unreliable `window.history.length` check that can navigate
 * outside the app.
 */
export function useAppBack() {
  const location = useLocation();
  const navigate = useNavigate();
  const stackRef = useRef<string[]>([]);
  const currentRef = useRef<string | null>(null);

  useEffect(() => {
    const path = location.pathname + location.search;
    // Push previous path onto the stack (skip initial mount and same-path)
    if (currentRef.current && currentRef.current !== path) {
      stackRef.current.push(currentRef.current);
      // Cap the stack to avoid unbounded growth
      if (stackRef.current.length > 50) {
        stackRef.current = stackRef.current.slice(-50);
      }
    }
    currentRef.current = path;
  }, [location.pathname, location.search]);

  const goBack = useCallback(() => {
    const prev = stackRef.current.pop();
    if (prev) {
      navigate(prev);
    } else {
      navigate("/");
    }
  }, [navigate]);

  const canGoBack = stackRef.current.length > 0;

  return { goBack, canGoBack };
}
