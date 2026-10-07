import { useCallback, useEffect, useRef, useState } from "react";
import { Globe2, Loader2, Monitor, RotateCw, ShieldCheck, Trash2, X } from "lucide-react";
import {
  ApiError,
  checkAdoBrowserAuthentication,
  closeHeadedDiagnosticsBrowser,
  fetchBrowserDiagnostics,
  fetchBrowserLogins,
  launchHeadedDiagnosticsBrowser,
  probeBrowserContext,
  removeBrowserLogin,
  requestSignedInBrowserLiveTicket,
  resetPublicBrowserData,
  type AppSettings,
  type BrowserBuildDiagnostics,
  type BrowserBuildKind,
  type BrowserExecutableSource,
  type BrowserHeadedCloseFailureDetails,
  type BrowserLaunchDiagnostics,
  type BrowserSavedLogin,
  type BrowserSettings,
  type BrowserDiagnosticsResponse,
  type BrowserDiagnosticsTone,
} from "../../api";
import { BrowserLiveDialog } from "../../browser-live/BrowserLiveDialog";
import { MIN_AGENT_BROWSER_VERSION, isAgentBrowserOutdated } from "../../../shared/browser-diagnostics.js";
import { SettingsSection } from "./SettingsSection";
import { DS, cx } from "../../design/tokens";
import { Badge, Button, Details, Field, FieldList, Notice, SettingList, SettingRow, StatusIcon, Switch } from "../../design/primitives";
import { useSettingsWriter } from "../../hooks/queries/useSettings";
import { DraftTextField } from "./DraftTextField";

/** A healthy browser is ordinary, so it stays neutral; only trouble takes a colour. */
const SUMMARY_TONE: Record<BrowserDiagnosticsTone, "neutral" | "warning" | "danger"> = {
  success: "neutral",
  warning: "warning",
  error: "danger",
};

const BROWSER_KIND_LABEL: Record<BrowserBuildKind, string> = {
  chrome: "Google Chrome",
  edge: "Microsoft Edge",
  chromium: "Chromium",
  "chrome-for-testing": "Chrome for Testing",
  unknown: "Unknown browser",
};

const EXECUTABLE_SOURCE_LABEL: Record<BrowserExecutableSource, string> = {
  settings: "set in Settings",
  environment: "set by the environment",
  system: "found on this machine",
  "auto-detect": "chosen by agent-browser",
};

const LAUNCH_INHERITED_LABEL: Record<BrowserLaunchDiagnostics["inheritedFrom"], string> = {
  environment: "Arguments other than the Bridge's own come from the environment.",
  "agent-browser-config": "Arguments other than the Bridge's own come from agent-browser's config file.",
  none: "Only the Bridge's own arguments are used.",
};

/** Sites treat these builds as automation, and a browser this many days old as suspect. */
const AUTOMATION_BUILDS: ReadonlySet<BrowserBuildKind> = new Set(["chrome-for-testing", "chromium"]);
const STALE_BROWSER_DAYS = 60;

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

/** "Google Chrome 154.0.8037.97": the kind in plain words, then the number the executable reports. */
function describeBrowserBuild(browser: BrowserBuildDiagnostics): string {
  if (browser.kind === "unknown") return browser.version ?? BROWSER_KIND_LABEL.unknown;
  const number = browser.version?.match(/\d+(?:\.\d+)+/)?.[0];
  return number ? `${BROWSER_KIND_LABEL[browser.kind]} ${number}` : BROWSER_KIND_LABEL[browser.kind];
}

function describeBrowserAge(days: number | undefined): string | undefined {
  if (days === undefined) return undefined;
  return days <= 0 ? "updated today" : `updated ${count(days, "day")} ago`;
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
  const [logins, setLogins] = useState<BrowserSavedLogin[]>([]);
  const [removingLogin, setRemovingLogin] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [launching, setLaunching] = useState(false);
  const [signedInBrowserOpen, setSignedInBrowserOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [probing, setProbing] = useState<"public" | "authenticated" | null>(null);
  const [checkingAdo, setCheckingAdo] = useState(false);
  const [clearingPublic, setClearingPublic] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const refresh = useCallback(() => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setLoading(true);
    setError(null);
    // The list is a convenience beside the diagnostics; when it cannot be read, it stays as it was.
    void fetchBrowserLogins().then((value) => {
      if (requestIdRef.current === requestId) setLogins(value);
    }, () => undefined);
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

  const removeLogin = async (login: BrowserSavedLogin) => {
    setRemovingLogin(login.id);
    setMessage(null);
    setError(null);
    try {
      await removeBrowserLogin(login.id);
      setLogins((current) => current.filter((other) => other.id !== login.id));
      setMessage(`The login for ${login.host} was removed.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRemovingLogin(null);
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

  const clearPublicData = async () => {
    setClearingPublic(true);
    setMessage(null);
    setError(null);
    try {
      const result = await resetPublicBrowserData();
      const left = result.inUse > 0 ? `; ${result.inUse} in use ${result.inUse === 1 ? "was" : "were"} left alone` : "";
      setMessage(`Cleared ${count(result.cleared, "profile")}${left}.`);
      refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setClearingPublic(false);
    }
  };

  const config = diagnostics?.config;
  const summary = diagnostics?.summary;
  const executablePathValue = draft.browser?.executablePath ?? "";
  const masterProfileDirectoryValue = draft.browser?.masterProfileDirectory ?? "";
  const headedValue = draft.browser?.headed === true;
  const binaryState = !config
    ? "checking"
    : config.executablePathExists
      ? "found"
      : config.executablePathConfigured
        ? "missing"
        : "auto-detect";
  const profileState = !config
    ? "checking"
    : config.masterProfileDirectoryExists
      ? "present"
      : "not created yet";

  const publicContext = diagnostics?.contexts.public;
  const authContext = diagnostics?.contexts.authenticated;
  const adoState = authContext?.serviceChecks.find((check) => check.service === "ado")?.state ?? "unknown";
  const browserBuild = config?.browser;
  const browserFacts = config && browserBuild
    ? [describeBrowserBuild(browserBuild), EXECUTABLE_SOURCE_LABEL[config.executablePathSource], describeBrowserAge(browserBuild.installedDaysAgo)]
      .filter(Boolean).join(" · ")
    : undefined;
  const browserIsAutomationBuild = browserBuild !== undefined && AUTOMATION_BUILDS.has(browserBuild.kind);
  const browserStaleDays = browserBuild?.installedDaysAgo !== undefined && browserBuild.installedDaysAgo > STALE_BROWSER_DAYS
    ? browserBuild.installedDaysAgo
    : undefined;
  const warningIcon = <StatusIcon kind="warning" decorative />;
  const liveViewFails = config?.liveView !== undefined && !config.liveView.ok;
  const agentBrowserOutdated = config?.agentBrowserVersion !== undefined && isAgentBrowserOutdated(config.agentBrowserVersion);
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
          label="Browser in use"
          hint={browserFacts ?? (loading ? "Checking which browser runs…" : "Unknown.")}
        >
          {(browserIsAutomationBuild || browserStaleDays !== undefined) && (
            <div className="space-y-2">
              {browserIsAutomationBuild && (
                <Notice tone="warning" icon={warningIcon}>
                  Sites can tell this build from regular Chrome. Install Google Chrome for fewer blocks.
                </Notice>
              )}
              {browserStaleDays !== undefined && (
                <Notice tone="warning" icon={warningIcon}>
                  This browser has not been updated for {browserStaleDays} days; sites distrust old versions.
                </Notice>
              )}
            </div>
          )}
        </SettingRow>
        <SettingRow
          label="Live view"
          hint="Watch a browser an agent is using, and take over when a site needs you. Checking the public browser tests it."
          control={config ? (
            <Badge tone={liveViewFails || agentBrowserOutdated ? "warning" : "neutral"}>
              {liveViewFails
                ? "Not working"
                : agentBrowserOutdated ? "Needs an update" : config.liveView ? "Working" : "Not checked yet"}
            </Badge>
          ) : undefined}
        >
          {liveViewFails && (
            <Notice tone="warning" icon={warningIcon}>
              {config.liveView?.message ?? "The browser could not be shown."} If agent-browser was updated recently, the
              update may have changed how it shows a browser; otherwise update it:
              <code className={cx(DS.text.literal, "mt-1 block")}>npm install -g agent-browser@latest</code>
            </Notice>
          )}
          {agentBrowserOutdated && !liveViewFails && (
            // An old agent-browser shows a page and passes the check, so nothing else says this.
            <Notice tone="warning" icon={warningIcon}>
              agent-browser {config?.agentBrowserVersion} is older than the Bridge needs ({MIN_AGENT_BROWSER_VERSION} or
              newer). With it, a window that a page opens, such as a sign-in popup, does not show in the view. Update it:
              <code className={cx(DS.text.literal, "mt-1 block")}>npm install -g agent-browser@latest</code>
            </Notice>
          )}
        </SettingRow>
        <SettingRow
          label={<span className="inline-flex items-center gap-1.5"><Globe2 size={13} className="text-text-secondary" />Public browser</span>}
          hint={publicContext
            ? `Not signed in, for search and fetches · ${publicContext.state} · probe ${publicContext.functionalProbe.state}`
            : "Not signed in. Used by search and ordinary browser fetches."}
          control={(
            <Button size="sm" variant="ghost" onClick={() => void probeContext("public")} disabled={probing !== null}
              icon={busyButton(probing === "public") ?? <RotateCw size={11} />}>
              Check public browser
            </Button>
          )}
        />
        <SettingRow
          label="Public browsing data"
          hint={publicContext
            ? `${count(publicContext.profiles, "profile")}, ${publicContext.profilesInUse} in use. Public profiles keep cookies between uses.`
            : "Public profiles keep cookies between uses."}
          control={(
            <Button size="sm" variant="ghost" onClick={() => void clearPublicData()} disabled={clearingPublic}
              icon={busyButton(clearingPublic) ?? <Trash2 size={11} />}>
              Clear public browsing data
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
          label="Run browsers with a window"
          htmlFor="browser-headed"
          hint="Applies to public and signed-in browsers. Sites can tell a browser without a window; a window needs a display (on a Linux server, Xvfb)."
          control={<Switch id="browser-headed" checked={headedValue} onChange={(event) => updateBrowserHeaded(event.target.checked)} />}
        />
        <SettingRow
          label="Sign in to sites"
          hint="Open the signed-in browser here, from any device, to sign in or pass a check by hand. Agents wait for it while you have it open."
          control={(
            <Button size="sm" onClick={() => setSignedInBrowserOpen(true)} disabled={launching || closing}
              icon={<Globe2 size={12} />}>
              Open
            </Button>
          )}
        />
        <SettingRow
          label="Saved logins"
          hint={logins.length > 0
            ? "Agents use these to sign in again when a site has signed them out. They never see the password."
            : "None yet. When you sign in to a site in a browser view, it offers to keep the login for agents."}
        >
          {logins.length > 0 && (
            <ul className={DS.surface.divided}>
              {logins.map((login) => (
                <li key={login.id} className="flex min-w-0 items-center gap-3 py-1.5">
                  <div className="min-w-0 flex-1">
                    <div className={cx(DS.setting.label, "truncate")}>{login.host}</div>
                    <div className={cx(DS.setting.hint, "truncate")}>
                      {login.failed ? `${login.username} · not accepted last time; sign in by hand to save it again` : login.username}
                    </div>
                  </div>
                  <Button size="sm" variant="ghost" disabled={removingLogin !== null} onClick={() => void removeLogin(login)}
                    icon={busyButton(removingLogin === login.id) ?? <Trash2 size={12} />}>
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </SettingRow>
        <SettingRow
          label="Signed-in browser on the server"
          hint="For someone at the machine the Bridge runs on: open its window there, or close the browser."
          control={(
            <>
              <Button size="sm" variant="ghost" onClick={() => void launchHeaded()} disabled={launching || closing}
                icon={busyButton(launching) ?? <Monitor size={12} />}>
                Open window
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void closeHeaded()} disabled={launching || closing}
                icon={busyButton(closing) ?? <X size={12} />}>
                Close browser
              </Button>
            </>
          )}
        />
      </SettingList>

      {signedInBrowserOpen && (
        <BrowserLiveDialog
          browserSessionId="signed-in-browser"
          title="Signed-in browser"
          reason="Sign in to the sites agents should reach. A login is kept for agents only if you save it."
          requestTicket={requestSignedInBrowserLiveTicket}
          onClose={() => {
            setSignedInBrowserOpen(false);
            refresh();
          }}
        />
      )}

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

        <Details
          label="Launch arguments"
          detail={config ? count(config.launch.args.length, "argument") : undefined}
        >
          <div className="space-y-1.5 pt-1">
            {config && <p className={DS.field.help}>{LAUNCH_INHERITED_LABEL[config.launch.inheritedFrom]}</p>}
            {config?.launch.args.length ? (
              <ul className="space-y-0.5">
                {config.launch.args.map((arg, index) => (
                  <li key={`${index}-${arg}`} className={cx(DS.text.literal, "break-all")}>{arg}</li>
                ))}
              </ul>
            ) : (
              config && <p className={DS.field.help}>The browser starts with no extra arguments.</p>
            )}
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
              <Field label="agent-browser" mono>
                {!diagnostics
                  ? "checking"
                  : !diagnostics.agentBrowserInstalled
                    ? "missing"
                    : config?.agentBrowserVersion ? `installed · ${config.agentBrowserVersion}` : "installed"}
              </Field>
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
                  <Field label="Public profiles" mono>{publicContext!.profileRoot}</Field>
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
