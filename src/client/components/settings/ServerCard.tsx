import type { McpServerConfig, McpServerStatus } from "../../api";
import { CheckCircle2, XCircle, Loader2, AlertTriangle } from "lucide-react";
import { getMcpServerTransport, isLocalMcpServerConfig } from "../../../mcp-config";
import { ConfigCard } from "./ConfigCard";
import { summarizeMcpServerConfig } from "./mcp-display";

export function ServerCard({
  name,
  config,
  status,
  enabledByDefault,
  onToggleEnabledByDefault,
  defaultToggleDisabled,
  onEdit,
  onRemove,
}: {
  name: string;
  config: McpServerConfig;
  status?: McpServerStatus;
  enabledByDefault?: boolean;
  onToggleEnabledByDefault?: (enabled: boolean) => void;
  defaultToggleDisabled?: boolean;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const st = status?.status;
  const transport = getMcpServerTransport(config);
  const statusBadge = (() => {
    switch (st) {
      case "connected":
        return (
          <span className="text-[10px] px-1.5 py-0.5 bg-success/15 text-success rounded-full flex items-center gap-0.5">
            <CheckCircle2 size={10} /> connected
          </span>
        );
      case "failed":
        return (
          <span className="text-[10px] px-1.5 py-0.5 bg-error/15 text-error rounded-full flex items-center gap-0.5" title={status?.error}>
            <XCircle size={10} /> failed
          </span>
        );
      case "needs-auth":
        return (
          <span className="text-[10px] px-1.5 py-0.5 bg-warning/15 text-warning rounded-full flex items-center gap-0.5" title="Open a session using this server to sign in.">
            <AlertTriangle size={10} /> needs auth
          </span>
        );
      case "pending":
        return (
          <span className="text-[10px] px-1.5 py-0.5 bg-warning/15 text-warning rounded-full flex items-center gap-0.5">
            <Loader2 size={10} className="animate-spin" /> connecting
          </span>
        );
      case "disabled":
      case "not_configured":
        return (
          <span className="text-[10px] px-1.5 py-0.5 bg-bg-secondary text-text-muted rounded-full">
            {st}
          </span>
        );
      default:
        return (
          <span className="text-[10px] px-1.5 py-0.5 bg-bg-secondary text-text-faint rounded-full flex items-center gap-0.5">
            <AlertTriangle size={10} /> no status
          </span>
        );
    }
  })();

  return (
    <ConfigCard
      title={name}
      badge={statusBadge}
      onEdit={onEdit}
      onRemove={onRemove}
      removeTitle="Remove"
    >
      {st === "failed" && status?.error && (
        <div className="mt-1 text-[11px] text-error bg-error/5 px-2 py-1 rounded">
          {status.error}
        </div>
      )}
      <div className="mt-2 space-y-1">
        <div className="text-xs text-text-muted">
          <span className="text-text-faint">transport:</span>{" "}
          <code className="text-text-secondary">{transport}</code>
        </div>
        {isLocalMcpServerConfig(config) ? (
          <>
            <div className="text-xs text-text-muted">
              <span className="text-text-faint">command:</span>{" "}
              <code className="text-text-secondary">{config.command}</code>
            </div>
            {config.args.length > 0 && (
              <div className="text-xs text-text-muted">
                <span className="text-text-faint">args:</span>{" "}
                <code className="text-text-secondary break-all">
                  {config.args.join(" ")}
                </code>
              </div>
            )}
          </>
        ) : (
          <div className="text-xs text-text-muted">
            <span className="text-text-faint">url:</span>{" "}
            <code className="text-text-secondary break-all">{config.url}</code>
          </div>
        )}
        {config.tools && config.tools.length > 0 && (
          <div className="text-xs text-text-muted">
            <span className="text-text-faint">tools:</span>{" "}
            <code className="text-text-secondary">
              {config.tools.join(", ")}
            </code>
          </div>
        )}
        {isLocalMcpServerConfig(config) ? (
          config.env && Object.keys(config.env).length > 0 && (
            <div className="text-xs text-text-muted">
              <span className="text-text-faint">env:</span>{" "}
              <code className="text-text-secondary">
                {Object.keys(config.env).join(", ")}
              </code>
            </div>
          )
        ) : (
          config.headers && Object.keys(config.headers).length > 0 && (
            <div className="text-xs text-text-muted">
              <span className="text-text-faint">headers:</span>{" "}
              <code className="text-text-secondary">
                {Object.keys(config.headers).join(", ")}
              </code>
            </div>
          )
        )}
        {onToggleEnabledByDefault && (
          <label
            className="mt-3 flex items-start gap-2 rounded-md border border-border bg-bg-surface/60 px-2 py-2 text-xs text-text-muted"
            title={summarizeMcpServerConfig(config)}
          >
            <input
              type="checkbox"
              checked={!!enabledByDefault}
              disabled={defaultToggleDisabled}
              onChange={(e) => onToggleEnabledByDefault(e.target.checked)}
              className="mt-0.5 h-3.5 w-3.5 accent-accent disabled:opacity-50"
            />
            <span>
              <span className="font-medium text-text-secondary">Enabled by default</span>
              <span className="block text-[11px] text-text-faint">
                Attach this server to every session.
              </span>
            </span>
          </label>
        )}
      </div>
    </ConfigCard>
  );
}
