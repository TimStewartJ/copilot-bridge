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
import { DS, cx } from "../../design/tokens";
import { Badge, Details, Field, FieldList, SettingList, SettingRow } from "../../design/primitives";

/** Working push is ordinary, so it stays neutral; only problems take a colour. */
const BADGE_TONE = {
  success: "neutral",
  neutral: "neutral",
  warning: "warning",
  error: "danger",
} as const;

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

  const button = (variant: "secondary" | "ghost") => cx(DS.button.base, DS.button.size.sm, DS.button.variant[variant], DS.focus, "gap-1.5");

  return (
    <SettingsSection
      title="Notifications"
      description="Only conversations waiting for your input notify you."
      action={(
        <button type="button" onClick={() => void refresh()} disabled={busy} className={button("ghost")}>
          {loading ? <Loader2 size={12} className="animate-spin" /> : <RotateCw size={12} />}
          Refresh
        </button>
      )}
    >
      <SettingList>
        <SettingRow
          label={<span className="inline-flex items-center gap-1.5">{state?.subscribed ? <Bell size={13} /> : <BellOff size={13} />}Push on this browser</span>}
          hint={descriptor.detail}
          control={<Badge tone={BADGE_TONE[descriptor.tone]}>{descriptor.label}</Badge>}
        >
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => void runAction("enable", () => enablePushNotifications(state?.server ?? null), () => "Notifications enabled for this browser.")}
              disabled={busy || !canEnable}
              className={button("secondary")}
            >
              {action === "enable" ? <Loader2 size={12} className="animate-spin" /> : <Bell size={12} />}
              Enable
            </button>
            <button
              type="button"
              onClick={() => void runAction("disable", disablePushNotifications, () => "Notifications disabled for this browser.")}
              disabled={busy || !canDisable}
              className={button("ghost")}
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
              className={button("ghost")}
            >
              {action === "test" ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
              Send test
            </button>
          </div>
          {state?.server && !state.server.configured && (
            <pre className={cx(DS.surface.inset, "mt-2 overflow-x-auto px-3 py-2 text-xs text-text-secondary")}>
              <code>{state.server.missingEnv.map((name) => `${name}=`).join("\n")}</code>
            </pre>
          )}
          {message && <p role="status" className={cx(DS.field.help, "mt-2")}>{message}</p>}
        </SettingRow>
      </SettingList>
      <Details label="How notifications work" className="mt-3">
        <div className="space-y-2 pt-2 text-xs leading-relaxed text-text-secondary">
          <p>Session notifications are for conversations requesting your input. Routine completions stay in their task and do not interrupt you. Home does not grant additional notification authority.</p>
          <p>On iPhone, install Bridge to the Home Screen from the stable HTTPS origin first.</p>
          <FieldList>
            <Field label="Permission" mono>{state?.permission ?? "checking"}</Field>
            <Field label="Server" mono>{state?.server?.configured ? "configured" : "not configured"}</Field>
            <Field label="Subscriptions" mono>{String(state?.server?.subscriptionCount ?? 0)}</Field>
            <Field label="Browser" mono>{state?.support.supported ? "supported" : "unsupported"}</Field>
          </FieldList>
        </div>
      </Details>
    </SettingsSection>
  );
}
