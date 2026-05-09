import { API_BASE } from "./api";

export type UpdateChannel = "stable" | "preview";
export type UpdateCheckStatus =
  | "disabled"
  | "not_configured"
  | "error"
  | "up_to_date"
  | "update_available";

export interface CurrentUpdateInfo {
  version: string;
  channel: string;
  platform: string;
  sourceCommit?: string;
  distributionMode: string;
}

export interface UpdatePackageInfo {
  name: string;
  url: string;
  sha256: string;
  sizeBytes: number;
}

export interface UpdateManifest {
  schemaVersion: 1;
  appId: "copilot-bridge";
  keyId?: string;
  version: string;
  channel: UpdateChannel;
  platform: string;
  sourceCommit: string;
  publishedAt: string;
  releaseUrl?: string;
  releaseNotesUrl?: string;
  package: UpdatePackageInfo;
}

export interface UpdateCheckResponse {
  status: UpdateCheckStatus;
  configured: boolean;
  enabled: boolean;
  channel: UpdateChannel;
  manifestUrl?: string;
  signatureUrl?: string;
  current: CurrentUpdateInfo;
  update?: UpdateManifest;
  checkedAt: string;
  error?: string;
}

export type UpdateInstallPhase =
  | "started"
  | "downloading"
  | "verifying"
  | "staging"
  | "stopping"
  | "installing"
  | "starting"
  | "succeeded"
  | "failed";

export interface UpdateInstallStatus {
  id: string;
  phase: UpdateInstallPhase;
  channel: UpdateChannel;
  fromVersion: string;
  toVersion: string;
  sourceCommit?: string;
  packageUrl: string;
  packageSha256: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: string;
  rollbackAttempted?: boolean;
  logPath?: string;
}

export interface UpdateInstallStatusResponse {
  status: UpdateInstallStatus | null;
}

export interface UpdateInstallStartResponse {
  status: "started";
  install: UpdateInstallStatus;
}

export async function fetchUpdateStatus(channel?: UpdateChannel): Promise<UpdateCheckResponse> {
  const qs = channel ? `?channel=${encodeURIComponent(channel)}` : "";
  const res = await fetch(`${API_BASE}/api/updates/check${qs}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

export async function fetchUpdateInstallStatus(): Promise<UpdateInstallStatusResponse> {
  const res = await fetch(`${API_BASE}/api/updates/install-status`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

export async function installUpdate(channel: UpdateChannel): Promise<UpdateInstallStartResponse> {
  const res = await fetch(`${API_BASE}/api/updates/install`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channel }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}
