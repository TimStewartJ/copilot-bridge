// Work tracking provider abstraction — types and interface
// Providers (ADO, GitHub, etc.) implement this to enrich work items and PRs

import type { PRRef } from "../task-store.js";
import type { WorkItemRelationType } from "../../shared/work-map.js";

// Re-export for convenience
export type { WorkItemRef, PRRef } from "../task-store.js";
export type { WorkItemRelationType } from "../../shared/work-map.js";

export type ProviderName = "ado" | "github" | "linear";

// ── Enriched types (returned by providers) ────────────────────────

export interface EnrichedWorkItem {
  id: string;
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

export interface WorkItemPullRequestLink {
  workItemId: string;
  repoId: string;
  prId: number;
}

export interface WorkItemRelation {
  workItemId: string;
  type: WorkItemRelationType;
  targetId: string;
}

/** The links work items report. Warnings name failures that a later refresh can clear. */
export interface WorkItemLinksResult {
  pullRequests: WorkItemPullRequestLink[];
  relations: WorkItemRelation[];
  warnings: string[];
}

/** The work items pull requests report. */
export interface PullRequestLinksResult {
  links: WorkItemPullRequestLink[];
  warnings: string[];
}

export interface WorkTrackingIdentity {
  displayName: string;
}

export interface AssignedWorkItemsResult {
  ids: string[];
  warnings: string[];
}

// ── Provider interface ────────────────────────────────────────────

export interface WorkTrackingProvider {
  readonly name: ProviderName;

  fetchWorkItems(ids: string[]): Promise<EnrichedWorkItem[]>;
  fetchPullRequests(prs: PRRef[]): Promise<EnrichedPR[]>;

  getWorkItemUrl(id: string): string;
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

export interface LinearProviderConfig {
  apiKey: string;
  workspace: string;
}

export interface ProvidersConfig {
  ado?: AdoProviderConfig;
  github?: GitHubProviderConfig;
  linear?: LinearProviderConfig;
}
