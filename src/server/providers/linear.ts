// Linear provider — enriches work items via Linear's GraphQL API

import type { PRRef, EnrichedWorkItem, EnrichedPR, WorkTrackingProvider, LinearProviderConfig } from "./types.js";

// ── Enrichment cache ──────────────────────────────────────────────

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const issueCache = new Map<string, CacheEntry<EnrichedWorkItem>>();
const CACHE_TTL = 60_000;

// ── Provider ──────────────────────────────────────────────────────

export class LinearProvider implements WorkTrackingProvider {
  readonly name = "linear" as const;
  private readonly apiKey: string;
  private readonly workspace: string;

  constructor(config: LinearProviderConfig) {
    this.apiKey = config.apiKey;
    this.workspace = config.workspace;
  }

  getWorkItemUrl(id: string): string {
    return `https://linear.app/${this.workspace}/issue/${id}`;
  }

  getPullRequestUrl(_pr: PRRef): string {
    // Linear doesn't host PRs — it links to external Git providers
    return "#";
  }

  private async graphql(query: string, variables?: Record<string, unknown>): Promise<any> {
    const res = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: this.apiKey,
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) {
      throw new Error(`Linear API ${res.status}: ${res.statusText}`);
    }
    const json = await res.json();
    if (json.errors?.length) {
      throw new Error(`Linear GraphQL: ${json.errors[0].message}`);
    }
    return json.data;
  }

  async fetchWorkItems(ids: string[]): Promise<EnrichedWorkItem[]> {
    if (ids.length === 0) return [];

    const now = Date.now();
    const results: EnrichedWorkItem[] = [];
    const toFetch: string[] = [];

    for (const id of ids) {
      const cached = issueCache.get(id);
      if (cached && now < cached.expiresAt) {
        results.push(cached.data);
      } else {
        toFetch.push(id);
      }
    }

    // Fetch uncached issues individually (Linear's issue query takes a single ID)
    for (const id of toFetch) {
      try {
        const data = await this.graphql(`
          query Issue($id: String!) {
            issue(id: $id) {
              identifier
              title
              state { name }
              assignee { name }
              team { name }
            }
          }
        `, { id });

        const issue = data.issue;
        const enriched: EnrichedWorkItem = {
          id,
          provider: "linear",
          title: issue?.title ?? null,
          state: issue?.state?.name ?? null,
          type: null,
          assignedTo: issue?.assignee?.name ?? null,
          areaPath: issue?.team?.name ?? null,
          url: this.getWorkItemUrl(issue?.identifier ?? id),
        };
        issueCache.set(id, { data: enriched, expiresAt: now + CACHE_TTL });
        results.push(enriched);
      } catch (err) {
        console.error(`[linear] Failed to fetch issue ${id}:`, err);
        results.push({
          id,
          provider: "linear",
          title: null,
          state: null,
          type: null,
          assignedTo: null,
          areaPath: null,
          url: this.getWorkItemUrl(id),
        });
      }
    }

    return ids.map((id) => results.find((r) => r.id === id)!);
  }

  async fetchPullRequests(_prs: PRRef[]): Promise<EnrichedPR[]> {
    // Linear doesn't host PRs — return empty stubs
    return _prs.map((pr) => ({
      repoId: pr.repoId,
      repoName: pr.repoName ?? null,
      prId: pr.prId,
      provider: "linear" as const,
      title: null,
      status: null,
      createdBy: null,
      reviewerCount: 0,
      url: this.getPullRequestUrl(pr),
    }));
  }
}
