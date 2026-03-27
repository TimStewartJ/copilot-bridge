import { useState } from "react";
import type { McpServerStatus } from "../api";
import { Plug, ChevronDown, ChevronUp, AlertTriangle, CheckCircle2, Loader2, XCircle } from "lucide-react";

interface McpStatusBarProps {
  servers: McpServerStatus[];
}

function StatusIcon({ status }: { status: McpServerStatus["status"] }) {
  switch (status) {
    case "connected":
      return <CheckCircle2 size={12} className="text-success" />;
    case "failed":
      return <XCircle size={12} className="text-error" />;
    case "pending":
      return <Loader2 size={12} className="text-warning animate-spin" />;
    case "disabled":
    case "not_configured":
      return <XCircle size={12} className="text-text-muted" />;
    default:
      return <AlertTriangle size={12} className="text-warning" />;
  }
}

function statusLabel(status: McpServerStatus["status"]): string {
  switch (status) {
    case "connected": return "Connected";
    case "failed": return "Failed";
    case "pending": return "Connecting...";
    case "disabled": return "Disabled";
    case "not_configured": return "Not configured";
    default: return "Unknown";
  }
}

export default function McpStatusBar({ servers }: McpStatusBarProps) {
  const [expanded, setExpanded] = useState(false);

  if (!servers || servers.length === 0) return null;

  const connected = servers.filter((s) => s.status === "connected").length;
  const failed = servers.filter((s) => s.status === "failed").length;
  const pending = servers.filter((s) => s.status === "pending").length;
  const hasProblem = failed > 0;

  return (
    <div className="shrink-0 border-b border-border bg-bg-secondary">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-1.5 text-xs hover:bg-bg-elevated transition-colors"
      >
        <span className="flex items-center gap-1.5 text-text-muted">
          <Plug size={12} />
          <span>
            MCP: {connected}/{servers.length} connected
            {pending > 0 && <span className="text-warning ml-1">({pending} connecting)</span>}
          </span>
          {hasProblem && (
            <span className="flex items-center gap-0.5 text-error">
              <AlertTriangle size={10} />
              {failed} failed
            </span>
          )}
        </span>
        {expanded ? <ChevronUp size={12} className="text-text-muted" /> : <ChevronDown size={12} className="text-text-muted" />}
      </button>

      {expanded && (
        <div className="px-4 pb-2 space-y-1">
          {servers.map((server) => (
            <div
              key={server.name}
              className="flex items-center gap-2 text-xs py-0.5"
            >
              <StatusIcon status={server.status} />
              <span className="font-medium text-text-primary">{server.name}</span>
              <span className="text-text-muted">{statusLabel(server.status)}</span>
              {server.error && (
                <span className="text-error truncate ml-auto max-w-[50%]" title={server.error}>
                  {server.error}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
