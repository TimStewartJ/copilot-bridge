// Provider registry — resolves providers by name, enriches items grouped by provider

import { getSettings } from "../settings-store.js";
import { AdoProvider } from "./ado.js";
import { GitHubProvider } from "./github.js";
import { NullProvider } from "./null.js";
import type { WorkTrackingProvider, EnrichedWorkItem, EnrichedPR, ProviderName } from "./types.js";
import type { WorkItemRef, PRRef } from "../task-store.js";

export type { WorkTrackingProvider, EnrichedWorkItem, EnrichedPR, ProviderName } from "./types.js";
export type { WorkItemRef, PRRef } from "../task-store.js";

// ── Provider cache ────────────────────────────────────────────────

const providerCache = new Map<string, WorkTrackingProvider>();

/** Get a provider by name. Returns NullProvider if not configured. */
export function getProvider(name: ProviderName): WorkTrackingProvider {
  const cacheKey = name;
  const cached = providerCache.get(cacheKey);
  if (cached) return cached;

  const settings = getSettings();
  let provider: WorkTrackingProvider;

  switch (name) {
    case "ado": {
      const cfg = settings.providers?.ado;
      provider = cfg ? new AdoProvider(cfg) : new NullProvider("ado");
      break;
    }
    case "github": {
      const cfg = settings.providers?.github;
      provider = cfg ? new GitHubProvider(cfg) : new NullProvider("github");
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
}

// ── Batch enrichment — groups by provider, fetches in parallel ────

export async function enrichWorkItems(refs: WorkItemRef[]): Promise<EnrichedWorkItem[]> {
  if (refs.length === 0) return [];

  // Group by provider
  const groups = new Map<ProviderName, number[]>();
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
