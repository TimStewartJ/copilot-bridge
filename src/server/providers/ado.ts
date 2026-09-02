// Azure DevOps provider — enriches work items and PRs via ADO REST API

import { execSync } from "node:child_process";
import type {
  PRRef,
  EnrichedWorkItem,
  EnrichedPR,
  WorkItemPullRequestLink,
  WorkItemPullRequestLinksResult,
  WorkTrackingIdentity,
  AssignedWorkItemsResult,
  WorkTrackingProvider,
  AdoProviderConfig,
} from "./types.js";
import { createProviderCache } from "./cache.js";
import { mapWithConcurrency } from "../map-with-concurrency.js";

// ── Token cache ───────────────────────────────────────────────────

let cachedToken: { value: string; expiresAt: number } | null = null;
const TOKEN_REFRESH_BUFFER_MS = 60_000;
const TOKEN_CACHE_TTL = 50 * 60_000;
const TOKEN_FETCH_TIMEOUT_MS = 30_000;
const TOKEN_FETCH_ATTEMPTS = 2;
const ASSIGNED_WORK_ITEMS_FETCH_TIMEOUT_MS = 30_000;

class AdoRequestError extends Error {
  readonly transient: boolean;
  readonly status: number | null;

  constructor(message: string, transient: boolean, status: number | null = null) {
    super(message);
    this.name = "AdoRequestError";
    this.transient = transient;
    this.status = status;
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
  return adoFetchAttempt(url, false);
}

async function adoFetchAttempt(url: string, isRetry: boolean): Promise<any> {
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
      res.status,
    );
  }
  if (isHtmlResponse(contentType, body)) {
    if (!isRetry) {
      // ADO silently followed a redirect to its sign-in page, which means the
      // bearer token was rejected. Invalidate the cached token (only if it's
      // still the one we just sent — avoids burning extra `az` calls when many
      // parallel requests fail at once) and retry once with a fresh token.
      if (cachedToken?.value === token) {
        cachedToken = null;
      }
      return adoFetchAttempt(url, true);
    }
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

const workItemCache = createProviderCache<EnrichedWorkItem>();
const prCache = createProviderCache<EnrichedPR>();
const workItemLinkCache = createProviderCache<WorkItemPullRequestLink[]>();
const prLinkCache = createProviderCache<WorkItemPullRequestLink[]>();
const currentUserCache = createProviderCache<WorkTrackingIdentity>();
const assignedWorkItemIdsCache = createProviderCache<string[]>();

function shouldUseStaleFallback(err: unknown): boolean {
  if (err instanceof AdoRequestError) return err.transient;
  return err instanceof TypeError;
}

export function clearAdoProviderState(): void {
  cachedToken = null;
  workItemCache.clear();
  prCache.clear();
  workItemLinkCache.clear();
  prLinkCache.clear();
  currentUserCache.clear();
  assignedWorkItemIdsCache.clear();
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
    return workItemCache.read(this.workItemCacheKey(id), now, allowStale);
  }

  private getCachedPR(pr: PRRef, now: number, allowStale = false): EnrichedPR | null {
    return prCache.read(this.prCacheKey(pr), now, allowStale);
  }

  private cacheWorkItem(item: EnrichedWorkItem, now: number): void {
    workItemCache.write(this.workItemCacheKey(item.id), item, now);
  }

  private cachePR(pr: EnrichedPR, now: number): void {
    prCache.write(this.prCacheKey(pr), pr, now);
  }

  private mapWorkItem(item: any): EnrichedWorkItem {
    const f = item.fields ?? {};
    return {
      id: String(item.id),
      provider: "ado",
      title: f["System.Title"] ?? null,
      state: f["System.State"] ?? null,
      type: f["System.WorkItemType"] ?? null,
      assignedTo: f["System.AssignedTo"]?.displayName ?? null,
      areaPath: f["System.AreaPath"] ?? null,
      url: this.getWorkItemUrl(String(item.id)),
    };
  }

  private mapPullRequest(data: any, pr: PRRef): EnrichedPR {
    const statusMap: Record<string, EnrichedPR["status"]> = {
      active: "active",
      completed: "completed",
      abandoned: "abandoned",
    };
    return {
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
  }

  private async fetchWorkItemBatches(
    ids: string[],
    buildUrl: (batchIds: string[]) => string,
    onSuccess: (requestedIds: string[], items: any[]) => void,
    onFailure: (failedIds: string[], error: unknown) => void,
  ): Promise<void> {
    const fetchBatch = async (batchIds: string[]): Promise<void> => {
      try {
        const data = await adoFetch(buildUrl(batchIds));
        onSuccess(batchIds, Array.isArray(data.value) ? data.value : []);
      } catch (error) {
        if (error instanceof AdoRequestError && error.status === 404 && batchIds.length > 1) {
          const midpoint = Math.ceil(batchIds.length / 2);
          await fetchBatch(batchIds.slice(0, midpoint));
          await fetchBatch(batchIds.slice(midpoint));
          return;
        }
        onFailure(batchIds, error);
      }
    };

    const chunkSize = 100;
    for (let offset = 0; offset < ids.length; offset += chunkSize) {
      await fetchBatch(ids.slice(offset, offset + chunkSize));
    }
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
      const errorById = new Map<string, unknown>();
      const fields = "System.Title,System.State,System.WorkItemType,System.AssignedTo,System.AreaPath";
      await this.fetchWorkItemBatches(
        toFetch,
        (batchIds) =>
          `${this.baseUrl}/${this.project}/_apis/wit/workitems?ids=${batchIds.join(",")}&fields=${fields}&api-version=7.1`,
        (_requestedIds, items) => {
          for (const item of items) {
            const enriched = this.mapWorkItem(item);
            this.cacheWorkItem(enriched, now);
            resultMap.set(enriched.id, enriched);
          }
        },
        (failedIds, error) => {
          console.error(`[ado] Failed to fetch work item${failedIds.length === 1 ? "" : "s"} ${failedIds.join(",")}:`, error);
          for (const id of failedIds) errorById.set(id, error);
        },
      );

      for (const id of toFetch) {
        if (resultMap.has(id)) continue;
        const fetchError = errorById.get(id);
        const fallback = fetchError && shouldUseStaleFallback(fetchError)
          ? this.getCachedWorkItem(id, now, true) ?? this.buildWorkItemFallback(id)
          : this.buildWorkItemFallback(id);
        resultMap.set(id, fallback);
      }
    }

    return ids.map((id) => resultMap.get(id)!);
  }

  private parsePullRequestArtifactLink(
    workItemId: string,
    relation: any,
  ): WorkItemPullRequestLink | null {
    if (relation?.rel !== "ArtifactLink" || relation?.attributes?.name !== "Pull Request") {
      return null;
    }
    const url = typeof relation.url === "string" ? relation.url : "";
    const match = /^vstfs:\/\/\/Git\/PullRequestId\/(.+)$/i.exec(url);
    if (!match) return null;

    let decoded: string;
    try {
      decoded = decodeURIComponent(match[1]);
    } catch (error) {
      if (!(error instanceof URIError)) throw error;
      return null;
    }
    const [projectId, repoId, rawPrId, ...extra] = decoded.split("/");
    const prId = Number(rawPrId);
    if (extra.length > 0 || !projectId || !repoId || !Number.isInteger(prId) || prId <= 0) {
      return null;
    }
    return { workItemId, repoId, repoAliases: [], prId };
  }

  private linksFromWorkItemPayload(item: any): WorkItemPullRequestLink[] {
    const workItemId = String(item.id);
    const links = Array.isArray(item.relations)
      ? item.relations
          .map((relation: any) => this.parsePullRequestArtifactLink(workItemId, relation))
          .filter((link: WorkItemPullRequestLink | null): link is WorkItemPullRequestLink => link !== null)
      : [];
    return links;
  }

  private linksFromPullRequestPayload(data: any, pr: PRRef): WorkItemPullRequestLink[] {
    if (!Array.isArray(data.workItemRefs)) return [];
    const repoId = typeof data.repository?.id === "string" && data.repository.id
      ? data.repository.id
      : pr.repoId;
    const repoAliases = [...new Set([
      pr.repoId,
      pr.repoName,
      typeof data.repository?.name === "string" ? data.repository.name : null,
    ].filter((value): value is string => Boolean(value) && value !== repoId))];
    return data.workItemRefs.flatMap((ref: any) => {
      const workItemId = typeof ref?.id === "string" || typeof ref?.id === "number"
        ? String(ref.id)
        : "";
      return workItemId
        ? [{ workItemId, repoId, repoAliases, prId: pr.prId }]
        : [];
    });
  }

  private async fetchLinksFromWorkItems(
    ids: string[],
    now: number,
  ): Promise<{ links: WorkItemPullRequestLink[]; warning: boolean }> {
    const resultMap = new Map<string, WorkItemPullRequestLink[]>();
    const toFetch: string[] = [];
    for (const id of [...new Set(ids)]) {
      const cached = workItemLinkCache.read(this.workItemCacheKey(id), now);
      if (cached) resultMap.set(id, cached);
      else toFetch.push(id);
    }

    const errorById = new Map<string, unknown>();
    await this.fetchWorkItemBatches(
      toFetch,
      (batchIds) =>
        `${this.baseUrl}/${this.project}/_apis/wit/workitems?ids=${batchIds.join(",")}&$expand=Relations&api-version=7.1`,
      (requestedIds, items) => {
        const returnedIds = new Set<string>();
        for (const item of items) {
          const enriched = this.mapWorkItem(item);
          this.cacheWorkItem(enriched, now);
          const links = this.linksFromWorkItemPayload(item);
          workItemLinkCache.write(this.workItemCacheKey(enriched.id), links, now);
          resultMap.set(enriched.id, links);
          returnedIds.add(enriched.id);
        }
        for (const id of requestedIds) {
          if (returnedIds.has(id)) continue;
          workItemLinkCache.write(this.workItemCacheKey(id), [], now);
          resultMap.set(id, []);
        }
      },
      (failedIds, error) => {
        console.error(
          `[ado] Failed to fetch pull request links for work item${failedIds.length === 1 ? "" : "s"} ${failedIds.join(",")}:`,
          error,
        );
        for (const id of failedIds) errorById.set(id, error);
      },
    );

    for (const id of toFetch) {
      if (resultMap.has(id)) continue;
      const fetchError = errorById.get(id);
      const fallback = fetchError && shouldUseStaleFallback(fetchError)
        ? workItemLinkCache.read(this.workItemCacheKey(id), now, true) ?? []
        : [];
      resultMap.set(id, fallback);
    }

    return {
      links: ids.flatMap((id) => resultMap.get(id) ?? []),
      warning: errorById.size > 0,
    };
  }

  private async fetchLinksFromPullRequests(
    prs: PRRef[],
    now: number,
  ): Promise<{ links: WorkItemPullRequestLink[]; warning: boolean }> {
    const resultMap = new Map<string, WorkItemPullRequestLink[]>();
    const uniquePrs = [...new Map(prs.map((pr) => [this.prCacheKey(pr), pr])).values()];
    const toFetch: PRRef[] = [];
    for (const pr of uniquePrs) {
      const key = this.prCacheKey(pr);
      const cached = prLinkCache.read(key, now);
      if (cached) resultMap.set(key, cached);
      else toFetch.push(pr);
    }

    const refreshWarnings = await mapWithConcurrency(toFetch, 6, async (pr) => {
      const key = this.prCacheKey(pr);
      try {
        const data = await adoFetch(
          `${this.baseUrl}/${this.project}/_apis/git/repositories/${pr.repoId}/pullrequests/${pr.prId}?includeWorkItemRefs=true&api-version=7.1`,
        );
        this.cachePR(this.mapPullRequest(data, pr), now);
        const links = this.linksFromPullRequestPayload(data, pr);
        prLinkCache.write(key, links, now);
        resultMap.set(key, links);
        return false;
      } catch (err) {
        console.error(`[ado] Failed to fetch work item links for PR ${pr.repoId}#${pr.prId}:`, err);
        const fallback = shouldUseStaleFallback(err)
          ? prLinkCache.read(key, now, true) ?? []
          : [];
        resultMap.set(key, fallback);
        return true;
      }
    });

    return {
      links: uniquePrs.flatMap((pr) => resultMap.get(this.prCacheKey(pr)) ?? []),
      warning: refreshWarnings.some(Boolean),
    };
  }

  async fetchWorkItemPullRequestLinks(
    workItemIds: string[],
    pullRequests: PRRef[],
  ): Promise<WorkItemPullRequestLinksResult> {
    const now = Date.now();
    const [fromWorkItems, fromPullRequests] = await Promise.all([
      this.fetchLinksFromWorkItems(workItemIds, now),
      this.fetchLinksFromPullRequests(pullRequests, now),
    ]);
    const linkMap = new Map<string, WorkItemPullRequestLink>();
    for (const link of [...fromPullRequests.links, ...fromWorkItems.links]) {
      const key = `${link.workItemId}:${link.repoId}:${link.prId}`;
      const existing = linkMap.get(key);
      linkMap.set(key, {
        ...link,
        repoAliases: [...new Set([...(existing?.repoAliases ?? []), ...link.repoAliases])],
      });
    }
    const links = [...linkMap.values()];
    const warnings: string[] = [];
    if (fromWorkItems.warning) {
      warnings.push("Some ADO work item relationships could not be refreshed.");
    }
    if (fromPullRequests.warning) {
      warnings.push("Some ADO pull request relationships could not be refreshed.");
    }
    return { links, warnings };
  }

  async fetchCurrentUser(): Promise<WorkTrackingIdentity | null> {
    const now = Date.now();
    const cached = currentUserCache.read(this.org, now);
    if (cached) return cached;

    try {
      const data = await adoFetch(
        `${this.baseUrl}/_apis/connectionData?connectOptions=1&lastChangeId=-1&lastChangeId64=-1`,
      );
      const displayName = typeof data.authenticatedUser?.providerDisplayName === "string"
        ? data.authenticatedUser.providerDisplayName.trim()
        : "";
      if (!displayName) {
        console.error("[ado] Authenticated user response did not include a display name");
        return null;
      }
      const identity = { displayName };
      currentUserCache.write(this.org, identity, now);
      return identity;
    } catch (err) {
      console.error("[ado] Failed to fetch authenticated user:", err);
      return shouldUseStaleFallback(err)
        ? currentUserCache.read(this.org, now, true)
        : null;
    }
  }

  async fetchAssignedWorkItemIds(): Promise<AssignedWorkItemsResult> {
    const now = Date.now();
    const cacheKey = `${this.org}:${this.project}`;
    const cached = assignedWorkItemIdsCache.read(cacheKey, now);
    if (cached) return { ids: cached, warnings: [] };

    try {
      const query = [
        "SELECT [System.Id] FROM WorkItems",
        "WHERE [System.AssignedTo] = @Me",
        "AND [System.State] <> 'Resolved'",
        "AND [System.State] <> 'Removed'",
        "ORDER BY [System.ChangedDate] DESC",
      ].join(" ");
      const raw = execSync(
        `az boards query --wiql ${JSON.stringify(query)} --query "[].id" --output json`,
        {
          encoding: "utf-8",
          timeout: ASSIGNED_WORK_ITEMS_FETCH_TIMEOUT_MS,
          maxBuffer: 1024 * 1024,
        },
      );
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        throw new Error("ADO assigned work query returned a non-array result");
      }
      const ids = [...new Set<string>(parsed.flatMap((id): string[] =>
        typeof id === "number" || typeof id === "string" ? [String(id)] : []))];
      assignedWorkItemIdsCache.write(cacheKey, ids, now);
      return { ids, warnings: [] };
    } catch (err) {
      console.error("[ado] Failed to fetch assigned work items:", err);
      const stale = assignedWorkItemIdsCache.read(cacheKey, now, true);
      return {
        ids: stale ?? [],
        warnings: ["Assigned ADO work items could not be refreshed."],
      };
    }
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

    await mapWithConcurrency(toFetch, 6, async (pr) => {
      try {
        const data = await adoFetch(
          `${this.baseUrl}/${this.project}/_apis/git/repositories/${pr.repoId}/pullrequests/${pr.prId}?api-version=7.1`,
        );

        const enriched = this.mapPullRequest(data, pr);

        this.cachePR(enriched, now);
        resultMap.set(this.prCacheKey(pr), enriched);
      } catch (err) {
        console.error(`[ado] Failed to fetch PR ${pr.repoId}#${pr.prId}:`, err);
        const fallback = shouldUseStaleFallback(err)
          ? this.getCachedPR(pr, now, true) ?? this.buildPRFallback(pr)
          : this.buildPRFallback(pr);
        resultMap.set(this.prCacheKey(pr), fallback);
      }
    });

    return prs.map((pr) => resultMap.get(this.prCacheKey(pr))!);
  }
}
