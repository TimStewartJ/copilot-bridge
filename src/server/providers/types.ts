// Work tracking provider abstraction — types and interface
// Providers (ADO, GitHub, etc.) implement this to enrich work items and PRs

import type { PRRef } from "../task-store.js";

// Re-export for convenience
export type { WorkItemRef, PRRef } from "../task-store.js";

export type ProviderName = "ado" | "github";

// ── Enriched types (returned by providers) ────────────────────────

export interface EnrichedWorkItem {
  id: number;
  provider: ProviderName;
  title: string | null;
  state: string | null;
  type: string | null;
  assignedTo: string | null;
  areaPath: string | null;
  url: string;
}

export interface EnrichedPR {
  repoId: string;
  repoName: string | null;
  prId: number;
  provider: ProviderName;
  title: string | null;
  status: "active" | "completed" | "abandoned" | null;
  createdBy: string | null;
  reviewerCount: number;
  url: string;
}

// ── Provider interface ────────────────────────────────────────────

export interface WorkTrackingProvider {
  readonly name: ProviderName;

  fetchWorkItems(ids: number[]): Promise<EnrichedWorkItem[]>;
  fetchPullRequests(prs: PRRef[]): Promise<EnrichedPR[]>;

  getWorkItemUrl(id: number): string;
  getPullRequestUrl(pr: PRRef): string;
}

// ── Provider config types ─────────────────────────────────────────

export interface AdoProviderConfig {
  org: string;
  project: string;
}

export interface GitHubProviderConfig {
  owner: string;
  defaultRepo?: string;
}

export interface ProvidersConfig {
  ado?: AdoProviderConfig;
  github?: GitHubProviderConfig;
}
