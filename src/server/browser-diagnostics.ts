import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { AppContext } from "./app-context.js";
import {
  ab,
  getEffectiveBrowserExecutablePath,
  getBridgeBrowserTarget,
  getBrowserLaunchConfig,
  isAgentBrowserInstalled,
  safeRecordBrowserSpan,
  shutdownBridgeBrowser,
  withBridgeBrowserSession,
} from "./agent-browser.js";
import type { TelemetrySpan } from "./telemetry-store.js";

const DIAGNOSTICS_WINDOW_HOURS = 24;
const DIAGNOSTICS_WINDOW_MS = DIAGNOSTICS_WINDOW_HOURS * 60 * 60 * 1000;
const MAX_DIAGNOSTIC_SPANS = 2_000;

export type BrowserDiagnosticsTone = "success" | "warning" | "error";

export interface BrowserDiagnosticsIssue {
  code: string;
  label: string;
  count: number;
  latestAt?: string;
}

export interface BrowserDiagnosticsSummary {
  tone: BrowserDiagnosticsTone;
  label: string;
  detail: string;
}

export interface BrowserDiagnosticsResponse {
  checkedAt: string;
  windowHours: number;
  summary: BrowserDiagnosticsSummary;
  agentBrowserInstalled: boolean;
  config: {
    sessionName: string;
    executablePath?: string;
    executablePathSource: "settings" | "environment" | "auto-detect";
    executablePathConfigured: boolean;
    executablePathExists?: boolean;
    masterProfileDirectory: string;
    masterProfileDirectoryConfigured: boolean;
    masterProfileDirectoryExists: boolean;
    headed: boolean;
  };
  issues: BrowserDiagnosticsIssue[];
}

export interface BrowserHeadedLaunchResponse {
  ok: true;
  url: string;
  sessionName: string;
  masterProfileDirectory: string;
  executablePath?: string;
  message: string;
}

export interface BrowserHeadedCloseResponse {
  ok: true;
  sessionName: string;
  masterProfileDirectory: string;
  executablePath?: string;
  message: string;
}

function getMetadataString(span: TelemetrySpan, key: string): string | undefined {
  const value = span.metadata?.[key];
  return typeof value === "string" ? value : undefined;
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
  googleCaptchaCount: number;
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

  const searchChallengeCount = input.googleCaptchaCount + input.duckDuckGoChallengeCount;
  if (searchChallengeCount > 0) {
    return {
      tone: "warning",
      label: "Search challenges detected",
      detail: `Bridge observed ${searchChallengeCount} web_search challenge event(s) in the last ${DIAGNOSTICS_WINDOW_HOURS} hours. Launch a headed browser with this profile when manual verification is needed.`,
    };
  }
  if (input.recoveryCount > 0) {
    return {
      tone: "warning",
      label: "Browser recovery used",
      detail: `Bridge recovered browser launch state ${input.recoveryCount} time(s) in the last ${DIAGNOSTICS_WINDOW_HOURS} hours.`,
    };
  }
  return {
    tone: "success",
    label: "Ready",
    detail: "No recent browser challenge or recovery events were observed.",
  };
}

export async function getBrowserDiagnostics(ctx: AppContext): Promise<BrowserDiagnosticsResponse> {
  const checkedAt = new Date().toISOString();
  const since = new Date(Date.now() - DIAGNOSTICS_WINDOW_MS).toISOString();
  const launchConfig = getBrowserLaunchConfig(ctx.settingsStore.getSettings());
  const target = getBridgeBrowserTarget(ctx.copilotHome, launchConfig);
  const effectiveExecutablePath = getEffectiveBrowserExecutablePath(launchConfig);
  const executablePathConfigured = effectiveExecutablePath.source !== "auto-detect";
  const masterProfileDirectoryConfigured = !!launchConfig.masterProfileDirectory;
  const executablePathExists = executablePathConfigured
    ? existsSync(effectiveExecutablePath.path!)
    : undefined;
  const masterProfileDirectoryExists = existsSync(target.profileDir);

  const googleCaptchaSpans = recentTelemetry(ctx, "browser.tool.web_search.google.failed", since)
    .filter((span) => getMetadataString(span, "failureCode") === "search.google_captcha");
  const duckDuckGoChallengeSpans = recentTelemetry(ctx, "browser.tool.web_search.duckduckgo.failed", since)
    .filter((span) => getMetadataString(span, "failureCode") === "search.ddg_challenge");
  const recoverySpans = recentTelemetry(ctx, "browser.recovery.detected", since);
  const cloneFallbackSpans = recentTelemetry(ctx, "browser.clone.fallback_to_primary", since);
  const issues = [
    toIssue("search.google_captcha", "Google CAPTCHA during web_search", googleCaptchaSpans),
    toIssue("search.ddg_challenge", "DuckDuckGo challenge during web_search", duckDuckGoChallengeSpans),
    toIssue("browser.recovery.detected", "Browser recovery path invoked", recoverySpans),
    toIssue("browser.clone.fallback_to_primary", "Clone lane fell back to primary", cloneFallbackSpans),
  ].filter((issue): issue is BrowserDiagnosticsIssue => issue !== null);

  const agentBrowserInstalled = await isAgentBrowserInstalled();
  return {
    checkedAt,
    windowHours: DIAGNOSTICS_WINDOW_HOURS,
    summary: describeDiagnosticsSummary({
      agentBrowserInstalled,
      executablePathConfigured,
      executablePathExists,
      googleCaptchaCount: googleCaptchaSpans.length,
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
    issues,
  };
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
  const headedTarget = {
    ...getBridgeBrowserTarget(ctx.copilotHome, launchConfig),
    headed: true,
  };
  const browserOpId = randomUUID();
  const startedAt = Date.now();
  let success = false;

  try {
    const result = await withBridgeBrowserSession(headedTarget, async () => {
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
  const headedTarget = {
    ...getBridgeBrowserTarget(ctx.copilotHome, launchConfig),
    headed: true,
  };
  const browserOpId = randomUUID();
  const startedAt = Date.now();
  let success = false;

  try {
    await shutdownBridgeBrowser(headedTarget, ctx.telemetryStore);
    success = true;
    return {
      ok: true,
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
    });
  }
}
