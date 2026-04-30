// Azure DevOps provider — enriches work items and PRs via ADO REST API

import { execSync } from "node:child_process";
import type { PRRef, EnrichedWorkItem, EnrichedPR, WorkTrackingProvider, AdoProviderConfig } from "./types.js";

// ── Token cache ───────────────────────────────────────────────────

let cachedToken: { value: string; expiresAt: number } | null = null;
const TOKEN_REFRESH_BUFFER_MS = 60_000;
const TOKEN_CACHE_TTL = 50 * 60_000;
const TOKEN_FETCH_TIMEOUT_MS = 30_000;
const TOKEN_FETCH_ATTEMPTS = 2;

class AdoRequestError extends Error {
  readonly transient: boolean;

  constructor(message: string, transient: boolean) {
    super(message);
    this.name = "AdoRequestError";
    this.transient = transient;
  }
}

function isTokenTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  return code === "ETIMEDOUT" || /timed? ?out/i.test(err.message);
}

function fetchAccessTokenOnce(): string {
  const result = execSync(
    // 499b84ac-1321-427f-aa17-267ca6975798 is the well-known Azure DevOps public resource ID
    // (used by all az CLI / MSAL integrations — not a secret)
    'az account get-access-token --resource "499b84ac-1321-427f-aa17-267ca6975798" --query accessToken -o tsv',
    { encoding: "utf-8", timeout: TOKEN_FETCH_TIMEOUT_MS },
  ).trim();
  if (!result) {
    throw new Error("ADO access token command returned empty result");
  }
  return result;
}

function getAccessToken(): string {
  if (cachedToken && Date.now() < cachedToken.expiresAt - TOKEN_REFRESH_BUFFER_MS) {
    return cachedToken.value;
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= TOKEN_FETCH_ATTEMPTS; attempt++) {
    try {
      const result = fetchAccessTokenOnce();
      cachedToken = { value: result, expiresAt: Date.now() + TOKEN_CACHE_TTL };
      return result;
    } catch (err) {
      lastError = err;
      const shouldRetry = attempt < TOKEN_FETCH_ATTEMPTS && isTokenTimeoutError(err);
      console.error(`[ado] Failed to get access token${shouldRetry ? " (retrying once)" : ""}:`, err);
      if (!shouldRetry) {
        break;
      }
    }
  }

  throw new AdoRequestError("Could not obtain ADO access token", isTokenTimeoutError(lastError));
}

function responseSnippet(body: string): string {
  const compact = body.replace(/\s+/g, " ").trim();
  return compact.slice(0, 200);
}

function describeResponse(contentType: string, body: string): string {
  const parts = [`content-type: ${contentType || "unknown"}`];
  const snippet = responseSnippet(body);
  if (snippet) {
    parts.push(`body starts with ${JSON.stringify(snippet)}`);
  }
  return parts.join(", ");
}

function isHtmlResponse(contentType: string, body: string): boolean {
  const normalizedType = contentType.toLowerCase();
  const normalizedBody = body.trimStart().slice(0, 64).toLowerCase();
  return normalizedType.includes("text/html")
    || normalizedBody.startsWith("<!doctype")
    || normalizedBody.startsWith("<html");
}

async function adoFetch(url: string): Promise<any> {
  const token = getAccessToken();
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });
  const contentType = res.headers.get("content-type") ?? "";
  const body = await res.text();
  if (!res.ok) {
    const transient = res.status === 408 || res.status === 429 || res.status >= 500;
    throw new AdoRequestError(
      `ADO API ${res.status}: ${res.statusText} (${describeResponse(contentType, body)})`,
      transient,
    );
  }
  if (isHtmlResponse(contentType, body)) {
    throw new AdoRequestError(
      `ADO API returned HTML instead of JSON (${describeResponse(contentType, body)})`,
      true,
    );
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new AdoRequestError(
      `ADO API returned invalid JSON (${describeResponse(contentType, body)})`,
      true,
    );
  }
}

// ── Enrichment cache ──────────────────────────────────────────────

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
  staleUntil: number;
}

const workItemCache = new Map<string, CacheEntry<EnrichedWorkItem>>();
const prCache = new Map<string, CacheEntry<EnrichedPR>>();
const CACHE_TTL = 60_000;
const STALE_CACHE_TTL = 24 * 60 * 60_000;

function shouldUseStaleFallback(err: unknown): boolean {
  if (err instanceof AdoRequestError) return err.transient;
  return err instanceof TypeError;
}

export function clearAdoProviderState(): void {
  cachedToken = null;
  workItemCache.clear();
  prCache.clear();
}

function readCachedValue<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
  now: number,
  allowStale = false,
): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (now < entry.expiresAt) return entry.data;
  if (allowStale && now < entry.staleUntil) return entry.data;
  return null;
}

function writeCachedValue<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
  data: T,
  now: number,
): void {
  cache.set(key, {
    data,
    expiresAt: now + CACHE_TTL,
    staleUntil: now + STALE_CACHE_TTL,
  });
}

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

  getWorkItemUrl(id: string): string {
    return `https://${this.org}.visualstudio.com/${this.project}/_workitems/edit/${id}`;
  }

  getPullRequestUrl(pr: PRRef): string {
    return `https://${this.org}.visualstudio.com/${this.project}/_git/${pr.repoName ?? pr.repoId}/pullrequest/${pr.prId}`;
  }

  private workItemCacheKey(id: string): string {
    return `${this.org}:${id}`;
  }

  private prCacheKey(pr: Pick<PRRef, "repoId" | "prId">): string {
    return `${this.org}:${pr.repoId}:${pr.prId}`;
  }

  private getCachedWorkItem(id: string, now: number, allowStale = false): EnrichedWorkItem | null {
    return readCachedValue(workItemCache, this.workItemCacheKey(id), now, allowStale);
  }

  private getCachedPR(pr: PRRef, now: number, allowStale = false): EnrichedPR | null {
    return readCachedValue(prCache, this.prCacheKey(pr), now, allowStale);
  }

  private cacheWorkItem(item: EnrichedWorkItem, now: number): void {
    writeCachedValue(workItemCache, this.workItemCacheKey(item.id), item, now);
  }

  private cachePR(pr: EnrichedPR, now: number): void {
    writeCachedValue(prCache, this.prCacheKey(pr), pr, now);
  }

  private buildWorkItemFallback(id: string): EnrichedWorkItem {
    return {
      id,
      provider: "ado",
      title: null,
      state: null,
      type: null,
      assignedTo: null,
      areaPath: null,
      url: this.getWorkItemUrl(id),
    };
  }

  private buildPRFallback(pr: PRRef): EnrichedPR {
    return {
      repoId: pr.repoId,
      repoName: pr.repoName ?? null,
      prId: pr.prId,
      provider: "ado",
      title: null,
      status: null,
      createdBy: null,
      reviewerCount: 0,
      url: this.getPullRequestUrl(pr),
    };
  }

  async fetchWorkItems(ids: string[]): Promise<EnrichedWorkItem[]> {
    if (ids.length === 0) return [];

    const now = Date.now();
    const resultMap = new Map<string, EnrichedWorkItem>();
    const toFetch: string[] = [];

    for (const id of ids) {
      const cached = this.getCachedWorkItem(id, now);
      if (cached) {
        resultMap.set(id, cached);
      } else {
        toFetch.push(id);
      }
    }

    if (toFetch.length > 0) {
      let fetchError: unknown = null;
      try {
        const idList = toFetch.join(",");
        const fields = "System.Title,System.State,System.WorkItemType,System.AssignedTo,System.AreaPath";
        const data = await adoFetch(
          `${this.baseUrl}/${this.project}/_apis/wit/workitems?ids=${idList}&fields=${fields}&api-version=7.1`,
        );

        for (const item of data.value ?? []) {
          const f = item.fields ?? {};
          const enriched: EnrichedWorkItem = {
            id: String(item.id),
            provider: "ado",
            title: f["System.Title"] ?? null,
            state: f["System.State"] ?? null,
            type: f["System.WorkItemType"] ?? null,
            assignedTo: f["System.AssignedTo"]?.displayName ?? null,
            areaPath: f["System.AreaPath"] ?? null,
            url: this.getWorkItemUrl(String(item.id)),
          };
          this.cacheWorkItem(enriched, now);
          resultMap.set(enriched.id, enriched);
        }
      } catch (err) {
        fetchError = err;
        console.error("[ado] Failed to fetch work items:", err);
      }

      for (const id of toFetch) {
        if (resultMap.has(id)) continue;
        const fallback = shouldUseStaleFallback(fetchError)
          ? this.getCachedWorkItem(id, now, true) ?? this.buildWorkItemFallback(id)
          : this.buildWorkItemFallback(id);
        resultMap.set(id, fallback);
      }
    }

    return ids.map((id) => resultMap.get(id)!);
  }

  async fetchPullRequests(prs: PRRef[]): Promise<EnrichedPR[]> {
    if (prs.length === 0) return [];

    const now = Date.now();
    const resultMap = new Map<string, EnrichedPR>();
    const toFetch: PRRef[] = [];

    for (const pr of prs) {
      const cached = this.getCachedPR(pr, now);
      if (cached) {
        resultMap.set(this.prCacheKey(pr), cached);
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

        this.cachePR(enriched, now);
        resultMap.set(this.prCacheKey(pr), enriched);
      } catch (err) {
        console.error(`[ado] Failed to fetch PR ${pr.repoId}#${pr.prId}:`, err);
        const fallback = shouldUseStaleFallback(err)
          ? this.getCachedPR(pr, now, true) ?? this.buildPRFallback(pr)
          : this.buildPRFallback(pr);
        resultMap.set(this.prCacheKey(pr), fallback);
      }
    }

    return prs.map((pr) => resultMap.get(this.prCacheKey(pr))!);
  }
}
