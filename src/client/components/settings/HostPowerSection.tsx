import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Moon, Timer, X } from "lucide-react";
import {
  cancelHibernate,
  fetchHibernateStatus,
  hibernateDevice,
  setHibernateOnIdle,
  HIBERNATE_DELAY_MINUTES,
  HIBERNATE_IDLE_GRACE_MINUTES,
  type DeviceHibernateOnIdleStatus,
  type DeviceHibernateStatus,
} from "../../api";
import { SettingsSection } from "./SettingsSection";
import { DS, cx } from "../../design/tokens";
import { Notice, SettingList, SettingRow } from "../../design/primitives";

const DELAY_LABELS: Record<number, string> = {
  0: "Now",
  5: "In 5 minutes",
  15: "In 15 minutes",
  30: "In 30 minutes",
  60: "In 1 hour",
};

function formatCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
  return `${seconds}s`;
}

function formatClock(scheduledAt: number): string {
  return new Date(scheduledAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** How often the client re-reads server-owned idle state while armed. */
const IDLE_STATUS_POLL_MS = 5000;

function armedIdleStatus(status: DeviceHibernateStatus): DeviceHibernateOnIdleStatus | null {
  return status.onIdle?.armed ? status.onIdle : null;
}

export function HostPowerSection({ refreshSignal = 0 }: { refreshSignal?: number }) {
  const [delayMinutes, setDelayMinutes] = useState(0);
  const [hibernating, setHibernating] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [togglingOnIdle, setTogglingOnIdle] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState<DeviceHibernateStatus | null>(null);
  const [onIdle, setOnIdle] = useState<DeviceHibernateOnIdleStatus | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const readRevision = useRef(0);

  // An older poll or refresh must not restore a schedule after a confirmed cancellation.
  const applyStatus = useCallback((status: DeviceHibernateStatus) => {
    readRevision.current++;
    setPending(status.pending ? status : null);
    setOnIdle(armedIdleStatus(status));
    setReadError(null);
  }, []);

  const refreshStatus = useCallback(async () => {
    const revision = ++readRevision.current;
    try {
      const status = await fetchHibernateStatus();
      if (revision === readRevision.current) applyStatus(status);
    } catch (error) {
      if (revision === readRevision.current) {
        setReadError(error instanceof Error ? error.message : String(error));
      }
    }
  }, [applyStatus]);

  useEffect(() => {
    void refreshStatus();
    return () => { readRevision.current++; };
  }, [refreshSignal, refreshStatus]);

  useEffect(() => {
    if (!pending?.pending || pending.scheduledAt == null) return;
    const scheduledAt = pending.scheduledAt;
    setNow(Date.now());
    const id = setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= scheduledAt) {
        clearInterval(id);
        // The server timer should have fired; confirm the real state, do not assume hibernation.
        void refreshStatus();
      }
    }, 1000);
    return () => clearInterval(id);
  }, [pending, refreshStatus]);

  const onIdleArmed = Boolean(onIdle?.armed);

  // While armed, the countdown and session count are server-owned: reread, do not simulate.
  useEffect(() => {
    if (!onIdleArmed) return;
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const poll = setInterval(() => void refreshStatus(), IDLE_STATUS_POLL_MS);
    return () => {
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [onIdleArmed, refreshStatus]);

  const handleHibernate = async () => {
    const label = (DELAY_LABELS[delayMinutes] ?? `In ${delayMinutes} minutes`).toLowerCase();
    const confirmed = window.confirm(
      delayMinutes > 0
        ? `Schedule hibernation ${label}?\n\nEverything pauses until the device wakes.`
        : "Hibernate this device now?\n\nEverything pauses until it wakes.",
    );
    if (!confirmed) return;

    setHibernating(true);
    setMessage(null);
    try {
      const result = await hibernateDevice(delayMinutes);
      setMessage(result.message);
      applyStatus(result);
    } catch (error) {
      setMessage(`Hibernate failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setHibernating(false);
    }
  };

  const handleToggleOnIdle = async () => {
    const nextEnabled = !onIdleArmed;
    if (nextEnabled) {
      const confirmed = window.confirm(
        `Hibernate after ${HIBERNATE_IDLE_GRACE_MINUTES} idle minutes?\n\nEverything pauses until the device wakes.`,
      );
      if (!confirmed) return;
    }

    setTogglingOnIdle(true);
    setMessage(null);
    try {
      const result = await setHibernateOnIdle(nextEnabled);
      setOnIdle(result.armed ? result : null);
      setMessage(result.message);
      // The toggle reply omits a timed schedule that another client may have changed.
      void refreshStatus();
    } catch (error) {
      setMessage(
        `Hibernate on idle failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setTogglingOnIdle(false);
    }
  };

  const handleCancel = async () => {
    setCancelling(true);
    setMessage(null);
    try {
      const result = await cancelHibernate();
      applyStatus(result);
      setMessage(
        result.cancelled ? "Scheduled hibernation cancelled." : "No scheduled hibernation to cancel.",
      );
    } catch (error) {
      setMessage(`Cancel failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setCancelling(false);
    }
  };

  const isPending = Boolean(pending?.pending && pending.scheduledAt != null);
  const remainingMs = isPending && pending?.scheduledAt != null ? pending.scheduledAt - now : 0;
  const idleActiveSessions = onIdle?.activeSessions ?? 0;
  const idleBlockedReason = onIdle?.blockedReason ?? null;
  const idleHibernateAt = onIdle?.hibernateAt ?? null;
  const idleRemainingMs = idleHibernateAt != null ? idleHibernateAt - now : 0;

  const quietButton = cx(DS.button.base, DS.button.size.sm, DS.button.variant.ghost, "gap-1.5");

  return (
    <SettingsSection id="settings-system-power" title="Host power">
      <SettingList>
        <SettingRow
          label="Hibernate"
          htmlFor="hibernate-delay"
          control={(
            <>
              <select
                id="hibernate-delay"
                value={delayMinutes}
                onChange={(event) => setDelayMinutes(Number(event.target.value))}
                disabled={hibernating}
                aria-label="Hibernation delay"
                className={cx(DS.field.input, DS.field.inputSize.md, DS.setting.compactField)}
              >
                {HIBERNATE_DELAY_MINUTES.map((minutes) => (
                  <option key={minutes} value={minutes}>
                    {DELAY_LABELS[minutes] ?? `In ${minutes} minutes`}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => void handleHibernate()}
                disabled={hibernating}
                className={cx(DS.button.base, DS.button.size.sm, DS.button.variant.secondary, "gap-1.5")}
              >
                {hibernating ? <Loader2 size={12} className="animate-spin" /> : <Moon size={12} />}
                {delayMinutes > 0 ? "Schedule" : "Hibernate"}
              </button>
            </>
          )}
        >
          {isPending && pending?.scheduledAt != null && (
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-text-primary">
              <span>
                Hibernating in <span className="font-medium tabular-nums">{formatCountdown(remainingMs)}</span> (at{" "}
                {formatClock(pending.scheduledAt)}).
              </span>
              <button type="button" onClick={() => void handleCancel()} disabled={cancelling} className={quietButton}>
                {cancelling ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />}
                Cancel
              </button>
            </div>
          )}
        </SettingRow>
        <SettingRow
          label="Hibernate when idle"
          hint={`After every session has been idle for ${HIBERNATE_IDLE_GRACE_MINUTES} minutes.`}
          control={(
            <button
              type="button"
              onClick={() => void handleToggleOnIdle()}
              disabled={togglingOnIdle}
              aria-pressed={onIdleArmed}
              title={
                onIdleArmed
                  ? "Turn off automatic hibernation when all sessions are idle"
                  : "Hibernate automatically once all sessions are idle"
              }
              className={cx(DS.button.base, DS.button.size.sm, "gap-1.5", onIdleArmed ? DS.segmented.selected : DS.button.variant.secondary)}
            >
              {togglingOnIdle ? <Loader2 size={12} className="animate-spin" /> : <Timer size={12} />}
              {onIdleArmed ? "On idle: on" : "On idle"}
            </button>
          )}
        >
          {onIdleArmed && (
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-text-primary">
              <span>
                {idleBlockedReason ? (
                  <>
                    Hibernating on idle — held because{" "}
                    <span className="font-medium">{idleBlockedReason.toLowerCase()}</span>.
                  </>
                ) : idleActiveSessions > 0 ? (
                  <>
                    Hibernating on idle — waiting for{" "}
                    <span className="font-medium">
                      {idleActiveSessions} active session{idleActiveSessions === 1 ? "" : "s"}
                    </span>{" "}
                    to finish.
                  </>
                ) : idleHibernateAt != null ? (
                  <>
                    All sessions idle — hibernating in{" "}
                    <span className="font-medium tabular-nums">{formatCountdown(idleRemainingMs)}</span>.
                  </>
                ) : (
                  <>Hibernating on idle — waiting for all sessions to go idle.</>
                )}
              </span>
              <button type="button" onClick={() => void handleToggleOnIdle()} disabled={togglingOnIdle} className={quietButton}>
                {togglingOnIdle ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />}
                Turn off
              </button>
            </div>
          )}
        </SettingRow>
      </SettingList>
      {readError && <Notice tone="danger" title="Could not refresh host power">{readError}</Notice>}
      {message && <p role="status" className={cx(DS.field.help, "mt-2")}>{message}</p>}
    </SettingsSection>
  );
}
