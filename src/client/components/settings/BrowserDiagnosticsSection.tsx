import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Monitor, RotateCw, X } from "lucide-react";
import {
  ApiError,
  closeHeadedDiagnosticsBrowser,
  fetchBrowserDiagnostics,
  launchHeadedDiagnosticsBrowser,
  type AppSettings,
  type BrowserHeadedCloseFailureDetails,
  type BrowserSettings,
  type BrowserDiagnosticsResponse,
  type BrowserDiagnosticsTone,
} from "../../api";
import { Field } from "./Field";
import { SettingsSection } from "./SettingsSection";

function statusToneClassName(tone: BrowserDiagnosticsTone): string {
  switch (tone) {
    case "success":
      return "bg-success/15 text-success";
    case "warning":
      return "bg-warning/15 text-warning";
    default:
      return "bg-error/10 text-error";
  }
}

function formatTimestamp(value: string | undefined): string {
  if (!value) return "unknown";
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : value;
}

function compactBrowserDraft(browser: BrowserSettings): BrowserSettings {
  return {
    ...(browser.executablePath ? { executablePath: browser.executablePath } : {}),
    ...(browser.masterProfileDirectory ? { masterProfileDirectory: browser.masterProfileDirectory } : {}),
    ...(browser.headed ? { headed: true } : {}),
  };
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((item) => typeof item === "number" && Number.isFinite(item));
}

function isBrowserHeadedCloseFailureDetails(value: unknown): value is BrowserHeadedCloseFailureDetails {
  if (!value || typeof value !== "object") return false;
  const details = value as Partial<BrowserHeadedCloseFailureDetails>;
  return isNumberArray(details.terminatedPids)
    && isNumberArray(details.killedPids)
    && isNumberArray(details.remainingPids)
    && typeof details.clearedRuntimeFiles === "number";
}

function formatHeadedCloseError(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason);
  if (!(reason instanceof ApiError) || !isBrowserHeadedCloseFailureDetails(reason.details)) return message;
  if (reason.details.remainingPids.length === 0) return message;
  const pids = reason.details.remainingPids.join(", ");
  return message.includes(pids) ? message : `${message} Remaining PIDs: ${pids}.`;
}

export function BrowserDiagnosticsSection({
  draft,
  setDraft,
}: {
  draft: AppSettings;
  setDraft: (d: AppSettings) => void;
}) {
  const [diagnostics, setDiagnostics] = useState<BrowserDiagnosticsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [launching, setLaunching] = useState(false);
  const [closing, setClosing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const refresh = useCallback(() => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setLoading(true);
    setError(null);
    void fetchBrowserDiagnostics()
      .then((value) => {
        if (requestIdRef.current !== requestId) return;
        setDiagnostics(value);
      })
      .catch((reason: unknown) => {
        if (requestIdRef.current !== requestId) return;
        setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (requestIdRef.current === requestId) setLoading(false);
      });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const updateBrowserSetting = (
    field: "executablePath" | "masterProfileDirectory",
    value: string,
  ) => {
    const next = structuredClone(draft);
    next.browser = compactBrowserDraft({
      ...draft.browser,
      [field]: value,
    });
    setDraft(next);
  };

  const updateBrowserHeaded = (headed: boolean) => {
    const next = structuredClone(draft);
    next.browser = compactBrowserDraft({
      ...draft.browser,
      headed,
    });
    setDraft(next);
  };

  const launchHeaded = async () => {
    setLaunching(true);
    setMessage(null);
    setError(null);
    try {
      const result = await launchHeadedDiagnosticsBrowser();
      setMessage(result.message);
      refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLaunching(false);
    }
  };

  const closeHeaded = async () => {
    setClosing(true);
    setMessage(null);
    setError(null);
    try {
      const result = await closeHeadedDiagnosticsBrowser();
      setMessage(result.message);
      refresh();
    } catch (reason) {
      setError(formatHeadedCloseError(reason));
    } finally {
      setClosing(false);
    }
  };

  const config = diagnostics?.config;
  const summary = diagnostics?.summary;
  const executablePathValue = draft.browser?.executablePath ?? "";
  const masterProfileDirectoryValue = draft.browser?.masterProfileDirectory ?? "";
  const headedValue = draft.browser?.headed === true;
  const binaryState = !config
    ? "checking"
    : !config.executablePathConfigured
      ? "auto-detect"
      : config.executablePathExists
        ? "found"
        : "missing";
  const profileState = !config
    ? "checking"
    : config.masterProfileDirectoryExists
      ? "present"
      : "not created yet";

  return (
    <SettingsSection
      title="Browser Diagnostics"
      description="Configure the Bridge-owned browser target, choose whether browser tools run headed, and review recent browser friction such as browser_web_search challenge pages."
      action={(
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-md bg-bg-surface px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-hover disabled:cursor-wait disabled:text-text-faint"
        >
          {loading ? <Loader2 size={12} className="animate-spin" /> : <RotateCw size={12} />}
          Refresh
        </button>
      )}
    >
      <div className="rounded-md border border-border bg-bg-elevated p-4 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-medium text-accent">
              <Monitor size={15} />
              Browser runtime
            </div>
            <p className="mt-1 text-xs text-text-muted">
              {summary?.detail ?? "Loading current browser diagnostics."}
            </p>
          </div>
          {summary && (
            <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium ${statusToneClassName(summary.tone)}`}>
              {summary.label}
            </span>
          )}
        </div>

        <div className="grid gap-3 lg:grid-cols-2">
          <Field label="Browser executable path">
            <input
              value={executablePathValue}
              onChange={(event) => updateBrowserSetting("executablePath", event.target.value)}
              placeholder="Leave blank to use the environment override, or auto-detect Chrome"
              className="w-full rounded-md border border-border bg-bg-primary px-3 py-2 text-xs text-text-primary outline-none placeholder:text-text-faint focus:border-accent"
            />
          </Field>
          <Field label="Browser master profile directory">
            <input
              value={masterProfileDirectoryValue}
              onChange={(event) => updateBrowserSetting("masterProfileDirectory", event.target.value)}
              placeholder="Leave blank to use Bridge's default browser profile"
              className="w-full rounded-md border border-border bg-bg-primary px-3 py-2 text-xs text-text-primary outline-none placeholder:text-text-faint focus:border-accent"
            />
          </Field>
        </div>

        <label className="flex items-start gap-3 rounded-md border border-border bg-bg-primary px-3 py-2">
          <input
            type="checkbox"
            checked={headedValue}
            onChange={(event) => updateBrowserHeaded(event.target.checked)}
            className="mt-0.5 h-3.5 w-3.5 accent-accent"
          />
          <span className="min-w-0">
            <span className="block text-xs font-medium text-text-secondary">
              Run browser operations headed
            </span>
            <span className="mt-0.5 block text-[11px] text-text-faint">
              Applies to web_search, browser_fetch, browser_exec, and browser session tools after saving.
            </span>
          </span>
        </label>

        <div className="grid gap-2 text-xs text-text-muted md:grid-cols-2">
          <div>
            <span className="text-text-faint">agent-browser:</span>{" "}
            <code className="text-text-secondary">
              {!diagnostics ? "checking" : diagnostics.agentBrowserInstalled ? "installed" : "missing"}
            </code>
          </div>
          <div>
            <span className="text-text-faint">binary:</span>{" "}
            <code className="text-text-secondary">{binaryState}</code>
          </div>
          <div>
            <span className="text-text-faint">profile:</span>{" "}
            <code className="text-text-secondary">{profileState}</code>
          </div>
          <div>
            <span className="text-text-faint">session:</span>{" "}
            <code className="text-text-secondary">{config?.sessionName ?? "checking"}</code>
          </div>
          <div>
            <span className="text-text-faint">mode:</span>{" "}
            <code className="text-text-secondary">
              {!config ? "checking" : config.headed ? "headed" : "not headed"}
            </code>
          </div>
        </div>

        {config && (
          <div className="rounded-md border border-border bg-bg-primary px-3 py-2 text-xs text-text-muted space-y-1">
            <div>
              <span className="text-text-faint">effective browser:</span>{" "}
              <code className="break-all text-text-secondary">{config.executablePath ?? "agent-browser auto-detect"}</code>
            </div>
            <div>
              <span className="text-text-faint">browser source:</span>{" "}
              <code className="text-text-secondary">{config.executablePathSource}</code>
            </div>
            <div>
              <span className="text-text-faint">effective profile:</span>{" "}
              <code className="break-all text-text-secondary">{config.masterProfileDirectory}</code>
            </div>
            <div>
              <span className="text-text-faint">effective mode:</span>{" "}
              <code className="text-text-secondary">{config.headed ? "headed" : "not headed"}</code>
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void launchHeaded()}
            disabled={launching || closing}
            className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent-hover disabled:cursor-wait disabled:bg-bg-surface disabled:text-text-faint"
          >
            {launching ? <Loader2 size={12} className="animate-spin" /> : <Monitor size={12} />}
            Launch headed browser
          </button>
          <button
            type="button"
            onClick={() => void closeHeaded()}
            disabled={launching || closing}
            className="inline-flex items-center gap-1.5 rounded-md bg-bg-surface px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-hover disabled:cursor-wait disabled:text-text-faint"
          >
            {closing ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />}
            Close headed browser
          </button>
          <span className="text-[11px] text-text-faint">
            Save browser edits first. These actions use the saved browser diagnostics settings.
          </span>
        </div>

        <div className="rounded-md border border-border bg-bg-primary px-3 py-3">
          <div className="flex items-center justify-between gap-3">
            <div className="text-xs font-medium text-text-secondary">Recent browser signals</div>
            <div className="text-[11px] text-text-faint">
              {diagnostics ? `Last ${diagnostics.windowHours}h, checked ${formatTimestamp(diagnostics.checkedAt)}` : "Checking..."}
            </div>
          </div>
          {diagnostics?.issues.length ? (
            <div className="mt-3 grid gap-2 lg:grid-cols-2">
              {diagnostics.issues.map((issue) => (
                <div key={issue.code} className="rounded-md border border-border bg-bg-elevated px-3 py-2">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="font-medium text-text-secondary">{issue.label}</span>
                    <span className="rounded-full bg-warning/15 px-2 py-0.5 text-[10px] font-medium text-warning">
                      {issue.count}
                    </span>
                  </div>
                  <div className="mt-1 text-[11px] text-text-faint">
                    Latest: {formatTimestamp(issue.latestAt)}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-2 text-xs text-text-muted">
              No recent browser challenge, recovery, or clone fallback telemetry was observed.
            </p>
          )}
        </div>

        {(message || error) && (
          <div className={`rounded-md border px-3 py-2 text-xs ${
            error
              ? "border-error/30 bg-error/10 text-error"
              : "border-success/25 bg-success/10 text-success"
          }`}>
            {error ?? message}
          </div>
        )}
      </div>
    </SettingsSection>
  );
}
