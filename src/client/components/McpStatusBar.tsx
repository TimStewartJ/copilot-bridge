import { useMemo, useState, type ReactNode } from "react";
import type { ChatEntry, McpLoginResponse, McpServerStatus, SessionToolReadinessSnapshot } from "../api";
import type { SessionContextResponse, SessionContextSummary } from "../../shared/session-context.js";
import { Activity, AlertTriangle, CheckCircle2, ChevronDown, Loader2, Plug, XCircle } from "lucide-react";
import { buildChatTurnPreviews, summarizeContext } from "./SessionContextHelpers";
import SessionContextPanel from "./SessionContextPanel";
import { MCP_CONNECTION_GUIDANCE, mcpObservationLabel, recentToolFailures } from "./mcp-status-display";
import { DS, cx } from "../design/tokens";
import { Button, Details, Notice } from "../design/primitives";
import { formatUsageUsd } from "../lib/usage-presentation";

interface McpStatusBarProps {
  chatEntries?: ChatEntry[];
  context?: SessionContextResponse | null;
  contextError?: string | null;
  contextLoading?: boolean;
  liveContextSummary?: SessionContextSummary | null;
  sessionCostLoading?: boolean;
  sessionCostUsd?: number | null;
  sessionCostError?: string;
  onAuthenticate?: (serverName: string, options?: { forceReauth?: boolean }) => Promise<McpLoginResponse>;
  onRefresh?: () => Promise<void>;
  servers: McpServerStatus[];
  toolReadiness?: SessionToolReadinessSnapshot;
  statusError?: string;
  statusState: "loading" | "ready" | "error" | "stale";
  /** What the line is about: the session and the model it runs on. Shown even with nothing to report. */
  leading?: ReactNode;
  /** Actions that belong to the session, such as opening its plan. */
  actions?: ReactNode;
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

export default function McpStatusBar({
  chatEntries,
  context,
  contextError,
  contextLoading,
  liveContextSummary,
  sessionCostLoading,
  sessionCostUsd,
  sessionCostError,
  onAuthenticate,
  onRefresh,
  servers,
  toolReadiness,
  statusError,
  statusState,
  leading,
  actions,
}: McpStatusBarProps) {
  const [authenticatingServer, setAuthenticatingServer] = useState<string | null>(null);
  const [authLinks, setAuthLinks] = useState<Record<string, string>>({});
  const [authErrors, setAuthErrors] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState(false);
  const previews = useMemo(() => buildChatTurnPreviews(chatEntries), [chatEntries]);
  const toolFailures = useMemo(() => recentToolFailures(chatEntries), [chatEntries]);

  const summary = context?.summary || liveContextSummary
    ? ({ ...(context?.summary ?? {}), ...(liveContextSummary ?? {}) } as SessionContextSummary)
    : null;
  const capabilities = context?.capabilities;
  const hasContextSignal = Boolean(contextLoading || contextError || summary || (context?.turns?.length ?? 0) > 0 || (context?.events?.length ?? 0) > 0);
  const hasMcpSignal = statusState !== "ready" || servers.length > 0 || Boolean(toolReadiness);
  const hasSessionCostSignal = Boolean(sessionCostLoading || sessionCostError || sessionCostUsd !== undefined);
  const hasSignals = hasMcpSignal || hasContextSignal || hasSessionCostSignal || toolFailures.length > 0;
  if (!hasSignals && !leading && !actions) return null;

  const connected = servers.filter((s) => s.status === "connected").length;
  const needsAuth = servers.filter((s) => s.status === "needs-auth").length;
  const failed = servers.filter((s) => s.status === "failed").length;
  const pending = servers.filter((s) => s.status === "pending").length;
  const hasProblem = failed > 0 || needsAuth > 0;
  const contextSummary = summarizeContext(summary, capabilities, contextLoading, contextError);
  const sessionCostLabel = sessionCostUsd != null ? formatUsageUsd(sessionCostUsd)
    : sessionCostError ? "unavailable" : sessionCostLoading ? "..." : "Not recorded";
  const statusSummary = statusState === "loading"
    ? "MCP loading"
    : statusState === "error"
      ? "MCP status unavailable"
      : `MCP ${connected}/${servers.length}`;

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

  const mcpNeedsAttention = hasProblem || statusState !== "ready" || pending > 0;
  const hasHeaderAttention = mcpNeedsAttention || toolFailures.length > 0
    || toolReadiness?.state === "initializing" || toolReadiness?.state === "failed";
  const metricClass = leading && hasHeaderAttention ? "hidden sm:flex" : "flex";

  return (
    <div className="shrink-0 border-b border-border">
      <div className={DS.layout.headerBar}>
        {leading && <div className="flex min-w-0 flex-1 items-center gap-2">{leading}</div>}
        {actions}
        {hasSignals && (
          <button
            type="button"
            aria-label="Session details"
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
            className={cx(
              "-mr-1.5 flex min-h-10 min-w-0 items-center gap-2 rounded-md px-1.5 py-1 transition-colors hover:bg-bg-hover/60 md:min-h-6",
              DS.focus,
              leading ? "max-w-[65%] shrink-0 sm:max-w-none" : "flex-1 justify-between",
            )}
          >
            <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 tabular-nums">
              {/* A healthy connection count is detail; on a phone it gives way to the model name. */}
              {hasMcpSignal && <span className={cx("items-center gap-1.5", mcpNeedsAttention || !leading ? "flex" : "hidden sm:flex")} title={`${connected} of ${servers.length} MCP servers connected`}>
                <Plug size={12} className="text-text-faint" />
                <span>
                  {statusSummary}
                  {pending > 0 && <Loader2 size={10} className="ml-1 inline animate-spin" aria-label={`${pending} connecting`} />}
                  {statusState === "stale" && <span className="text-warning ml-1">stale</span>}
                </span>
              </span>}
              {toolReadiness?.state === "initializing" && <span role="status">Tools initializing...</span>}
              {toolReadiness?.state === "failed" && <span className="text-warning">Tool initialization failed</span>}
              {hasProblem && (
                <span className={`flex items-center gap-0.5 ${failed > 0 ? "text-error" : "text-warning"}`}>
                  <AlertTriangle size={10} />
                  {[failed > 0 && `${failed} failed`, needsAuth > 0 && `${needsAuth} sign-in`].filter(Boolean).join(", ")}
                </span>
              )}
              {toolFailures.length > 0 && (
                <span className="flex items-center gap-1 text-warning">
                  <AlertTriangle size={10} aria-hidden="true" />
                  {toolFailures.length} tool issue{toolFailures.length === 1 ? "" : "s"}
                </span>
              )}
              {/* Phone-width chrome makes room for problems first; the figures remain in details. */}
              {hasContextSignal && <span className={cx(metricClass, "items-center gap-1 text-text-secondary")} title="Context window in use">
                <Activity size={12} className="text-text-faint" />
                <span className={leading ? "hidden sm:inline" : undefined}>Context </span>{contextSummary}
              </span>}
              {hasSessionCostSignal && (
                <span
                  className={cx(metricClass, "items-center gap-1 text-text-secondary")}
                  title="SDK-reported cost for this session, not an invoice"
                >
                  <span className={leading ? "hidden sm:inline" : undefined}>Cost </span>{sessionCostLabel}
                  {sessionCostError && <AlertTriangle size={10} className="text-warning" aria-label="Cost refresh failed" />}
                </span>
              )}
            </span>
            <ChevronDown size={12} aria-hidden="true" className={cx("shrink-0 text-text-faint transition-transform duration-150", expanded && "rotate-180")} />
          </button>
        )}
      </div>

      {expanded && hasSignals && (
        <div className={cx("w-full max-w-3xl max-h-[min(50vh,440px)] overflow-y-auto px-3 pb-3 pt-1 space-y-3 sm:px-4", DS.motion.reveal)}>
          {hasSessionCostSignal && (
            <div>
              <div className="flex items-center justify-between gap-3 text-xs text-text-muted">
                <span title="Cumulative cost reported by the Copilot SDK, not an invoice">Session cost</span>
                <span className={DS.usage.value}>{sessionCostLabel}</span>
              </div>
              <p className={cx(DS.usage.prose, "mt-1")}>SDK-reported for this session; separate from account quota and local price estimates.</p>
              {sessionCostError && (
                <Notice tone="warning" role="alert" icon={<AlertTriangle size={14} />} className="mt-2">
                  Cost refresh failed: {sessionCostError}{sessionCostUsd != null ? ". Showing the previous reading." : ""}
                </Notice>
              )}
            </div>
          )}
          {hasContextSignal && (
            <SessionContextPanel
              capabilities={capabilities}
              context={context}
              error={contextError}
              loading={contextLoading}
              previews={previews}
              summary={summary}
            />
          )}
          {toolFailures.length > 0 && (
            <Details open label="Recent tool failures" tone="warning">
              <div className="space-y-2 text-xs leading-relaxed text-text-muted">
                {toolFailures.map(({ name, failure }) => (
                  <p key={name}><span className="font-medium text-text-primary">{name}: {failure.category}</span><br />{failure.guidance}</p>
                ))}
              </div>
            </Details>
          )}
          {hasMcpSignal && <Details
            key={hasProblem || statusState !== "ready" || (toolReadiness && toolReadiness.state !== "ready") ? "attention" : "healthy"}
            open={hasProblem || statusState !== "ready" || Boolean(toolReadiness && toolReadiness.state !== "ready")}
            label="MCP servers"
            detail={`${connected}/${servers.length} connected`}
          >
            <p className="mb-2 text-xs leading-relaxed text-text-muted">{MCP_CONNECTION_GUIDANCE}</p>
            {toolReadiness && (
              <div className="mb-2 text-xs text-text-muted" role={toolReadiness.state === "failed" ? "alert" : "status"}>
                <p>{toolReadiness.state === "initializing"
                  ? "Tool initialization is in progress. Discovery can take several minutes."
                  : toolReadiness.state === "failed"
                    ? "Tool initialization failed. Check the initialization error before retrying."
                    : "Tool initialization completed. This does not prove every capability or resource permission is available."}</p>
                <p>Started: {toolReadiness.startedAt}{toolReadiness.completedAt ? `, completed: ${toolReadiness.completedAt}` : ""}</p>
                {toolReadiness.error && <p className="break-words text-error">{toolReadiness.error}</p>}
              </div>
            )}
            {statusState === "loading" ? (
              <p className="flex items-center gap-1.5 text-xs text-text-muted" role="status">
                <Loader2 size={12} className="animate-spin" />
                Loading servers...
              </p>
            ) : statusState === "error" || statusState === "stale" ? (
              <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-error" role="alert">
                <AlertTriangle size={12} />
                <span>{statusError || "MCP server status could not be loaded."}</span>
                {onRefresh && <Button size="sm" variant="danger" onClick={() => void onRefresh()}>Retry</Button>}
              </div>
            ) : null}
            {servers.length > 0 ? (
              <div className="space-y-1">
                {servers.map((server) => (
                  <div key={server.name} className="flex flex-wrap items-center gap-2 text-xs py-0.5">
                    <StatusIcon status={server.status} />
                    <span className="font-medium text-text-primary">{server.name}</span>
                    <span className="text-text-muted" title={MCP_CONNECTION_GUIDANCE}>{statusLabel(server.status)}</span>
                    <span className="basis-full pl-5 text-text-faint">{mcpObservationLabel(server)}</span>
                    {server.status === "needs-auth" && onAuthenticate && (
                      <>
                        <Button
                          size="sm"
                          className="ml-auto"
                          onClick={() => void startAuth(server.name)}
                          disabled={authenticatingServer === server.name}
                        >
                          {authenticatingServer === server.name ? "Starting..." : "Start sign-in"}
                        </Button>
                        {authLinks[server.name] && (
                          <>
                            <a
                              href={authLinks[server.name]}
                              target="_blank"
                              rel="noopener noreferrer"
                              className={cx(DS.button.base, DS.button.size.sm, DS.button.variant.secondary)}
                            >
                              Open sign-in
                            </a>
                            {onRefresh && <Button size="sm" variant="ghost" onClick={() => void onRefresh()}>Check status</Button>}
                          </>
                        )}
                      </>
                    )}
                    {server.error && (
                      <span className="basis-full break-words pl-5 text-error" title={server.error}>
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
            ) : statusState === "ready" ? (
              <p className="text-xs text-text-muted">No MCP connection observations. This does not establish tool capability readiness.</p>
            ) : null}
          </Details>}
        </div>
      )}
    </div>
  );
}
