// Shared toast system — app-level notifications with an optional (undo) action.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import Toast, { type ToastData } from "./components/Toast";

export type ToastInput = Omit<ToastData, "id" | "tone"> & {
  id?: string;
  tone?: ToastData["tone"];
};

export interface ToastContextValue {
  /** Show a toast (or replace an existing one when `id` is reused). Returns the toast id. */
  showToast: (input: ToastInput) => string;
  dismissToast: (id: string) => void;
  updateToast: (id: string, patch: Partial<ToastInput>) => void;
}

export const DEFAULT_TOAST_DURATION_MS = 6_000;
/** Oldest toasts beyond this cap are evicted so the stack cannot cover the UI. */
export const MAX_VISIBLE_TOASTS = 4;

const noop = () => {};
const FALLBACK: ToastContextValue = {
  showToast: () => "",
  dismissToast: noop,
  updateToast: noop,
};

const ToastContext = createContext<ToastContextValue | undefined>(undefined);

/**
 * Returns the toast API. Outside a `ToastProvider` this degrades to no-ops so
 * components (and focused tests) that render standalone never crash.
 */
export function useToast(): ToastContextValue {
  return useContext(ToastContext) ?? FALLBACK;
}

let toastCounter = 0;
function nextToastId(): string {
  toastCounter += 1;
  return `toast-${toastCounter}`;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastData[]>([]);
  const [pendingActionIds, setPendingActionIds] = useState<string[]>([]);
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const clearTimer = useCallback((id: string) => {
    const timer = timersRef.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  const dismissToast = useCallback((id: string) => {
    clearTimer(id);
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
    setPendingActionIds((prev) => (prev.includes(id) ? prev.filter((entry) => entry !== id) : prev));
  }, [clearTimer]);

  const scheduleDismiss = useCallback((id: string, durationMs: number) => {
    clearTimer(id);
    if (durationMs <= 0) return;
    const timer = setTimeout(() => dismissToast(id), durationMs);
    timersRef.current.set(id, timer);
  }, [clearTimer, dismissToast]);

  const showToast = useCallback((input: ToastInput) => {
    const id = input.id ?? nextToastId();
    const toast: ToastData = {
      ...input,
      id,
      tone: input.tone ?? "success",
    };
    setToasts((prev) => {
      const withoutDuplicate = prev.filter((entry) => entry.id !== id);
      const next = [...withoutDuplicate, toast];
      const overflow = next.length - MAX_VISIBLE_TOASTS;
      return overflow > 0 ? next.slice(overflow) : next;
    });
    setPendingActionIds((prev) => (prev.includes(id) ? prev.filter((entry) => entry !== id) : prev));
    scheduleDismiss(id, toast.durationMs ?? DEFAULT_TOAST_DURATION_MS);
    return id;
  }, [scheduleDismiss]);

  const updateToast = useCallback((id: string, patch: Partial<ToastInput>) => {
    setToasts((prev) => prev.map((toast) => (toast.id === id ? { ...toast, ...patch, id } : toast)));
  }, []);

  // Reconcile timers and pending flags against the live toast list so removals
  // (dismiss, replace, overflow eviction) never leak a timer or a stale flag.
  useEffect(() => {
    const live = new Set(toasts.map((toast) => toast.id));
    for (const id of [...timersRef.current.keys()]) {
      if (!live.has(id)) clearTimer(id);
    }
    setPendingActionIds((prev) => {
      const next = prev.filter((id) => live.has(id));
      return next.length === prev.length ? prev : next;
    });
  }, [toasts, clearTimer]);

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  const runAction = useCallback((toast: ToastData) => {
    if (!toast.action) return;
    // Hold the toast open while the action runs so it cannot vanish mid-undo.
    clearTimer(toast.id);
    setPendingActionIds((prev) => (prev.includes(toast.id) ? prev : [...prev, toast.id]));
    void (async () => {
      try {
        await toast.action?.onAction();
      } catch (err) {
        // Actions own their user-facing error reporting; never let a throwing
        // action surface as an unhandled rejection.
        console.error("[toast] action failed:", err);
      } finally {
        setPendingActionIds((prev) => prev.filter((entry) => entry !== toast.id));
        // Re-arm auto-dismiss so a toast whose action failed (and therefore was
        // not dismissed by the caller) cannot linger on screen forever. Dismissing
        // an already-removed toast is a no-op, so this is safe either way.
        scheduleDismiss(toast.id, toast.durationMs ?? DEFAULT_TOAST_DURATION_MS);
      }
    })();
  }, [clearTimer, scheduleDismiss]);

  const value = useMemo<ToastContextValue>(
    () => ({ showToast, dismissToast, updateToast }),
    [showToast, dismissToast, updateToast],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      {toasts.length > 0 && (
        <div className="pointer-events-none fixed inset-x-4 bottom-20 z-50 flex flex-col items-center gap-2 md:inset-x-auto md:right-6 md:bottom-6 md:items-end">
          {toasts.map((toast) => (
            <Toast
              key={toast.id}
              toast={toast}
              actionPending={pendingActionIds.includes(toast.id)}
              onAction={() => runAction(toast)}
              onDismiss={() => dismissToast(toast.id)}
            />
          ))}
        </div>
      )}
    </ToastContext.Provider>
  );
}
