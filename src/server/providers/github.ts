// GitHub provider — stub implementation with correct URLs but no API enrichment
// Real API enrichment (via gh CLI or GITHUB_TOKEN) is a future addition

import type { PRRef, EnrichedWorkItem, EnrichedPR, WorkTrackingProvider, GitHubProviderConfig } from "./types.js";

export class GitHubProvider implements WorkTrackingProvider {
  readonly name = "github" as const;
  private readonly owner: string;
  private readonly defaultRepo?: string;

  constructor(config: GitHubProviderConfig) {
    this.owner = config.owner;
    this.defaultRepo = config.defaultRepo;
  }

  getWorkItemUrl(id: number): string {
    // GitHub issues need a repo — use defaultRepo or "#"
    if (this.defaultRepo) {
      return `https://github.com/${this.owner}/${this.defaultRepo}/issues/${id}`;
    }
    return `https://github.com/${this.owner}`;
  }

  getPullRequestUrl(pr: PRRef): string {
    // repoId for GitHub PRs is "owner/repo" or just "repo"
    const repo = pr.repoId.includes("/") ? pr.repoId : `${this.owner}/${pr.repoId}`;
    return `https://github.com/${repo}/pull/${pr.prId}`;
  }

  async fetchWorkItems(ids: number[]): Promise<EnrichedWorkItem[]> {
    // Stub — returns items with correct URLs but no metadata
    return ids.map((id) => ({
      id,
      provider: "github" as const,
      title: null,
      state: null,
      type: null,
      assignedTo: null,
      areaPath: null,
      url: this.getWorkItemUrl(id),
    }));
  }

  async fetchPullRequests(prs: PRRef[]): Promise<EnrichedPR[]> {
    // Stub — returns PRs with correct URLs but no metadata
    return prs.map((pr) => ({
      repoId: pr.repoId,
      repoName: pr.repoName ?? null,
      prId: pr.prId,
      provider: "github" as const,
      title: null,
      status: null,
      createdBy: null,
      reviewerCount: 0,
      url: this.getPullRequestUrl(pr),
    }));
  }
}
