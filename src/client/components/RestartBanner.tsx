import { AlertTriangle, RefreshCw, Users } from "lucide-react";
import type { RestartStatusPhase } from "../api";
import type { RestartBannerPhase } from "../lib/restart-banner-state";

interface Props {
  phase: Exclude<RestartBannerPhase, null>;
  restartPhase: RestartStatusPhase;
  waitingSessions: number;
  canAcceptNewWork: boolean;
  abortingSessions?: boolean;
  abortError?: string | null;
  onAbortSessionsAndResume?: () => void;
}

export default function RestartBanner({
  phase,
  restartPhase,
  waitingSessions,
  canAcceptNewWork,
  abortingSessions = false,
  abortError = null,
  onAbortSessionsAndResume,
}: Props) {
  if (phase === "reconnected") {
    return (
      <div className="shrink-0 flex items-center gap-2 px-4 py-2 border-b text-sm" style={{ backgroundColor: "var(--color-success-bg, #d1fae5)", borderColor: "var(--color-success-border, #6ee7b7)", color: "var(--color-success-text, #065f46)" }}>
        <RefreshCw size={14} className="animate-spin" />
        <span>Server reconnected — refreshing…</span>
      </div>
    );
  }

  const waitingOnSessions = waitingSessions > 0;
  const finalizingRestart = restartPhase === "restarting" || !canAcceptNewWork;
  const useWaitingStyle = waitingOnSessions && !finalizingRestart;
  const title = finalizingRestart
    ? "Restart in progress"
    : waitingOnSessions
      ? "Restart queued"
      : "Restart imminent";
  const detail = finalizingRestart
    ? waitingOnSessions
      ? `Restart is waiting for ${waitingSessions} active session${waitingSessions !== 1 ? "s" : ""} to finish. New messages and chats are paused until Bridge reconnects.`
      : "The server is restarting. New messages and chats are paused until Bridge reconnects."
    : waitingOnSessions
      ? `Restart will wait for ${waitingSessions} active session${waitingSessions !== 1 ? "s" : ""} to go idle; you can keep using Bridge.`
      : "The server is about to restart and this view may disconnect briefly.";

  return (
    <div
      className="shrink-0 border-b px-4 py-3 text-sm"
      style={useWaitingStyle
        ? {
            backgroundColor: "var(--color-restart-waiting-bg)",
            borderColor: "var(--color-restart-waiting-border)",
            color: "var(--color-restart-waiting-text)",
          }
        : {
            backgroundColor: "var(--color-restart-imminent-bg)",
            borderColor: "var(--color-restart-imminent-border)",
            color: "var(--color-restart-imminent-text)",
          }}
    >
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-2 sm:grid-cols-[auto_minmax(0,1fr)_auto_auto]">
        <div className="mt-0.5 shrink-0">
          {useWaitingStyle ? <Users size={16} /> : <AlertTriangle size={16} />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-semibold">
            {title}
          </div>
          <div className="opacity-90">
            {detail}
          </div>
          {abortError && <div className="mt-1 font-medium">{abortError}</div>}
        </div>
        {waitingOnSessions && onAbortSessionsAndResume && (
          <button
            type="button"
            onClick={onAbortSessionsAndResume}
            disabled={abortingSessions}
            aria-label="Abort sessions and resume with restart"
            className="col-span-2 col-start-2 row-start-2 w-full rounded-md border border-current/30 bg-white/10 px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-60 sm:col-span-1 sm:col-start-3 sm:row-start-1 sm:w-auto sm:py-1"
          >
            <span className="sm:hidden">
              {abortingSessions ? "Aborting sessions…" : "Abort, restart, and resume"}
            </span>
            <span className="hidden sm:inline">
              {abortingSessions ? "Aborting sessions…" : "Abort sessions and resume with restart"}
            </span>
          </button>
        )}
        <RefreshCw
          size={14}
          className="col-start-3 row-start-1 mt-0.5 shrink-0 animate-spin opacity-80 sm:col-start-4"
        />
      </div>
    </div>
  );
}
