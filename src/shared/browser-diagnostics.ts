import type { BrowserLiveCheck } from "./browser-live.js";

export type BrowserDiagnosticsTone = "success" | "warning" | "error";
export type BrowserRuntimeState = "ready" | "starting" | "degraded" | "unavailable" | "stopped";
export type BrowserFunctionalProbeState = "passed" | "failed" | "not_run";
export type BrowserAuthCheckState = "verified" | "sign_in_required" | "unknown" | "failed";

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

export interface BrowserFunctionalProbe {
  state: BrowserFunctionalProbeState;
  checkedAt?: string;
  message?: string;
}

export interface BrowserContextRuntimeDiagnostics {
  state: BrowserRuntimeState;
  activeOperations: number;
  queueDepth: number;
  functionalProbe: BrowserFunctionalProbe;
}

export interface PublicBrowserDiagnostics extends BrowserContextRuntimeDiagnostics {
  context: "public";
  /** Folder holding the public profiles, which keep their cookies and cache between uses. */
  profileRoot: string;
  /** Profiles on disk, and how many of them a browser is using right now. */
  profiles: number;
  profilesInUse: number;
  concurrencyLimit: number;
}

export interface PublicBrowserResetResponse {
  ok: true;
  /** Profiles whose browsing data was removed. */
  cleared: number;
  /** Profiles left alone because a browser is using them. */
  inUse: number;
}

export interface AuthenticatedServiceCheck {
  service: "ado";
  state: BrowserAuthCheckState;
  checkedAt: string;
  url?: string;
  finalOrigin?: string;
  expectedOrigin?: string;
  message?: string;
}

export interface AuthenticatedBrowserDiagnostics extends BrowserContextRuntimeDiagnostics {
  context: "authenticated";
  profilePath: string;
  profileExists: boolean;
  headed: boolean;
  serviceChecks: AuthenticatedServiceCheck[];
}

/** Where the browser executable comes from. `auto-detect` leaves the choice to agent-browser. */
export type BrowserExecutableSource = "settings" | "environment" | "system" | "auto-detect";

export type BrowserBuildKind = "chrome" | "edge" | "chromium" | "chrome-for-testing" | "unknown";

export interface BrowserBuildDiagnostics {
  kind: BrowserBuildKind;
  /** What the executable reports as its version, such as "Google Chrome 154.0.8037.97". */
  version?: string;
  /** Days since the executable was installed or last updated. */
  installedDaysAgo?: number;
}

export interface BrowserLaunchDiagnostics {
  /** Every argument the browser is started with, the Bridge's own included. */
  args: string[];
  /** Where the arguments other than the Bridge's own come from. */
  inheritedFrom: "environment" | "agent-browser-config" | "none";
}

export interface BrowserRuntimeDiagnostics {
  agentBrowserInstalled: boolean;
  transport: {
    kind: "cli";
    state: BrowserRuntimeState;
    namespace: string;
    lastSuccessfulProbeAt?: string;
    lastFailureAt?: string;
  };
}

export interface BrowserDiagnosticsResponse {
  schemaVersion: 3;
  checkedAt: string;
  windowHours: number;
  summary: BrowserDiagnosticsSummary;
  agentBrowserInstalled: boolean;
  config: {
    sessionName: string;
    executablePath?: string;
    executablePathSource: BrowserExecutableSource;
    executablePathConfigured: boolean;
    executablePathExists?: boolean;
    masterProfileDirectory: string;
    masterProfileDirectoryConfigured: boolean;
    masterProfileDirectoryExists: boolean;
    headed: boolean;
    browser: BrowserBuildDiagnostics;
    launch: BrowserLaunchDiagnostics;
    agentBrowserVersion?: string;
    /** Whether a browser can be shown to the user to watch and act in. Absent until it was tried. */
    liveView?: BrowserLiveCheck;
  };
  runtime: BrowserRuntimeDiagnostics;
  contexts: {
    public: PublicBrowserDiagnostics;
    authenticated: AuthenticatedBrowserDiagnostics;
  };
  issues: BrowserDiagnosticsIssue[];
}

export interface BrowserProbeResponse {
  ok: boolean;
  context: "public" | "authenticated";
  state: BrowserRuntimeState;
  checkedAt?: string;
  message?: string;
}
