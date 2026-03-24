// Azure DevOps provider — enriches work items and PRs via ADO REST API

import { execSync } from "node:child_process";
import type { PRRef, EnrichedWorkItem, EnrichedPR, WorkTrackingProvider, AdoProviderConfig } from "./types.js";

// ── Token cache ───────────────────────────────────────────────────

let cachedToken: { value: string; expiresAt: number } | null = null;

function getAccessToken(): string {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.value;
  }

  try {
    const result = execSync(
      // 499b84ac-1321-427f-aa17-267ca6975798 is the well-known Azure DevOps public resource ID
      // (used by all az CLI / MSAL integrations — not a secret)
      'az account get-access-token --resource "499b84ac-1321-427f-aa17-267ca6975798" --query accessToken -o tsv',
      { encoding: "utf-8", timeout: 15_000 },
    ).trim();

    cachedToken = { value: result, expiresAt: Date.now() + 50 * 60_000 };
    return result;
  } catch (err) {
    console.error("[ado] Failed to get access token:", err);
    throw new Error("Could not obtain ADO access token");
  }
}

async function adoFetch(url: string): Promise<any> {
  const token = getAccessToken();
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`ADO API ${res.status}: ${res.statusText}`);
  }
  return res.json();
}

// ── Enrichment cache ──────────────────────────────────────────────

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const workItemCache = new Map<string, CacheEntry<EnrichedWorkItem>>();
const prCache = new Map<string, CacheEntry<EnrichedPR>>();
const CACHE_TTL = 60_000;

// ── Provider ──────────────────────────────────────────────────────

export class AdoProvider implements WorkTrackingProvider {
  readonly name = "ado" as const;
  private readonly org: string;
  private readonly project: string;
  private readonly baseUrl: string;

  constructor(config: AdoProviderConfig) {
    this.org = config.org;
    this.project = config.project;
    this.baseUrl = `https://dev.azure.com/${config.org}`;
  }

  getWorkItemUrl(id: number): string {
    return `https://${this.org}.visualstudio.com/${this.project}/_workitems/edit/${id}`;
  }

  getPullRequestUrl(pr: PRRef): string {
    return `https://${this.org}.visualstudio.com/${this.project}/_git/${pr.repoName ?? pr.repoId}/pullrequest/${pr.prId}`;
  }

  async fetchWorkItems(ids: number[]): Promise<EnrichedWorkItem[]> {
    if (ids.length === 0) return [];

    const now = Date.now();
    const results: EnrichedWorkItem[] = [];
    const toFetch: number[] = [];

    for (const id of ids) {
      const key = `${this.org}:${id}`;
      const cached = workItemCache.get(key);
      if (cached && now < cached.expiresAt) {
        results.push(cached.data);
      } else {
        toFetch.push(id);
      }
    }

    if (toFetch.length > 0) {
      try {
        const idList = toFetch.join(",");
        const fields = "System.Title,System.State,System.WorkItemType,System.AssignedTo,System.AreaPath";
        const data = await adoFetch(
          `${this.baseUrl}/${this.project}/_apis/wit/workitems?ids=${idList}&fields=${fields}&api-version=7.1`,
        );

        for (const item of data.value ?? []) {
          const f = item.fields ?? {};
          const enriched: EnrichedWorkItem = {
            id: item.id,
            provider: "ado",
            title: f["System.Title"] ?? null,
            state: f["System.State"] ?? null,
            type: f["System.WorkItemType"] ?? null,
            assignedTo: f["System.AssignedTo"]?.displayName ?? null,
            areaPath: f["System.AreaPath"] ?? null,
            url: this.getWorkItemUrl(item.id),
          };
          const key = `${this.org}:${item.id}`;
          workItemCache.set(key, { data: enriched, expiresAt: now + CACHE_TTL });
          results.push(enriched);
        }
      } catch (err) {
        console.error("[ado] Failed to fetch work items:", err);
        for (const id of toFetch) {
          results.push({
            id,
            provider: "ado",
            title: null,
            state: null,
            type: null,
            assignedTo: null,
            areaPath: null,
            url: this.getWorkItemUrl(id),
          });
        }
      }
    }

    return ids.map((id) => results.find((r) => r.id === id)!);
  }

  async fetchPullRequests(prs: PRRef[]): Promise<EnrichedPR[]> {
    if (prs.length === 0) return [];

    const now = Date.now();
    const results: EnrichedPR[] = [];
    const toFetch: PRRef[] = [];

    for (const pr of prs) {
      const key = `${this.org}:${pr.repoId}:${pr.prId}`;
      const cached = prCache.get(key);
      if (cached && now < cached.expiresAt) {
        results.push(cached.data);
      } else {
        toFetch.push(pr);
      }
    }

    for (const pr of toFetch) {
      try {
        const data = await adoFetch(
          `${this.baseUrl}/${this.project}/_apis/git/repositories/${pr.repoId}/pullrequests/${pr.prId}?api-version=7.1`,
        );

        const statusMap: Record<string, EnrichedPR["status"]> = {
          active: "active",
          completed: "completed",
          abandoned: "abandoned",
        };

        const enriched: EnrichedPR = {
          repoId: pr.repoId,
          repoName: data.repository?.name ?? pr.repoName ?? null,
          prId: pr.prId,
          provider: "ado",
          title: data.title ?? null,
          status: statusMap[data.status?.toLowerCase()] ?? null,
          createdBy: data.createdBy?.displayName ?? null,
          reviewerCount: data.reviewers?.length ?? 0,
          url: this.getPullRequestUrl({ ...pr, repoName: data.repository?.name ?? pr.repoName }),
        };

        const key = `${this.org}:${pr.repoId}:${pr.prId}`;
        prCache.set(key, { data: enriched, expiresAt: now + CACHE_TTL });
        results.push(enriched);
      } catch (err) {
        console.error(`[ado] Failed to fetch PR ${pr.repoId}#${pr.prId}:`, err);
        results.push({
          repoId: pr.repoId,
          repoName: pr.repoName ?? null,
          prId: pr.prId,
          provider: "ado",
          title: null,
          status: null,
          createdBy: null,
          reviewerCount: 0,
          url: this.getPullRequestUrl(pr),
        });
      }
    }

    return prs.map((pr) => results.find((r) => r.repoId === pr.repoId && r.prId === pr.prId)!);
  }
}
