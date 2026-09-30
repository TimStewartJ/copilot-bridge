// Work tracking provider abstraction — types and interface
// Providers (ADO, GitHub, etc.) implement this to enrich work items and PRs

import type { PRRef } from "../task-store.js";

// Re-export for convenience
export type { WorkItemRef, PRRef } from "../task-store.js";

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

/**
 * A link between two work items, as the source item reports it. Parent/child come from the ADO
 * hierarchy; predecessor/successor from dependency links; duplicate names the item that duplicates
 * this one and duplicateOf the item this one duplicates.
 */
export type WorkItemRelationType =
  | "parent"
  | "child"
  | "related"
  | "predecessor"
  | "successor"
  | "duplicate"
  | "duplicateOf";

export interface WorkItemRelation {
  workItemId: string;
  type: WorkItemRelationType;
  targetId: string;
}

export interface WorkItemPullRequestLinksResult {
  links: WorkItemPullRequestLink[];
  /** Work item to work item links of the requested work items, when the provider reports them. */
  workItemRelations?: WorkItemRelation[];
  warnings: string[];
}

export interface WorkItemRelationsResult {
  relations: WorkItemRelation[];
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
  fetchWorkItemPullRequestLinks?(
    workItemIds: string[],
    pullRequests: PRRef[],
  ): Promise<WorkItemPullRequestLinksResult>;
  fetchWorkItemRelations?(workItemIds: string[]): Promise<WorkItemRelationsResult>;
  fetchCurrentUser?(): Promise<WorkTrackingIdentity | null>;
  fetchAssignedWorkItemIds?(): Promise<AssignedWorkItemsResult>;

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
