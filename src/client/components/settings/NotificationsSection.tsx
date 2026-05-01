import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bell, BellOff, Loader2, RotateCw, Send } from "lucide-react";
import {
  disablePushNotifications,
  enablePushNotifications,
  getClientPushState,
  sendCurrentSubscriptionTestNotification,
  type ClientPushState,
} from "../../push-notifications";
import { SettingsSection } from "./SettingsSection";

function statusToneClassName(tone: "success" | "warning" | "error" | "neutral"): string {
  switch (tone) {
    case "success":
      return "bg-success/15 text-success";
    case "warning":
      return "bg-warning/15 text-warning";
    case "error":
      return "bg-error/10 text-error";
    default:
      return "bg-bg-surface text-text-secondary";
  }
}

function describePushState(state: ClientPushState | null, loading: boolean): {
  label: string;
  detail: string;
  tone: "success" | "warning" | "error" | "neutral";
} {
  if (loading && !state) {
    return { label: "Checking…", detail: "Checking browser and server notification support.", tone: "neutral" };
  }
  if (!state) {
    return { label: "Unknown", detail: "Notification status has not been loaded yet.", tone: "neutral" };
  }
  if (!state.support.supported) {
    return { label: "Unsupported", detail: state.support.reasons.join(" "), tone: "error" };
  }
  if (!state.server?.configured) {
    return {
      label: "Server setup needed",
      detail: `Set ${state.server?.missingEnv.join(", ") || "the VAPID environment variables"} and restart Bridge.`,
      tone: "warning",
    };
  }
  if (state.permission === "denied") {
    return {
      label: "Blocked",
      detail: "Notifications are blocked in browser or OS settings for this site.",
      tone: "error",
    };
  }
  if (state.subscribed) {
    return {
      label: "Enabled",
      detail: "This browser is subscribed to Copilot Bridge notifications.",
      tone: "success",
    };
  }
  if (state.permission === "granted") {
    return {
      label: "Ready",
      detail: "Permission is granted, but this browser does not have an active subscription.",
      tone: "warning",
    };
  }
  return {
    label: "Disabled",
    detail: "Enable notifications from this browser to receive background Bridge updates.",
    tone: "neutral",
  };
}

export function NotificationsSection() {
  const [state, setState] = useState<ClientPushState | null>(null);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<"enable" | "disable" | "test" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const refresh = useCallback(async () => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setLoading(true);
    try {
      const nextState = await getClientPushState();
      if (requestIdRef.current === requestId) {
        setState(nextState);
        setMessage(null);
      }
    } catch (err) {
      if (requestIdRef.current === requestId) {
        setMessage(`Status check failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      if (requestIdRef.current === requestId) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const descriptor = useMemo(() => describePushState(state, loading), [state, loading]);
  const busy = loading || action !== null;
  const canEnable = !!state?.support.supported && !!state.server?.configured && state.permission !== "denied";
  const canDisable = !!state?.subscribed;
  const canTest = !!state?.subscribed && !!state.server?.configured;

  const runAction = async (
    nextAction: "enable" | "disable" | "test",
    work: () => Promise<unknown>,
    success: (result: unknown) => string,
  ) => {
    setAction(nextAction);
    try {
      const result = await work();
      setMessage(success(result));
      await refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setAction(null);
    }
  };

  return (
    <SettingsSection
      title="Notifications"
      description="Enable standards-based Web Push alerts without app-shell caching. On iPhone, install Bridge to the Home Screen from the stable HTTPS origin first."
      action={(
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-md bg-bg-surface px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-hover disabled:cursor-wait disabled:text-text-faint"
        >
          {loading ? <Loader2 size={12} className="animate-spin" /> : <RotateCw size={12} />}
          Refresh
        </button>
      )}
    >
      <div className="rounded-md border border-border bg-bg-elevated p-4 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-medium text-accent">
              {state?.subscribed ? <Bell size={15} /> : <BellOff size={15} />}
              Browser push
            </div>
            <p className="mt-1 text-xs text-text-muted">{descriptor.detail}</p>
          </div>
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${statusToneClassName(descriptor.tone)}`}>
            {descriptor.label}
          </span>
        </div>

        <div className="grid gap-2 text-xs text-text-muted md:grid-cols-2">
          <div>
            <span className="text-text-faint">permission:</span>{" "}
            <code className="text-text-secondary">{state?.permission ?? "checking"}</code>
          </div>
          <div>
            <span className="text-text-faint">server:</span>{" "}
            <code className="text-text-secondary">{state?.server?.configured ? "configured" : "not configured"}</code>
          </div>
          <div>
            <span className="text-text-faint">subscriptions:</span>{" "}
            <code className="text-text-secondary">{state?.server?.subscriptionCount ?? 0}</code>
          </div>
          <div>
            <span className="text-text-faint">browser:</span>{" "}
            <code className="text-text-secondary">{state?.support.supported ? "supported" : "unsupported"}</code>
          </div>
        </div>

        {state?.server && !state.server.configured && (
          <pre className="overflow-x-auto rounded-md border border-border bg-bg-primary px-3 py-2 text-xs text-text-secondary">
            <code>{state.server.missingEnv.map((name) => `${name}=`).join("\n")}</code>
          </pre>
        )}

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void runAction("enable", () => enablePushNotifications(state?.server ?? null), () => "Notifications enabled for this browser.")}
            disabled={busy || !canEnable}
            className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:bg-bg-surface disabled:text-text-faint"
          >
            {action === "enable" ? <Loader2 size={12} className="animate-spin" /> : <Bell size={12} />}
            Enable
          </button>
          <button
            type="button"
            onClick={() => void runAction("disable", disablePushNotifications, () => "Notifications disabled for this browser.")}
            disabled={busy || !canDisable}
            className="inline-flex items-center gap-1.5 rounded-md bg-bg-surface px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-hover disabled:cursor-not-allowed disabled:text-text-faint"
          >
            {action === "disable" ? <Loader2 size={12} className="animate-spin" /> : <BellOff size={12} />}
            Disable
          </button>
          <button
            type="button"
            onClick={() => void runAction("test", sendCurrentSubscriptionTestNotification, (result) => {
              const summary = result as { sent?: number; pruned?: number };
              return summary.sent
                ? "Test notification sent."
                : summary.pruned
                  ? "Subscription was expired and has been pruned."
                  : "No active subscription was available to notify.";
            })}
            disabled={busy || !canTest}
            className="inline-flex items-center gap-1.5 rounded-md bg-bg-surface px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-hover disabled:cursor-not-allowed disabled:text-text-faint"
          >
            {action === "test" ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
            Send test
          </button>
        </div>

        {message && (
          <div className="rounded-md border border-border bg-bg-primary px-3 py-2 text-xs text-text-muted">
            {message}
          </div>
        )}
      </div>
    </SettingsSection>
  );
}
