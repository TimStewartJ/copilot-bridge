import { useCallback, useEffect, useRef, useState } from "react";
import { Globe2, Loader2, Monitor, RotateCw, ShieldCheck, X } from "lucide-react";
import {
  ApiError,
  checkAdoBrowserAuthentication,
  closeHeadedDiagnosticsBrowser,
  fetchBrowserDiagnostics,
  launchHeadedDiagnosticsBrowser,
  probeBrowserContext,
  type AppSettings,
  type BrowserHeadedCloseFailureDetails,
  type BrowserSettings,
  type BrowserDiagnosticsResponse,
  type BrowserDiagnosticsTone,
} from "../../api";
import { SettingsSection } from "./SettingsSection";
import { DS, cx } from "../../design/tokens";
import { Badge, Button, Details, Field, FieldList, Notice, SettingList, SettingRow, Switch } from "../../design/primitives";
import { useSettingsWriter } from "../../hooks/queries/useSettings";
import { DraftTextField } from "./DraftTextField";

/** A healthy browser is ordinary, so it stays neutral; only trouble takes a colour. */
const SUMMARY_TONE: Record<BrowserDiagnosticsTone, "neutral" | "warning" | "danger"> = {
  success: "neutral",
  warning: "warning",
  error: "danger",
};

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
  refreshSignal = 0,
  open = false,
}: {
  draft: AppSettings;
  setDraft: (d: AppSettings) => void;
  refreshSignal?: number;
  open?: boolean;
}) {
  const { failedKeys, pendingKeys, error: writeError } = useSettingsWriter();
  const browserPending = pendingKeys.has("browser");
  const browserError = failedKeys.has("browser") ? writeError?.message : null;
  const [diagnostics, setDiagnostics] = useState<BrowserDiagnosticsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [launching, setLaunching] = useState(false);
  const [closing, setClosing] = useState(false);
  const [probing, setProbing] = useState<"public" | "authenticated" | null>(null);
  const [checkingAdo, setCheckingAdo] = useState(false);
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

  const firstSignal = useRef(refreshSignal);
  useEffect(() => {
    if (refreshSignal !== firstSignal.current) refresh();
  }, [refresh, refreshSignal]);

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

  const probeContext = async (context: "public" | "authenticated") => {
    setProbing(context);
    setMessage(null);
    setError(null);
    try {
      const result = await probeBrowserContext(context);
      setMessage(
        result.ok
          ? `${context === "public" ? "Public" : "Authenticated"} browser readiness passed.`
          : result.message ?? `${context} browser readiness failed.`,
      );
      refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setProbing(null);
    }
  };

  const checkAdo = async () => {
    setCheckingAdo(true);
    setMessage(null);
    setError(null);
    try {
      const result = await checkAdoBrowserAuthentication();
      setMessage(result.message ?? `Azure DevOps authentication is ${result.state}.`);
      refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setCheckingAdo(false);
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

  const publicContext = diagnostics?.contexts.public;
  const authContext = diagnostics?.contexts.authenticated;
  const adoState = authContext?.serviceChecks.find((check) => check.service === "ado")?.state ?? "unknown";
  const busyButton = (active: boolean) => active ? <Loader2 size={11} className="animate-spin" /> : null;

  return (
    <SettingsSection id="settings-system-browser" title="Browser">
      <SettingList>
        <SettingRow
          label="Browser runtime"
          hint={summary?.detail ?? (loading ? "Checking browser diagnostics…" : "Browser diagnostics are unavailable.")}
          control={summary ? <Badge tone={SUMMARY_TONE[summary.tone]}>{summary.label}</Badge> : undefined}
        />
        <SettingRow
          label={<span className="inline-flex items-center gap-1.5"><Globe2 size={13} className="text-text-secondary" />Public browser</span>}
          hint={publicContext
            ? `Disposable, for search and fetches · ${publicContext.state} · probe ${publicContext.functionalProbe.state}`
            : "Disposable and unauthenticated. Used by search and ordinary browser fetches."}
          control={(
            <Button size="sm" variant="ghost" onClick={() => void probeContext("public")} disabled={probing !== null}
              icon={busyButton(probing === "public") ?? <RotateCw size={11} />}>
              Check public browser
            </Button>
          )}
        />
        <SettingRow
          label={<span className="inline-flex items-center gap-1.5"><ShieldCheck size={13} className="text-text-secondary" />Authenticated browser</span>}
          hint={authContext
            ? `Signed-in profile · ${authContext.state} · probe ${authContext.functionalProbe.state} · ADO: ${adoState}`
            : "Dedicated signed-in profile. Authenticated operations are explicit and serialized."}
          control={(
            <>
              <Button size="sm" variant="ghost" onClick={() => void probeContext("authenticated")} disabled={probing !== null}
                icon={busyButton(probing === "authenticated") ?? <RotateCw size={11} />}>
                Check browser
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void checkAdo()} disabled={checkingAdo || probing !== null}
                icon={busyButton(checkingAdo) ?? <ShieldCheck size={11} />}>
                Verify ADO
              </Button>
            </>
          )}
        />
        <SettingRow
          label="Run authenticated browser headed"
          htmlFor="browser-headed"
          hint="Only the signed-in profile. Public browsing stays headless."
          control={<Switch id="browser-headed" checked={headedValue} onChange={(event) => updateBrowserHeaded(event.target.checked)} />}
        />
        <SettingRow
          label="Authenticated browser window"
          hint="Open the signed-in profile to sign in or pass a check by hand."
          control={(
            <>
              <Button size="sm" onClick={() => void launchHeaded()} disabled={launching || closing}
                icon={busyButton(launching) ?? <Monitor size={12} />}>
                Launch
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void closeHeaded()} disabled={launching || closing}
                icon={busyButton(closing) ?? <X size={12} />}>
                Close
              </Button>
            </>
          )}
        />
      </SettingList>

      {(message || error) && (
        error
          ? <Notice tone="danger" className="mt-3">{error}</Notice>
          : <p role="status" className={cx(DS.field.help, "mt-3")}>{message}</p>
      )}

      <div className="mt-3 space-y-1">
        <Details
          label="Recent browser signals"
          detail={diagnostics ? (diagnostics.issues.length ? `${diagnostics.issues.reduce((sum, issue) => sum + issue.count, 0)} in the last ${diagnostics.windowHours}h` : "None") : undefined}
        >
          <div className="pt-1">
            {diagnostics?.issues.length ? (
              <div className={DS.surface.divided}>
                {diagnostics.issues.map((issue) => (
                  <div key={issue.code} className="flex items-center justify-between gap-3 py-1.5 text-xs">
                    <span className="text-text-secondary">{issue.label}</span>
                    <span className="flex shrink-0 items-center gap-2">
                      <span className={DS.text.meta}>latest {formatTimestamp(issue.latestAt)}</span>
                      <Badge tone="warning">{issue.count}</Badge>
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className={DS.field.help}>No recent browser challenge, recovery, or readiness failure telemetry was observed.</p>
            )}
            {diagnostics && <p className={cx(DS.text.meta, "mt-1")}>Checked {formatTimestamp(diagnostics.checkedAt)}</p>}
          </div>
        </Details>

        <Details label="Paths and technical details" open={open || undefined}>
          <div className="space-y-3 pt-2">
            <DraftTextField
              storageKey="browser.executablePath"
              label="Browser executable path"
              value={executablePathValue}
              placeholder="Leave blank to use the environment override, or auto-detect Chrome"
              error={browserError}
              pending={browserPending}
              onCommit={(value) => updateBrowserSetting("executablePath", value)}
            />
            <DraftTextField
              storageKey="browser.masterProfileDirectory"
              label="Authenticated browser profile directory"
              value={masterProfileDirectoryValue}
              placeholder="Leave blank to use Bridge's dedicated authenticated profile"
              error={browserError}
              pending={browserPending}
              onCommit={(value) => updateBrowserSetting("masterProfileDirectory", value)}
            />
            <FieldList>
              <Field label="agent-browser" mono>{!diagnostics ? "checking" : diagnostics.agentBrowserInstalled ? "installed" : "missing"}</Field>
              <Field label="Binary" mono>{binaryState}</Field>
              <Field label="Effective browser" mono>{config ? (config.executablePath ?? "agent-browser auto-detect") : "checking"}</Field>
              <Field label="Browser source" mono>{config?.executablePathSource ?? "checking"}</Field>
              <Field label="Profile" mono>{profileState}</Field>
              <Field label="Authenticated profile" mono>{config?.masterProfileDirectory ?? authContext?.profilePath ?? "checking"}</Field>
              <Field label="Session" mono>{config?.sessionName ?? "checking"}</Field>
              <Field label="Mode" mono>{!config ? "checking" : config.headed ? "headed" : "not headed"}</Field>
              {diagnostics && (
                <>
                  <Field label="Transport" mono>{`${diagnostics.runtime.transport.kind} · ${diagnostics.runtime.transport.state} · ${diagnostics.runtime.transport.namespace}`}</Field>
                  <Field label="Last probe" mono>{formatTimestamp(diagnostics.runtime.transport.lastSuccessfulProbeAt)}</Field>
                  <Field label="Public queue" mono>{`${publicContext!.activeOperations} active / ${publicContext!.queueDepth} queued · limit ${publicContext!.concurrencyLimit}`}</Field>
                  <Field label="Public root" mono>{publicContext!.disposableProfileRoot}</Field>
                  <Field label="Authenticated queue" mono>{`${authContext!.activeOperations} active / ${authContext!.queueDepth} queued`}</Field>
                </>
              )}
            </FieldList>
          </div>
        </Details>
      </div>
    </SettingsSection>
  );
}
