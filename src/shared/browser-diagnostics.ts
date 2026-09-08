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
  disposableProfileRoot: string;
  concurrencyLimit: number;
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
  schemaVersion: 2;
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
