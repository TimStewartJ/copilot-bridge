import { RefreshCw } from "lucide-react";

interface Props {
  waitingSessions: number;
}

export default function RestartBanner({ waitingSessions }: Props) {
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
