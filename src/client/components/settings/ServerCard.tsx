import { useState } from "react";
import { ChevronRight, Pencil, Trash2 } from "lucide-react";
import type { McpServerConfig, McpServerStatus } from "../../api";
import {
  classifyMcpServerExecution,
  getMcpServerTransport,
  isLocalMcpServerConfig,
} from "../../../mcp-config";
import { MCP_CONNECTION_GUIDANCE, mcpObservationLabel, mcpObservationTitle } from "../mcp-status-display";
import { summarizeMcpServerExecution } from "./mcp-display";
import { Button, Field, FieldList, StatusIcon, Switch } from "../../design/primitives";
import { DS, cx, type DsStatusKind } from "../../design/tokens";

type StatusDisplay = { kind?: DsStatusKind; word: string; tone: string; title?: string };

function describeStatus(status: McpServerStatus | undefined): StatusDisplay {
  switch (status?.status) {
    case "connected":
      return { kind: "on", word: "Connected", tone: "text-text-secondary", title: MCP_CONNECTION_GUIDANCE };
    case "failed":
      return { kind: "danger", word: "Failed", tone: "text-error", title: status.error };
    case "needs-auth":
      return { kind: "warning", word: "Needs sign-in", tone: "text-warning", title: "Open a session using this server to sign in." };
    case "pending":
      return { kind: "working", word: "Connecting", tone: "text-text-secondary" };
    case "disabled":
      return { word: "Disabled", tone: "text-text-faint" };
    case "not_configured":
      return { word: "Not configured", tone: "text-text-faint" };
    default:
      return { word: "No status", tone: "text-text-faint" };
  }
}

export function ServerCard({
  name,
  config,
  status,
  enabledByDefault,
  onToggleEnabledByDefault,
  defaultToggleDisabled,
  onEdit,
  onRemove,
  defaultExpanded = false,
}: {
  name: string;
  config: McpServerConfig;
  status?: McpServerStatus;
  enabledByDefault?: boolean;
  onToggleEnabledByDefault?: (enabled: boolean) => void;
  defaultToggleDisabled?: boolean;
  onEdit: () => void;
  onRemove: () => void;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const transport = getMcpServerTransport(config);
  const execution = classifyMcpServerExecution(config);
  const display = describeStatus(status);
  const local = isLocalMcpServerConfig(config);
  const secretNames = local ? Object.keys(config.env ?? {}) : Object.keys(config.headers ?? {});

  return (
    <div className="min-w-0 py-1.5 first:pt-0 last:pb-0">
      <div className="flex min-w-0 items-center gap-3">
        <button
          type="button"
          onClick={() => setExpanded((open) => !open)}
          aria-expanded={expanded}
          aria-label={`${name} details`}
          className={cx(DS.row.base, DS.row.touch, DS.row.interactive, "flex-1 gap-2.5")}
        >
          <ChevronRight size={13} aria-hidden="true" className={cx(DS.row.chevron, expanded && DS.row.chevronOpen)} />
          <span className="min-w-0 truncate font-medium text-text-primary">{name}</span>
          <span className={cx(DS.text.literal, "hidden shrink-0 sm:inline")}>{transport}</span>
          <span className={cx("ml-auto inline-flex shrink-0 items-center gap-1.5 text-xs", display.tone)} title={display.title}>
            {display.kind && <StatusIcon kind={display.kind} decorative />}
            {display.word}
          </span>
        </button>
        {onToggleEnabledByDefault && (
          <Switch
            checked={!!enabledByDefault}
            disabled={defaultToggleDisabled}
            onChange={(event) => onToggleEnabledByDefault(event.target.checked)}
            aria-label={`Attach ${name} to every session`}
            title="Attach to every session"
          />
        )}
      </div>

      {expanded && (
        <div className={cx(DS.rail, DS.motion.reveal, "space-y-2 pb-2")}>
          {status && (
            <p className={DS.field.help} title={mcpObservationTitle(status)}>
              {mcpObservationLabel(status)}
              {status.status === "connected" && ` · ${MCP_CONNECTION_GUIDANCE}`}
            </p>
          )}
          {status?.status === "failed" && status.error && (
            <p className="text-xs text-error">{status.error}</p>
          )}
          <FieldList>
            <Field label="Execution" mono>
              {summarizeMcpServerExecution(config)}
              <span className={cx(DS.field.help, "block font-sans")}>{execution.reason}</span>
            </Field>
            {local ? (
              <>
                <Field label="Command" mono>{config.command}</Field>
                {config.args.length > 0 && <Field label="Arguments" mono>{config.args.join(" ")}</Field>}
              </>
            ) : (
              <Field label="URL" mono>{config.url}</Field>
            )}
            {config.tools && config.tools.length > 0 && <Field label="Tools" mono>{config.tools.join(", ")}</Field>}
            {secretNames.length > 0 && <Field label={local ? "Environment" : "Headers"} mono>{secretNames.join(", ")}</Field>}
          </FieldList>
          <div className="flex flex-wrap gap-1">
            <Button size="sm" variant="ghost" icon={<Pencil size={13} />} onClick={onEdit} aria-label={`Edit ${name}`}>Edit</Button>
            <Button size="sm" variant="danger" icon={<Trash2 size={13} />} onClick={onRemove} aria-label="Remove">Remove</Button>
          </div>
        </div>
      )}
    </div>
  );
}
