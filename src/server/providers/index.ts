// Provider registry — resolves providers by name, enriches items grouped by provider

import type { AppSettings } from "../settings-store.js";
import { AdoProvider, clearAdoProviderState } from "./ado.js";
import { GitHubProvider, clearGitHubProviderState } from "./github.js";
import { LinearProvider } from "./linear.js";
import { NullProvider } from "./null.js";
import type {
  WorkTrackingProvider,
  EnrichedWorkItem,
  EnrichedPR,
  ProviderName,
  WorkTrackingIdentity,
  AssignedWorkItemsResult,
  WorkItemPullRequestLinksResult,
} from "./types.js";
import type { WorkItemRef, PRRef } from "../task-store.js";

export type {
  WorkTrackingProvider,
  EnrichedWorkItem,
  EnrichedPR,
  ProviderName,
  WorkItemPullRequestLink,
  WorkItemPullRequestLinksResult,
  WorkTrackingIdentity,
  AssignedWorkItemsResult,
} from "./types.js";
export type { WorkItemRef, PRRef } from "../task-store.js";

// ── Settings getter (set by api-router after context is ready) ────

let _getSettings: (() => AppSettings) | null = null;

export function setSettingsGetter(fn: () => AppSettings): void {
  _getSettings = fn;
}

// ── Provider cache ────────────────────────────────────────────────

const providerCache = new Map<string, WorkTrackingProvider>();

/** Get a provider by name. Returns NullProvider if not configured. */
export function getProvider(name: ProviderName): WorkTrackingProvider {
  const cacheKey = name;
  const cached = providerCache.get(cacheKey);
  if (cached) return cached;

  const settings = _getSettings?.() ?? { mcpServers: {} };
  let provider: WorkTrackingProvider;

  switch (name) {
    case "ado": {
      const cfg = settings.providers?.ado;
      provider = cfg ? new AdoProvider(cfg) : new NullProvider("ado");
      break;
    }
    case "github": {
      // GitHub refs can be fully qualified ("owner/repo#123"), so enrichment works without
      // settings; config only supplies defaults for short refs like "123" or "repo#123".
      provider = new GitHubProvider(settings.providers?.github ?? { owner: "" });
      break;
    }
    case "linear": {
      const cfg = settings.providers?.linear;
      provider = cfg ? new LinearProvider(cfg) : new NullProvider("linear");
      break;
    }
    default:
      provider = new NullProvider(name);
  }

  providerCache.set(cacheKey, provider);
  return provider;
}

/** Clear cached providers (call when settings change). */
export function clearProviderCache(): void {
  providerCache.clear();
  clearAdoProviderState();
  clearGitHubProviderState();
}

// ── Batch enrichment — groups by provider, fetches in parallel ────

export async function enrichWorkItems(refs: WorkItemRef[]): Promise<EnrichedWorkItem[]> {
  if (refs.length === 0) return [];

  // Group by provider
  const groups = new Map<ProviderName, string[]>();
  for (const ref of refs) {
    const ids = groups.get(ref.provider) ?? [];
    ids.push(ref.id);
    groups.set(ref.provider, ids);
  }

  // Fetch from each provider in parallel
  const fetches = [...groups.entries()].map(async ([providerName, ids]) => {
    const provider = getProvider(providerName);
    try {
      return await provider.fetchWorkItems(ids);
    } catch (err) {
      console.error(`[providers] ${providerName} fetchWorkItems failed:`, err);
      // Fallback: return stubs with URLs from provider
      return ids.map((id) => ({
        id,
        provider: providerName,
        title: null,
        state: null,
        type: null,
        assignedTo: null,
        areaPath: null,
        url: provider.getWorkItemUrl(id),
      }));
    }
  });

  const results = (await Promise.all(fetches)).flat();

  // Return in original ref order
  return refs.map((ref) =>
    results.find((r) => r.id === ref.id && r.provider === ref.provider)!,
  );
}

export async function enrichPullRequests(refs: PRRef[]): Promise<EnrichedPR[]> {
  if (refs.length === 0) return [];

  // Group by provider
  const groups = new Map<ProviderName, PRRef[]>();
  for (const ref of refs) {
    const prs = groups.get(ref.provider) ?? [];
    prs.push(ref);
    groups.set(ref.provider, prs);
  }

  // Fetch from each provider in parallel
  const fetches = [...groups.entries()].map(async ([providerName, prs]) => {
    const provider = getProvider(providerName);
    try {
      return await provider.fetchPullRequests(prs);
    } catch (err) {
      console.error(`[providers] ${providerName} fetchPullRequests failed:`, err);
      return prs.map((pr) => ({
        repoId: pr.repoId,
        repoName: pr.repoName ?? null,
        prId: pr.prId,
        provider: providerName,
        title: null,
        status: null,
        createdBy: null,
        reviewerCount: 0,
        url: provider.getPullRequestUrl(pr),
      }));
    }
  });

  const results = (await Promise.all(fetches)).flat();

  return refs.map((ref) =>
    results.find((r) => r.repoId === ref.repoId && r.prId === ref.prId && r.provider === ref.provider)!,
  );
}

export async function fetchAdoWorkItemPullRequestLinks(
  workItemIds: string[],
  pullRequests: PRRef[],
): Promise<WorkItemPullRequestLinksResult> {
  const provider = getProvider("ado");
  if (!provider.fetchWorkItemPullRequestLinks) {
    return {
      links: [],
      warnings: ["ADO relationship discovery is unavailable."],
    };
  }
  try {
    return await provider.fetchWorkItemPullRequestLinks(workItemIds, pullRequests);
  } catch (err) {
    console.error("[providers] ADO work item pull request relationship discovery failed:", err);
    return {
      links: [],
      warnings: ["ADO relationships could not be loaded."],
    };
  }
}

export async function fetchAdoCurrentUser(): Promise<WorkTrackingIdentity | null> {
  const provider = getProvider("ado");
  if (!provider.fetchCurrentUser) return null;
  try {
    return await provider.fetchCurrentUser();
  } catch (err) {
    console.error("[providers] ADO authenticated user lookup failed:", err);
    return null;
  }
}

export async function fetchAdoAssignedWorkItemIds(): Promise<AssignedWorkItemsResult> {
  const provider = getProvider("ado");
  if (!provider.fetchAssignedWorkItemIds) {
    return {
      ids: [],
      warnings: ["Assigned ADO work discovery is unavailable."],
    };
  }
  try {
    return await provider.fetchAssignedWorkItemIds();
  } catch (err) {
    console.error("[providers] ADO assigned work item discovery failed:", err);
    return {
      ids: [],
      warnings: ["Assigned ADO work items could not be loaded."],
    };
  }
}
