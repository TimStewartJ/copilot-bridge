import { useEffect, useState } from "react";
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

export function DeviceManagementSection() {
  const [delayMinutes, setDelayMinutes] = useState(0);
  const [hibernating, setHibernating] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [togglingOnIdle, setTogglingOnIdle] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState<DeviceHibernateStatus | null>(null);
  const [onIdle, setOnIdle] = useState<DeviceHibernateOnIdleStatus | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let active = true;
    void fetchHibernateStatus()
      .then((status) => {
        if (!active) return;
        if (status.pending) setPending(status);
        setOnIdle(armedIdleStatus(status));
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!pending?.pending || pending.scheduledAt == null) return;
    const scheduledAt = pending.scheduledAt;
    setNow(Date.now());
    const id = setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= scheduledAt) {
        clearInterval(id);
        // The server timer should have fired; confirm real state rather than
        // assuming the device hibernated.
        void fetchHibernateStatus()
          .then((status) => setPending(status.pending ? status : null))
          .catch(() => setPending(null));
      }
    }, 1000);
    return () => clearInterval(id);
  }, [pending]);

  const onIdleArmed = Boolean(onIdle?.armed);

  // While armed the countdown and active-session count are server-owned, so
  // re-read them instead of simulating idleness locally.
  useEffect(() => {
    if (!onIdleArmed) return;
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const poll = setInterval(() => {
      void fetchHibernateStatus()
        .then((status) => {
          setOnIdle(armedIdleStatus(status));
          setPending(status.pending ? status : null);
        })
        .catch(() => {});
    }, IDLE_STATUS_POLL_MS);
    return () => {
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [onIdleArmed]);

  const handleHibernate = async () => {
    const label = (DELAY_LABELS[delayMinutes] ?? `In ${delayMinutes} minutes`).toLowerCase();
    const confirmed = window.confirm(
      delayMinutes > 0
        ? `Schedule hibernation ${label}?\n\nCopilot Bridge and other apps will pause until the device wakes.`
        : "Hibernate this device now?\n\nCopilot Bridge and other apps will pause until the device wakes.",
    );
    if (!confirmed) return;

    setHibernating(true);
    setMessage(null);
    try {
      const result = await hibernateDevice(delayMinutes);
      setMessage(result.message);
      setPending(result.pending ? result : null);
      setOnIdle(armedIdleStatus(result));
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
        `Hibernate this device once every session has been idle for ${HIBERNATE_IDLE_GRACE_MINUTES} minutes?\n\nCopilot Bridge and other apps will pause until the device wakes.`,
      );
      if (!confirmed) return;
    }

    setTogglingOnIdle(true);
    setMessage(null);
    try {
      const result = await setHibernateOnIdle(nextEnabled);
      setOnIdle(result.armed ? result : null);
      setMessage(result.message);
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
      setPending(null);
      setOnIdle(armedIdleStatus(result));
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
  const idleHibernateAt = onIdle?.hibernateAt ?? null;
  const idleRemainingMs = idleHibernateAt != null ? idleHibernateAt - now : 0;

  return (
    <SettingsSection
      title="Device Management"
      description="Shortcuts for managing the device running this Copilot Bridge instance."
    >
      <div className="rounded-md border border-border bg-bg-elevated p-4 space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-medium text-accent">
              <Moon size={15} />
              Hibernate device
            </div>
            <p className="mt-1 text-xs text-text-muted">
              Put the host device into hibernation now or after a delay. Bridge resumes when the
              device wakes. &ldquo;On idle&rdquo; waits until every session has been idle for{" "}
              {HIBERNATE_IDLE_GRACE_MINUTES} minutes, then hibernates.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <select
              value={delayMinutes}
              onChange={(event) => setDelayMinutes(Number(event.target.value))}
              disabled={hibernating}
              aria-label="Hibernation delay"
              className="rounded-md border border-border bg-bg-surface px-2 py-1.5 text-xs text-text-primary disabled:cursor-not-allowed disabled:text-text-faint"
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
              className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md bg-warning px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-warning/90 disabled:cursor-wait disabled:bg-bg-surface disabled:text-text-faint"
            >
              {hibernating ? <Loader2 size={12} className="animate-spin" /> : <Moon size={12} />}
              {delayMinutes > 0 ? "Schedule" : "Hibernate"}
            </button>
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
              className={`inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-wait disabled:bg-bg-surface disabled:text-text-faint ${
                onIdleArmed
                  ? "bg-accent text-white hover:bg-accent/90"
                  : "border border-border bg-bg-surface text-text-primary hover:bg-bg-primary"
              }`}
            >
              {togglingOnIdle ? <Loader2 size={12} className="animate-spin" /> : <Timer size={12} />}
              {onIdleArmed ? "On idle: on" : "On idle"}
            </button>
          </div>
        </div>

        {onIdleArmed && (
          <div className="flex flex-col gap-2 rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-xs text-text-primary sm:flex-row sm:items-center sm:justify-between">
            <span>
              {idleActiveSessions > 0 ? (
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
                  <span className="font-medium">{formatCountdown(idleRemainingMs)}</span>.
                </>
              ) : (
                <>Hibernating on idle — waiting for all sessions to go idle.</>
              )}
            </span>
            <button
              type="button"
              onClick={() => void handleToggleOnIdle()}
              disabled={togglingOnIdle}
              className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md border border-border bg-bg-surface px-2.5 py-1 text-xs font-medium text-text-primary transition-colors hover:bg-bg-primary disabled:cursor-wait disabled:text-text-faint"
            >
              {togglingOnIdle ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />}
              Turn off
            </button>
          </div>
        )}

        {isPending && pending?.scheduledAt != null && (
          <div className="flex flex-col gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-text-primary sm:flex-row sm:items-center sm:justify-between">
            <span>
              Hibernating in <span className="font-medium">{formatCountdown(remainingMs)}</span> (at{" "}
              {formatClock(pending.scheduledAt)}).
            </span>
            <button
              type="button"
              onClick={() => void handleCancel()}
              disabled={cancelling}
              className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md border border-border bg-bg-surface px-2.5 py-1 text-xs font-medium text-text-primary transition-colors hover:bg-bg-primary disabled:cursor-wait disabled:text-text-faint"
            >
              {cancelling ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />}
              Cancel
            </button>
          </div>
        )}

        {message && (
          <div className="rounded-md border border-border bg-bg-primary px-3 py-2 text-xs text-text-muted">
            {message}
          </div>
        )}
      </div>
    </SettingsSection>
  );
}
