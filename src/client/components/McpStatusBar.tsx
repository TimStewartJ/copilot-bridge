import { useState } from "react";
import type { McpLoginResponse, McpServerStatus } from "../api";
import { Plug, ChevronDown, ChevronUp, AlertTriangle, CheckCircle2, Loader2, XCircle } from "lucide-react";

interface McpStatusBarProps {
  onAuthenticate?: (serverName: string, options?: { forceReauth?: boolean }) => Promise<McpLoginResponse>;
  onRefresh?: () => Promise<void>;
  servers: McpServerStatus[];
}

function StatusIcon({ status }: { status: McpServerStatus["status"] }) {
  switch (status) {
    case "connected":
      return <CheckCircle2 size={12} className="text-success" />;
    case "failed":
      return <XCircle size={12} className="text-error" />;
    case "needs-auth":
      return <AlertTriangle size={12} className="text-warning" />;
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
    case "needs-auth": return "Needs auth";
    case "failed": return "Failed";
    case "pending": return "Connecting...";
    case "disabled": return "Disabled";
    case "not_configured": return "Not configured";
    default: return "Unknown";
  }
}

export default function McpStatusBar({ servers, onAuthenticate, onRefresh }: McpStatusBarProps) {
  const [authenticatingServer, setAuthenticatingServer] = useState<string | null>(null);
  const [authLinks, setAuthLinks] = useState<Record<string, string>>({});
  const [authErrors, setAuthErrors] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState(false);

  if (!servers || servers.length === 0) return null;

  const connected = servers.filter((s) => s.status === "connected").length;
  const needsAuth = servers.filter((s) => s.status === "needs-auth").length;
  const failed = servers.filter((s) => s.status === "failed").length;
  const pending = servers.filter((s) => s.status === "pending").length;
  const hasProblem = failed > 0 || needsAuth > 0;

  const startAuth = async (serverName: string, forceReauth = false) => {
    if (!onAuthenticate) return;
    setAuthenticatingServer(serverName);
    setAuthErrors((current) => {
      const { [serverName]: _removed, ...rest } = current;
      return rest;
    });
    try {
      const result = await onAuthenticate(serverName, { forceReauth });
      if (result.authorizationUrl) {
        setAuthLinks((current) => ({ ...current, [serverName]: result.authorizationUrl! }));
      } else {
        setAuthLinks((current) => {
          const { [serverName]: _removed, ...rest } = current;
          return rest;
        });
        await onRefresh?.();
      }
    } catch (err) {
      setAuthErrors((current) => ({
        ...current,
        [serverName]: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setAuthenticatingServer(null);
    }
  };

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
            <span className={`flex items-center gap-0.5 ${failed > 0 ? "text-error" : "text-warning"}`}>
              <AlertTriangle size={10} />
              {failed > 0 ? `${failed} failed` : `${needsAuth} needs auth`}
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
              className="flex flex-wrap items-center gap-2 text-xs py-0.5"
            >
              <StatusIcon status={server.status} />
              <span className="font-medium text-text-primary">{server.name}</span>
              <span className="text-text-muted">{statusLabel(server.status)}</span>
              {server.status === "needs-auth" && onAuthenticate && (
                <>
                  <button
                    type="button"
                    onClick={() => void startAuth(server.name)}
                    disabled={authenticatingServer === server.name}
                    className="ml-auto rounded border border-warning/30 px-2 py-0.5 text-[11px] font-medium text-warning transition-colors hover:bg-warning/10 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {authenticatingServer === server.name ? "Starting..." : "Start sign-in"}
                  </button>
                  {authLinks[server.name] && (
                    <>
                      <a
                        href={authLinks[server.name]}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="rounded border border-accent/30 px-2 py-0.5 text-[11px] font-medium text-accent transition-colors hover:bg-accent/10"
                      >
                        Open sign-in
                      </a>
                      {onRefresh && (
                        <button
                          type="button"
                          onClick={() => void onRefresh()}
                          className="rounded border border-border px-2 py-0.5 text-[11px] text-text-muted transition-colors hover:bg-bg-elevated hover:text-text-primary"
                        >
                          Check status
                        </button>
                      )}
                    </>
                  )}
                </>
              )}
              {server.error && (
                <span className="text-error truncate ml-auto max-w-[50%]" title={server.error}>
                  {server.error}
                </span>
              )}
              {authErrors[server.name] && (
                <span className="basis-full pl-5 text-error" title={authErrors[server.name]}>
                  {authErrors[server.name]}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
