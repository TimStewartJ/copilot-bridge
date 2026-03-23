// Null provider — fallback when a provider isn't configured
// Returns ID-only stubs with no enrichment

import type { PRRef, EnrichedWorkItem, EnrichedPR, WorkTrackingProvider, ProviderName } from "./types.js";

export class NullProvider implements WorkTrackingProvider {
  readonly name: ProviderName;

  constructor(name: ProviderName) {
    this.name = name;
  }

  async fetchWorkItems(ids: number[]): Promise<EnrichedWorkItem[]> {
    return ids.map((id) => ({
      id,
      provider: this.name,
      title: null,
      state: null,
      type: null,
      assignedTo: null,
      areaPath: null,
      url: this.getWorkItemUrl(id),
    }));
  }

  async fetchPullRequests(prs: PRRef[]): Promise<EnrichedPR[]> {
    return prs.map((pr) => ({
      repoId: pr.repoId,
      repoName: pr.repoName ?? null,
      prId: pr.prId,
      provider: this.name,
      title: null,
      status: null,
      createdBy: null,
      reviewerCount: 0,
      url: this.getPullRequestUrl(pr),
    }));
  }

  getWorkItemUrl(_id: number): string {
    return "#";
  }

  getPullRequestUrl(_pr: PRRef): string {
    return "#";
  }
}
