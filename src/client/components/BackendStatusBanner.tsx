import { AlertTriangle, CheckCircle2, Loader2, X } from "lucide-react";
import type { AgentBackendStatus } from "../../shared/agent-backend-status.js";
import type { BackendStatusBannerView } from "../lib/backend-status-banner-state";

interface Props {
  banner: BackendStatusBannerView;
  onDismiss: () => void;
}

export default function BackendStatusBanner({ banner, onDismiss }: Props) {
  const { title, detail } = describeBackendStatusBanner(banner.status);
  const styles = banner.variant === "success"
    ? {
        wrapper: "border-success/30 bg-success/10 text-success",
        icon: <CheckCircle2 size={16} />,
      }
    : banner.variant === "error"
      ? {
          wrapper: "border-error/30 bg-error/10 text-error",
          icon: <AlertTriangle size={16} />,
        }
      : {
          wrapper: "border-warning/30 bg-warning/10 text-warning",
          icon: <Loader2 size={16} className="animate-spin" />,
        };

  return (
    <div className={`shrink-0 border-b px-4 py-3 text-sm ${styles.wrapper}`}>
      <div className="flex items-start gap-3">
        <div className="mt-0.5 shrink-0">{styles.icon}</div>
        <div className="min-w-0 flex-1">
          <div className="font-semibold">{title}</div>
          <div className="opacity-90">{detail}</div>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="rounded p-1 opacity-70 transition hover:bg-black/5 hover:opacity-100"
          aria-label="Dismiss agent backend status"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}

function describeBackendStatusBanner(status: AgentBackendStatus): { title: string; detail: string } {
  const reason = formatDisconnectReason(status);
  if (status.state === "reconnecting") {
    return {
      title: "Agent backend reconnecting...",
      detail: reason
        ? `In-flight turns were interrupted; they will be resumed automatically. Last disconnect: ${reason}.`
        : "In-flight turns were interrupted; they will be resumed automatically.",
    };
  }
  if (status.state === "disconnected") {
    return {
      title: "Agent backend disconnected",
      detail: reason
        ? `Last disconnect: ${reason}. Runs cannot continue until the backend reconnects.`
        : "Runs cannot continue until the backend reconnects.",
    };
  }

  const recoveredAt = formatTime(status.lastRecoveryAt);
  const sessions = status.lastAutoResumedSessionCount;
  return {
    title: `Agent backend recovered at ${recoveredAt}`,
    detail: `Recovered after ${reason ?? "a disconnect"}; ${sessions} session${sessions === 1 ? "" : "s"} resumed automatically.`,
  };
}

function formatDisconnectReason(status: AgentBackendStatus): string | null {
  const reason = status.lastDisconnect?.reason?.trim();
  if (!reason) return null;
  const detail = status.lastDisconnect?.detail?.trim();
  return detail ? `${reason} - ${detail}` : reason;
}

function formatTime(value: string | null): string {
  if (!value) return "unknown time";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}
