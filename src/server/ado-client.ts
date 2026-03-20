// ADO REST API client for enrichment data
// Fetches work item and PR metadata, with in-memory caching

import { execSync } from "node:child_process";

const ADO_ORG = "my-org";
const ADO_PROJECT = "MyProject";
const ADO_BASE = `https://dev.azure.com/${ADO_ORG}`;

// ── Types ─────────────────────────────────────────────────────────

export interface EnrichedWorkItem {
  id: number;
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
  title: string | null;
  status: "active" | "completed" | "abandoned" | null;
  createdBy: string | null;
  reviewerCount: number;
  url: string;
}

// ── Token cache ───────────────────────────────────────────────────

let cachedToken: { value: string; expiresAt: number } | null = null;

function getAccessToken(): string {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.value;
  }

  try {
    const result = execSync(
      'az account get-access-token --resource "499b84ac-1321-427f-aa17-267ca6975798" --query accessToken -o tsv',
      { encoding: "utf-8", timeout: 15_000 },
    ).trim();

    cachedToken = { value: result, expiresAt: Date.now() + 50 * 60_000 }; // ~50 min
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

const workItemCache = new Map<number, CacheEntry<EnrichedWorkItem>>();
const prCache = new Map<string, CacheEntry<EnrichedPR>>();
const CACHE_TTL = 60_000; // 60 seconds

// ── Work Items ────────────────────────────────────────────────────

export async function fetchWorkItems(ids: number[]): Promise<EnrichedWorkItem[]> {
  if (ids.length === 0) return [];

  const now = Date.now();
  const results: EnrichedWorkItem[] = [];
  const toFetch: number[] = [];

  // Check cache first
  for (const id of ids) {
    const cached = workItemCache.get(id);
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
        `${ADO_BASE}/${ADO_PROJECT}/_apis/wit/workitems?ids=${idList}&fields=${fields}&api-version=7.1`,
      );

      for (const item of data.value ?? []) {
        const f = item.fields ?? {};
        const enriched: EnrichedWorkItem = {
          id: item.id,
          title: f["System.Title"] ?? null,
          state: f["System.State"] ?? null,
          type: f["System.WorkItemType"] ?? null,
          assignedTo: f["System.AssignedTo"]?.displayName ?? null,
          areaPath: f["System.AreaPath"] ?? null,
          url: `https://${ADO_ORG}.visualstudio.com/${ADO_PROJECT}/_workitems/edit/${item.id}`,
        };
        workItemCache.set(item.id, { data: enriched, expiresAt: now + CACHE_TTL });
        results.push(enriched);
      }
    } catch (err) {
      console.error("[ado] Failed to fetch work items:", err);
      // Return bare stubs for items we couldn't fetch
      for (const id of toFetch) {
        results.push({
          id,
          title: null,
          state: null,
          type: null,
          assignedTo: null,
          areaPath: null,
          url: `https://${ADO_ORG}.visualstudio.com/${ADO_PROJECT}/_workitems/edit/${id}`,
        });
      }
    }
  }

  // Return in original order
  return ids.map((id) => results.find((r) => r.id === id)!);
}

// ── Pull Requests ─────────────────────────────────────────────────

export async function fetchPullRequests(
  prs: { repoId: string; repoName?: string; prId: number }[],
): Promise<EnrichedPR[]> {
  if (prs.length === 0) return [];

  const now = Date.now();
  const results: EnrichedPR[] = [];
  const toFetch: typeof prs = [];

  for (const pr of prs) {
    const key = `${pr.repoId}:${pr.prId}`;
    const cached = prCache.get(key);
    if (cached && now < cached.expiresAt) {
      results.push(cached.data);
    } else {
      toFetch.push(pr);
    }
  }

  // Fetch individually (no batch PR API)
  for (const pr of toFetch) {
    try {
      const data = await adoFetch(
        `${ADO_BASE}/${ADO_PROJECT}/_apis/git/repositories/${pr.repoId}/pullrequests/${pr.prId}?api-version=7.1`,
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
        title: data.title ?? null,
        status: statusMap[data.status?.toLowerCase()] ?? null,
        createdBy: data.createdBy?.displayName ?? null,
        reviewerCount: data.reviewers?.length ?? 0,
        url: `https://${ADO_ORG}.visualstudio.com/${ADO_PROJECT}/_git/${data.repository?.name ?? pr.repoId}/pullrequest/${pr.prId}`,
      };

      const key = `${pr.repoId}:${pr.prId}`;
      prCache.set(key, { data: enriched, expiresAt: now + CACHE_TTL });
      results.push(enriched);
    } catch (err) {
      console.error(`[ado] Failed to fetch PR ${pr.repoId}#${pr.prId}:`, err);
      results.push({
        repoId: pr.repoId,
        repoName: pr.repoName ?? null,
        prId: pr.prId,
        title: null,
        status: null,
        createdBy: null,
        reviewerCount: 0,
        url: `https://${ADO_ORG}.visualstudio.com/${ADO_PROJECT}/_git/${pr.repoName ?? pr.repoId}/pullrequest/${pr.prId}`,
      });
    }
  }

  // Return in original order
  return prs.map((pr) => {
    const key = `${pr.repoId}:${pr.prId}`;
    return results.find((r) => r.repoId === pr.repoId && r.prId === pr.prId)!;
  });
}
