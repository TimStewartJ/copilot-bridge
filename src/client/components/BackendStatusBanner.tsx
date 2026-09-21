import { AlertTriangle, CheckCircle2, Loader2, X } from "lucide-react";
import type { AgentBackendStatus } from "../../shared/agent-backend-status.js";
import type { BackendStatusBannerView } from "../lib/backend-status-banner-state";
import { IconButton, Notice } from "../design/primitives";

interface Props {
  banner: BackendStatusBannerView;
  onDismiss: () => void;
}

export default function BackendStatusBanner({ banner, onDismiss }: Props) {
  const { title, detail } = describeBackendStatusBanner(banner.status);
  const tone = banner.variant === "error" ? "danger" : banner.variant === "success" ? "success" : "warning";
  const icon = banner.variant === "success" ? <CheckCircle2 size={16} />
    : banner.variant === "error" ? <AlertTriangle size={16} /> : <Loader2 size={16} className="animate-spin" />;

  return (
    <div className="shrink-0 border-b border-border px-3 py-2 sm:px-4">
      <Notice
        tone={tone}
        icon={icon}
        title={title}
        action={<IconButton onClick={onDismiss} label="Dismiss agent backend status"><X size={14} /></IconButton>}
      >
        {detail}
      </Notice>
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
