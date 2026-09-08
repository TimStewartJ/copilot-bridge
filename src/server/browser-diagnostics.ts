import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type {
  AuthenticatedServiceCheck,
  BrowserContextRuntimeDiagnostics,
  BrowserDiagnosticsIssue,
  BrowserDiagnosticsResponse,
  BrowserDiagnosticsSummary,
  BrowserFunctionalProbe,
  BrowserProbeResponse,
  BrowserRuntimeState,
} from "../shared/browser-diagnostics.js";
import type { AppContext } from "./app-context.js";
import {
  ab,
  getEffectiveBrowserExecutablePath,
  getBrowserLaunchConfig,
  isAgentBrowserInstalled,
  safeRecordBrowserSpan,
  type BrowserShutdownResult,
} from "./agent-browser.js";
import {
  getOrCreateBrowserBroker,
  type BrowserBroker,
  type BrowserBrokerLease,
  type BrowserContext,
  type BrowserContextHealth,
} from "./browser-broker.js";
import type { TelemetrySpan } from "./telemetry-store.js";

export type {
  BrowserDiagnosticsIssue,
  BrowserDiagnosticsResponse,
  BrowserDiagnosticsSummary,
} from "../shared/browser-diagnostics.js";

const DIAGNOSTICS_WINDOW_HOURS = 24;
const DIAGNOSTICS_WINDOW_MS = DIAGNOSTICS_WINDOW_HOURS * 60 * 60 * 1000;
const MAX_DIAGNOSTIC_SPANS = 2_000;

export interface BrowserHeadedLaunchResponse {
  ok: true;
  context?: "authenticated";
  url: string;
  sessionName: string;
  masterProfileDirectory: string;
  executablePath?: string;
  message: string;
}

export interface BrowserHeadedCloseResponse {
  ok: true;
  context?: "authenticated";
  sessionName: string;
  masterProfileDirectory: string;
  executablePath?: string;
  message: string;
}

export interface BrowserHeadedCloseFailureDetails {
  failureCode?: BrowserShutdownResult["failureCode"];
  outputSummary?: string;
  closeFailureCode?: BrowserShutdownResult["closeFailureCode"];
  closeOutputSummary?: string;
  terminatedPids: number[];
  killedPids: number[];
  remainingPids: number[];
  clearedRuntimeFiles: number;
}

export class BrowserHeadedCloseError extends Error {
  readonly details: BrowserHeadedCloseFailureDetails;

  constructor(readonly shutdown: BrowserShutdownResult) {
    super(describeBrowserShutdownFailure(shutdown));
    this.name = "BrowserHeadedCloseError";
    this.details = browserHeadedCloseFailureDetails(shutdown);
  }
}

function browserHeadedCloseFailureDetails(shutdown: BrowserShutdownResult): BrowserHeadedCloseFailureDetails {
  return {
    ...(shutdown.failureCode ? { failureCode: shutdown.failureCode } : {}),
    ...(shutdown.outputSummary ? { outputSummary: shutdown.outputSummary } : {}),
    ...(shutdown.closeFailureCode ? { closeFailureCode: shutdown.closeFailureCode } : {}),
    ...(shutdown.closeOutputSummary ? { closeOutputSummary: shutdown.closeOutputSummary } : {}),
    terminatedPids: shutdown.terminatedPids,
    killedPids: shutdown.killedPids,
    remainingPids: shutdown.remainingPids,
    clearedRuntimeFiles: shutdown.clearedRuntimeFiles,
  };
}

function describeBrowserShutdownFailure(shutdown: BrowserShutdownResult): string {
  const details: string[] = [];
  if (shutdown.remainingPids.length > 0) {
    details.push(`remaining profile-bound browser process PIDs: ${shutdown.remainingPids.join(", ")}`);
  }
  if (!shutdown.closeOk) {
    const code = shutdown.closeFailureCode ?? "unknown";
    const output = shutdown.closeOutputSummary ? `: ${shutdown.closeOutputSummary}` : "";
    details.push(`agent-browser close failed (${code})${output}`);
  }
  if (details.length === 0 && shutdown.outputSummary) details.push(shutdown.outputSummary);
  const suffix = details.length > 0 ? ` ${details.join("; ")}.` : "";
  return `Headed browser close did not leave the browser profile clean.${suffix}`;
}

function getMetadataString(span: TelemetrySpan, key: string): string | undefined {
  const value = span.metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

function getMetadataBoolean(span: TelemetrySpan, key: string): boolean | undefined {
  const value = span.metadata?.[key];
  return typeof value === "boolean" ? value : undefined;
}

function latestAt(spans: readonly TelemetrySpan[]): string | undefined {
  return spans[0]?.createdAt;
}

function toIssue(code: string, label: string, spans: readonly TelemetrySpan[]): BrowserDiagnosticsIssue | null {
  if (spans.length === 0) return null;
  return {
    code,
    label,
    count: spans.length,
    ...(latestAt(spans) ? { latestAt: latestAt(spans) } : {}),
  };
}

function recentTelemetry(
  ctx: AppContext,
  name: string,
  since: string,
): TelemetrySpan[] {
  return ctx.telemetryStore?.querySpans({
    name,
    since,
    source: "server",
    limit: MAX_DIAGNOSTIC_SPANS,
  }) ?? [];
}

function describeDiagnosticsSummary(input: {
  agentBrowserInstalled: boolean;
  executablePathConfigured: boolean;
  executablePathExists?: boolean;
  runtimeState: BrowserRuntimeState;
  signInRequired: boolean;
  authCheckFailed: boolean;
  googleCaptchaCount: number;
  bingCaptchaCount: number;
  duckDuckGoChallengeCount: number;
  recoveryCount: number;
}): BrowserDiagnosticsSummary {
  if (!input.agentBrowserInstalled) {
    return {
      tone: "error",
      label: "agent-browser missing",
      detail: "Bridge cannot run browser tools until agent-browser is installed.",
    };
  }
  if (input.executablePathConfigured && input.executablePathExists === false) {
    return {
      tone: "error",
      label: "Browser binary missing",
      detail: "The configured browser executable path does not exist on this machine.",
    };
  }
  if (input.runtimeState === "unavailable") {
    return {
      tone: "error",
      label: "Browser unavailable",
      detail: "A functional browser readiness check failed. Review the context details and retry the probe.",
    };
  }
  if (input.runtimeState === "degraded") {
    return {
      tone: "warning",
      label: "Browser degraded",
      detail: "A recent browser operation failed after startup. Public and authenticated context details are shown below.",
    };
  }
  if (input.runtimeState === "starting") {
    return {
      tone: "warning",
      label: "Browser starting",
      detail: "A browser context is still completing its functional readiness handshake.",
    };
  }
  if (input.signInRequired) {
    return {
      tone: "warning",
      label: "Sign-in required",
      detail: "The authenticated browser is operational, but at least one configured service requires sign-in.",
    };
  }
  if (input.authCheckFailed) {
    return {
      tone: "warning",
      label: "Authentication check failed",
      detail: "The browser is operational, but an authenticated service check returned an unexpected result.",
    };
  }

  const searchChallengeCount = input.googleCaptchaCount + input.bingCaptchaCount + input.duckDuckGoChallengeCount;
  if (searchChallengeCount > 0) {
    return {
      tone: "warning",
      label: "Search challenges detected",
      detail: `Bridge observed ${searchChallengeCount} browser_web_search challenge event(s) in the last ${DIAGNOSTICS_WINDOW_HOURS} hours. Launch a headed browser with this profile when manual verification is needed.`,
    };
  }
  if (input.recoveryCount > 0) {
    return {
      tone: "warning",
      label: "Browser recovery used",
      detail: `Bridge recovered browser launch state ${input.recoveryCount} time(s) in the last ${DIAGNOSTICS_WINDOW_HOURS} hours.`,
    };
  }
  if (input.runtimeState === "stopped") {
    return {
      tone: "warning",
      label: "Functional check required",
      detail: "Browser configuration is present, but no successful functional context probe has been recorded.",
    };
  }
  return {
    tone: "success",
    label: "Ready",
    detail: "Public and authenticated browser contexts have passed functional readiness checks.",
  };
}

function getBrowserBroker(ctx: AppContext): BrowserBroker {
  return getOrCreateBrowserBroker(ctx, {
    copilotHome: ctx.copilotHome,
    telemetryStore: ctx.telemetryStore,
    getBrowserLaunchConfig: () => getBrowserLaunchConfig(ctx.settingsStore.getSettings()),
  });
}

function toFunctionalProbe(health: BrowserContextHealth): BrowserFunctionalProbe {
  if (health.lastProbeAt && health.status === "ready") {
    return {
      state: "passed",
      checkedAt: health.lastProbeAt,
    };
  }
  if (health.lastProbeAt && (health.status === "degraded" || health.status === "unavailable")) {
    return {
      state: "failed",
      checkedAt: health.lastProbeAt,
      ...(health.lastError ? { message: health.lastError } : {}),
    };
  }
  return { state: "not_run" };
}

function toContextRuntime(health: BrowserContextHealth): BrowserContextRuntimeDiagnostics {
  return {
    state: health.status,
    activeOperations: health.activeOperations,
    queueDepth: health.queuedOperations,
    functionalProbe: toFunctionalProbe(health),
  };
}

function combineRuntimeState(
  publicState: BrowserRuntimeState,
  authenticatedState: BrowserRuntimeState,
): BrowserRuntimeState {
  const states = [publicState, authenticatedState];
  if (states.includes("unavailable")) return "unavailable";
  if (states.includes("degraded")) return "degraded";
  if (states.includes("starting")) return "starting";
  if (states.every((state) => state === "ready")) return "ready";
  return "stopped";
}

export async function getBrowserDiagnostics(ctx: AppContext): Promise<BrowserDiagnosticsResponse> {
  const checkedAt = new Date().toISOString();
  const since = new Date(Date.now() - DIAGNOSTICS_WINDOW_MS).toISOString();
  const launchConfig = getBrowserLaunchConfig(ctx.settingsStore.getSettings());
  const broker = getBrowserBroker(ctx);
  const brokerSnapshot = broker.getSnapshot();
  const target = broker.getAuthenticatedTarget();
  const effectiveExecutablePath = getEffectiveBrowserExecutablePath(launchConfig);
  const executablePathConfigured = effectiveExecutablePath.source !== "auto-detect";
  const masterProfileDirectoryConfigured = !!launchConfig.masterProfileDirectory;
  const executablePathExists = executablePathConfigured
    ? existsSync(effectiveExecutablePath.path!)
    : undefined;
  const masterProfileDirectoryExists = existsSync(target.profileDir);

  const googleCaptchaSpans = recentTelemetry(ctx, "browser.tool.browser_web_search.google.failed", since)
    .filter((span) => getMetadataString(span, "failureCode") === "search.google_captcha");
  const bingCaptchaSpans = recentTelemetry(ctx, "browser.tool.browser_web_search.bing.failed", since)
    .filter((span) => getMetadataString(span, "failureCode") === "search.bing_captcha");
  const duckDuckGoChallengeSpans = recentTelemetry(ctx, "browser.tool.browser_web_search.duckduckgo.failed", since)
    .filter((span) => getMetadataString(span, "failureCode") === "search.ddg_challenge");
  const recoverySpans = recentTelemetry(ctx, "browser.recovery.detected", since);
  const readinessFailureSpans = recentTelemetry(ctx, "browser.broker.readiness", since)
    .filter((span) => getMetadataBoolean(span, "success") === false);
  const issues = [
    toIssue("search.google_captcha", "Google CAPTCHA during browser_web_search", googleCaptchaSpans),
    toIssue("search.bing_captcha", "Bing CAPTCHA during browser_web_search", bingCaptchaSpans),
    toIssue("search.ddg_challenge", "DuckDuckGo challenge during browser_web_search", duckDuckGoChallengeSpans),
    toIssue("browser.recovery.detected", "Browser recovery path invoked", recoverySpans),
    toIssue("browser.broker.readiness.failed", "Browser context readiness failed", readinessFailureSpans),
  ].filter((issue): issue is BrowserDiagnosticsIssue => issue !== null);

  const agentBrowserInstalled = await isAgentBrowserInstalled();
  const runtimeState = agentBrowserInstalled
    ? combineRuntimeState(brokerSnapshot.public.status, brokerSnapshot.authenticated.status)
    : "unavailable";
  const lastSuccessfulProbeAt = [
    brokerSnapshot.public.lastSuccessAt,
    brokerSnapshot.authenticated.lastSuccessAt,
  ].filter((value): value is string => !!value).sort().at(-1);
  const lastFailureAt = [
    brokerSnapshot.public.lastFailureAt,
    brokerSnapshot.authenticated.lastFailureAt,
  ].filter((value): value is string => !!value).sort().at(-1);
  const authenticatedServiceChecks = broker.getAuthenticatedServiceChecks();
  return {
    schemaVersion: 2,
    checkedAt,
    windowHours: DIAGNOSTICS_WINDOW_HOURS,
    summary: describeDiagnosticsSummary({
      agentBrowserInstalled,
      executablePathConfigured,
      executablePathExists,
      runtimeState,
      signInRequired: authenticatedServiceChecks.some((check) => check.state === "sign_in_required"),
      authCheckFailed: authenticatedServiceChecks.some((check) => check.state === "failed"),
      googleCaptchaCount: googleCaptchaSpans.length,
      bingCaptchaCount: bingCaptchaSpans.length,
      duckDuckGoChallengeCount: duckDuckGoChallengeSpans.length,
      recoveryCount: recoverySpans.length,
    }),
    agentBrowserInstalled,
    config: {
      sessionName: target.sessionName,
      executablePath: effectiveExecutablePath.path,
      executablePathSource: effectiveExecutablePath.source,
      executablePathConfigured,
      executablePathExists,
      masterProfileDirectory: target.profileDir,
      masterProfileDirectoryConfigured,
      masterProfileDirectoryExists,
      headed: target.headed === true,
    },
    runtime: {
      agentBrowserInstalled,
      transport: {
        kind: "cli",
        state: runtimeState,
        namespace: brokerSnapshot.namespace,
        ...(lastSuccessfulProbeAt ? { lastSuccessfulProbeAt } : {}),
        ...(lastFailureAt ? { lastFailureAt } : {}),
      },
    },
    contexts: {
      public: {
        context: "public",
        ...toContextRuntime(brokerSnapshot.public),
        disposableProfileRoot: brokerSnapshot.public.profileRoot,
        concurrencyLimit: brokerSnapshot.public.maxConcurrency,
      },
      authenticated: {
        context: "authenticated",
        ...toContextRuntime(brokerSnapshot.authenticated),
        profilePath: brokerSnapshot.authenticated.profileDirectory,
        profileExists: masterProfileDirectoryExists,
        headed: brokerSnapshot.authenticated.headed,
        serviceChecks: authenticatedServiceChecks,
      },
    },
    issues,
  };
}

export async function probeBrowserContext(
  ctx: AppContext,
  contextValue: unknown,
): Promise<BrowserProbeResponse> {
  if (contextValue !== "public" && contextValue !== "authenticated") {
    throw new Error("context must be public or authenticated");
  }
  if (!await isAgentBrowserInstalled()) {
    throw new Error("agent-browser is not installed.");
  }
  const context: BrowserContext = contextValue;
  const health = await getBrowserBroker(ctx).probe(context);
  return {
    ok: health.status === "ready",
    context,
    state: health.status,
    ...(health.lastProbeAt ? { checkedAt: health.lastProbeAt } : {}),
    ...(health.lastError ? { message: health.lastError } : {}),
  };
}

export async function checkAdoBrowserAuthentication(
  ctx: AppContext,
): Promise<AuthenticatedServiceCheck> {
  if (!await isAgentBrowserInstalled()) {
    throw new Error("agent-browser is not installed.");
  }
  const ado = ctx.settingsStore.getSettings().providers?.ado;
  if (!ado?.org || !ado.project) {
    throw new Error("Azure DevOps provider settings are required before authentication can be checked.");
  }

  const expectedOrigin = `https://${ado.org}.visualstudio.com`;
  const url = `${expectedOrigin}/${encodeURIComponent(ado.project)}/_workitems/assignedtome/`;
  const broker = getBrowserBroker(ctx);
  const browserOpId = randomUUID();
  const result = await broker.withEphemeralContext("authenticated", {
    toolName: "browser_diagnostics_check_ado_auth",
    browserOpId,
    metadata: {
      browserContext: "authenticated",
      service: "ado",
    },
  }, async (lease: BrowserBrokerLease) => {
    const commandOptions = {
      browserTarget: lease.browserTarget,
      telemetryStore: ctx.telemetryStore,
      toolName: "browser_diagnostics_check_ado_auth",
      browserOpId,
      metadata: {
        browserContext: "authenticated",
        service: "ado",
      },
    };
    const open = await ab(["open", url], 45_000, commandOptions);
    if (!open.ok) throw new Error(`Failed to open Azure DevOps: ${open.output.slice(0, 200)}`);
    let finalUrl = "";
    let title = "";
    for (let attempt = 0; attempt < 10; attempt++) {
      const urlResult = await ab(["get", "url"], 30_000, commandOptions);
      const titleResult = await ab(["get", "title"], 30_000, commandOptions);
      if (!urlResult.ok) throw new Error(`Failed to read Azure DevOps URL: ${urlResult.output.slice(0, 200)}`);
      if (!titleResult.ok) throw new Error(`Failed to read Azure DevOps title: ${titleResult.output.slice(0, 200)}`);
      finalUrl = urlResult.output.trim();
      title = titleResult.output.trim();
      const parsed = new URL(finalUrl);
      if (parsed.origin === expectedOrigin) {
        if (/\bboards\b|\bwork items\b/i.test(title)) break;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        continue;
      }
      if (
        !parsed.hostname.toLowerCase().includes("login.microsoftonline.com")
        && !/working|sign in|log in/i.test(title)
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    return { finalUrl, title };
  });

  const checkedAt = new Date().toISOString();
  const parsedFinalUrl = new URL(result.finalUrl);
  const expected = new URL(expectedOrigin);
  const loginHost = parsedFinalUrl.hostname.toLowerCase().includes("login.microsoftonline.com");
  const titleIndicatesLogin = /\bsign in\b|\blog in\b/i.test(result.title);
  let check: AuthenticatedServiceCheck;
  if (loginHost || titleIndicatesLogin) {
    check = {
      service: "ado",
      state: "sign_in_required",
      checkedAt,
      url,
      finalOrigin: parsedFinalUrl.origin,
      expectedOrigin,
      message: "Azure DevOps redirected to a sign-in experience.",
    };
  } else if (parsedFinalUrl.origin === expected.origin && /\bboards\b|\bwork items\b/i.test(result.title)) {
    check = {
      service: "ado",
      state: "verified",
      checkedAt,
      url,
      finalOrigin: parsedFinalUrl.origin,
      expectedOrigin,
      message: `Authenticated Azure DevOps page verified: ${result.title}`,
    };
  } else {
    check = {
      service: "ado",
      state: "failed",
      checkedAt,
      url,
      finalOrigin: parsedFinalUrl.origin,
      expectedOrigin,
      message: `Unexpected Azure DevOps result: ${result.title || result.finalUrl}`,
    };
  }
  broker.recordAuthenticatedServiceCheck(check);
  return check;
}

function normalizeHeadedLaunchUrl(value: unknown): string {
  if (value === undefined || value === null || value === "") return "about:blank";
  if (typeof value !== "string") throw new Error("url must be a string");
  const trimmed = value.trim();
  if (!trimmed || trimmed === "about:blank") return "about:blank";
  const parsed = new URL(trimmed);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("url must use http, https, or about:blank");
  }
  return parsed.toString();
}

export async function launchHeadedDiagnosticsBrowser(
  ctx: AppContext,
  urlValue?: unknown,
): Promise<BrowserHeadedLaunchResponse> {
  if (!await isAgentBrowserInstalled()) {
    throw new Error("agent-browser is not installed.");
  }

  const url = normalizeHeadedLaunchUrl(urlValue);
  const launchConfig = getBrowserLaunchConfig(ctx.settingsStore.getSettings());
  const effectiveExecutablePath = getEffectiveBrowserExecutablePath(launchConfig);
  const broker = getBrowserBroker(ctx);
  const headedTarget = {
    ...broker.getAuthenticatedTarget(),
    headed: true,
  };
  const browserOpId = randomUUID();
  const startedAt = Date.now();
  let success = false;

  try {
    const result = await broker.withTarget({
      context: "authenticated",
      browserTarget: headedTarget,
    }, {
      toolName: "browser_diagnostics_launch_headed",
      browserOpId,
      skipReadiness: true,
      metadata: {
        browserContext: "authenticated",
        headed: true,
      },
    }, async () => {
      return ab(["open", url], 30_000, {
        browserTarget: headedTarget,
        telemetryStore: ctx.telemetryStore,
        toolName: "browser_diagnostics_launch_headed",
        browserOpId,
        metadata: {
          headed: true,
        },
      });
    });
    if (!result.ok) {
      throw new Error(`Headed browser launch failed: ${result.output.slice(0, 200)}`);
    }
    success = true;
    return {
      ok: true,
      context: "authenticated",
      url,
      sessionName: headedTarget.sessionName,
      masterProfileDirectory: headedTarget.profileDir,
      executablePath: effectiveExecutablePath.path,
      message: "Headed browser launch requested with the saved browser diagnostics configuration.",
    };
  } finally {
    safeRecordBrowserSpan(ctx.telemetryStore, "browser.tool.browser_diagnostics_launch_headed", Date.now() - startedAt, {
      browserOpId,
      browserSession: headedTarget.sessionName,
      success,
      headed: true,
    });
  }
}

export async function closeHeadedDiagnosticsBrowser(
  ctx: AppContext,
): Promise<BrowserHeadedCloseResponse> {
  if (!await isAgentBrowserInstalled()) {
    throw new Error("agent-browser is not installed.");
  }

  const launchConfig = getBrowserLaunchConfig(ctx.settingsStore.getSettings());
  const effectiveExecutablePath = getEffectiveBrowserExecutablePath(launchConfig);
  const broker = getBrowserBroker(ctx);
  const headedTarget = { ...broker.getAuthenticatedTarget(), headed: true };
  const browserOpId = randomUUID();
  const startedAt = Date.now();
  let success = false;
  let shutdownResult: BrowserShutdownResult | undefined;

  try {
    shutdownResult = await broker.shutdownAuthenticated(true);
    if (!shutdownResult.ok) {
      throw new BrowserHeadedCloseError(shutdownResult);
    }
    success = true;
    return {
      ok: true,
      context: "authenticated",
      sessionName: headedTarget.sessionName,
      masterProfileDirectory: headedTarget.profileDir,
      executablePath: effectiveExecutablePath.path,
      message: "Headed browser close requested. Verified browser state is ready for future browser tool runs.",
    };
  } finally {
    safeRecordBrowserSpan(ctx.telemetryStore, "browser.tool.browser_diagnostics_close_headed", Date.now() - startedAt, {
      browserOpId,
      browserSession: headedTarget.sessionName,
      success,
      headed: true,
      failureCode: shutdownResult?.failureCode,
      closeFailureCode: shutdownResult?.closeFailureCode,
      remainingPids: shutdownResult?.remainingPids,
    });
  }
}
