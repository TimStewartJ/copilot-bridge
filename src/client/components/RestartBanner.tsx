import { CheckCircle, RefreshCw } from "lucide-react";

interface Props {
  phase: "pending" | "reconnected";
  waitingSessions: number;
}

export default function RestartBanner({ phase, waitingSessions }: Props) {
  if (phase === "reconnected") {
    return (
      <div className="shrink-0 flex items-center gap-2 px-4 py-2 border-b text-sm" style={{ backgroundColor: "var(--color-success-bg, #d1fae5)", borderColor: "var(--color-success-border, #6ee7b7)", color: "var(--color-success-text, #065f46)" }}>
        <CheckCircle size={14} />
        <span>Server reconnected</span>
      </div>
    );
  }

  return (
    <div className="shrink-0 flex items-center gap-2 px-4 py-2 border-b text-sm" style={{ backgroundColor: "var(--color-restart-bg)", borderColor: "var(--color-restart-border)", color: "var(--color-restart-text)" }}>
      <RefreshCw size={14} className="animate-spin" />
      <span>
        Server restart pending
        {waitingSessions > 0
          ? ` — waiting on ${waitingSessions} active session${waitingSessions !== 1 ? "s" : ""}`
          : " — restarting shortly"}
      </span>
    </div>
  );
}
