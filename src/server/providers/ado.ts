// Azure DevOps provider — enriches work items and PRs via ADO REST API

import { getProcessHost } from "../process-host.js";
import type {
  PRRef,
  EnrichedWorkItem,
  EnrichedPR,
  WorkItemPullRequestLink,
  WorkItemRelation,
  WorkItemRelationType,
  WorkItemLinksResult,
  PullRequestLinksResult,
  WorkTrackingIdentity,
  AssignedWorkItemsResult,
  WorkTrackingProvider,
  AdoProviderConfig,
} from "./types.js";
import { createProviderCache } from "./cache.js";
import { mapWithConcurrency } from "../map-with-concurrency.js";
import { buildAdoPullRequestUrl } from "../../shared/ado-work-reference.js";
import { CLOSED_WORK_ITEM_STATES } from "../../shared/work-map.js";

// ── Token cache ───────────────────────────────────────────────────

let cachedToken: { value: string; expiresAt: number } | null = null;
const TOKEN_REFRESH_BUFFER_MS = 60_000;
const TOKEN_CACHE_TTL = 50 * 60_000;
const TOKEN_FETCH_TIMEOUT_MS = 30_000;
const TOKEN_FETCH_ATTEMPTS = 2;
const REQUEST_TIMEOUT_MS = 30_000;

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
  // A command killed by its timeout reports `killed`, not an ETIMEDOUT code.
  const failure = err as NodeJS.ErrnoException & { killed?: boolean };
  return failure.code === "ETIMEDOUT" || failure.killed === true || /timed? ?out/i.test(err.message);
}

async function fetchAccessTokenOnce(): Promise<string> {
  const { stdout } = await getProcessHost().exec(
    // 499b84ac-1321-427f-aa17-267ca6975798 is the well-known Azure DevOps public resource ID
    // (used by all az CLI / MSAL integrations — not a secret)
    'az account get-access-token --resource "499b84ac-1321-427f-aa17-267ca6975798" --query accessToken -o tsv',
    { encoding: "utf-8", timeout: TOKEN_FETCH_TIMEOUT_MS },
  );
  const result = stdout.trim();
  if (!result) {
    throw new Error("ADO access token command returned empty result");
  }
  return result;
}

let tokenRefreshInFlight: Promise<string> | null = null;

/** Single-flight: parallel requests share one `az` invocation instead of starting one each. */
function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - TOKEN_REFRESH_BUFFER_MS) {
    return Promise.resolve(cachedToken.value);
  }
  return (tokenRefreshInFlight ??= refreshAccessToken().finally(() => {
    tokenRefreshInFlight = null;
  }));
}

async function refreshAccessToken(): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= TOKEN_FETCH_ATTEMPTS; attempt++) {
    try {
      const result = await fetchAccessTokenOnce();
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

/** GETs `url`, or POSTs `payload` to it, and returns the parsed JSON answer. */
async function adoFetch(url: string, payload?: unknown, isRetry = false): Promise<any> {
  const token = await getAccessToken();
  let res: Response;
  let body: string;
  try {
    res = await fetch(url, {
      method: payload === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(payload === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    body = await res.text();
  } catch (error) {
    // A dropped connection, or an answer that did not arrive in time, can succeed on a later try.
    throw new AdoRequestError(
      `ADO request failed: ${error instanceof Error ? error.message : String(error)}`,
      true,
    );
  }
  const contentType = res.headers.get("content-type") ?? "";
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
      return adoFetch(url, payload, true);
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

interface WorkItemLinks {
  pullRequests: WorkItemPullRequestLink[];
  relations: WorkItemRelation[];
}

const NO_WORK_ITEM_LINKS: WorkItemLinks = { pullRequests: [], relations: [] };

const WORK_ITEM_RELATION_TYPES: Record<string, WorkItemRelationType> = {
  "system.linktypes.hierarchy-reverse": "parent",
  "system.linktypes.hierarchy-forward": "child",
  "system.linktypes.related": "related",
  "system.linktypes.dependency-reverse": "predecessor",
  "system.linktypes.dependency-forward": "successor",
  "system.linktypes.duplicate-forward": "duplicate",
  "system.linktypes.duplicate-reverse": "duplicateOf",
};

const WORK_ITEM_FIELDS = "System.Title,System.State,System.WorkItemType,System.AssignedTo,System.AreaPath";
const WORK_ITEM_BATCH_SIZE = 100;
const WORK_ITEM_BATCH_CONCURRENCY = 4;
const PULL_REQUEST_CONCURRENCY = 6;
const REPOSITORY_GUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const ASSIGNED_OPEN_WORK_QUERY = "SELECT [System.Id] FROM WorkItems WHERE [System.AssignedTo] = @Me"
  + ` AND [System.State] NOT IN (${CLOSED_WORK_ITEM_STATES.map((state) => `'${state}'`).join(", ")})`
  + " ORDER BY [System.ChangedDate] DESC";

/**
 * A completed pull request rarely changes again, so it is asked for again only after this long.
 * Everything else uses the cache's short default: closed work can be reopened and an abandoned
 * pull request reactivated, and the task panels that read this cache have no refresh of their own.
 */
const COMPLETED_PR_FRESH_MS = 6 * 60 * 60_000;

const workItemCache = createProviderCache<EnrichedWorkItem>();
const prCache = createProviderCache<EnrichedPR>();
const workItemLinkCache = createProviderCache<WorkItemLinks>();
const prLinkCache = createProviderCache<WorkItemPullRequestLink[]>();
const currentUserCache = createProviderCache<WorkTrackingIdentity>();
const assignedWorkItemIdsCache = createProviderCache<string[]>();
const dataCaches = [workItemCache, prCache, workItemLinkCache, prLinkCache, currentUserCache, assignedWorkItemIdsCache];

function shouldUseStaleFallback(err: unknown): boolean {
  return err instanceof AdoRequestError && err.transient;
}

function isNotFound(err: unknown): boolean {
  return err instanceof AdoRequestError && err.status === 404;
}

export function clearAdoProviderState(): void {
  cachedToken = null;
  for (const cache of dataCaches) cache.clear();
}

/**
 * Makes the next read ask ADO again. The access token and the stale copies that cover an ADO
 * outage are kept, so a refresh never leaves less on screen than there was before it.
 */
export function expireAdoProviderData(): void {
  for (const cache of dataCaches) cache.expire();
}

/** Told how many work items or pull requests have just been read, so a long read can show progress. */
type Tick = (count: number) => void;

// ── Provider ──────────────────────────────────────────────────────

export class AdoProvider implements WorkTrackingProvider {
  readonly name = "ado" as const;
  readonly org: string;
  readonly project: string;
  private readonly baseUrl: string;
  private readonly projectUrl: string;

  constructor(config: AdoProviderConfig) {
    this.org = config.org;
    this.project = config.project;
    this.baseUrl = `https://dev.azure.com/${config.org}`;
    this.projectUrl = `${this.baseUrl}/${encodeURIComponent(config.project)}`;
  }

  getWorkItemUrl(id: string): string {
    return `https://${this.org}.visualstudio.com/${this.project}/_workitems/edit/${id}`;
  }

  getPullRequestUrl(pr: PRRef): string {
    // A link saved from another organization carries that repository's URL as its name.
    if (pr.repoName && /^https:\/\//i.test(pr.repoName)) {
      return `${pr.repoName.replace(/\/+$/, "")}/pullrequest/${pr.prId}`;
    }
    return buildAdoPullRequestUrl({
      org: this.org,
      project: this.project,
      repository: pr.repoName ?? pr.repoId,
      prId: pr.prId,
    });
  }

  private workItemCacheKey(id: string): string {
    return `${this.org}:${id}`;
  }

  private prCacheKey(pr: Pick<PRRef, "repoId" | "prId">): string {
    return `${this.org}:${pr.repoId}:${pr.prId}`;
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
    const repoName = data.repository?.name ?? pr.repoName ?? null;
    return {
      repoId: pr.repoId,
      repoName,
      prId: pr.prId,
      provider: "ado",
      title: data.title ?? null,
      status: statusMap[data.status?.toLowerCase()] ?? null,
      createdBy: data.createdBy?.displayName ?? null,
      reviewerCount: data.reviewers?.length ?? 0,
      url: buildAdoPullRequestUrl({
        org: this.org,
        project: data.repository?.project?.name || this.project,
        repository: repoName ?? pr.repoId,
        prId: pr.prId,
      }),
    };
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

  /** Remembers a work item, or the stub for one ADO did not return, and hands it back. */
  private cacheWorkItem(id: string, payload: any, now: number): EnrichedWorkItem {
    const item = payload ? this.mapWorkItem(payload) : this.buildWorkItemFallback(id);
    workItemCache.write(this.workItemCacheKey(id), item, now);
    return item;
  }

  /**
   * Reads work items in batches, several batches at a time. `onItem` gets each work item's
   * payload, or null for one ADO has no answer for: deleted, in an organization this login cannot
   * read, or not a work item number. Returns the error for every id whose batch failed.
   */
  private async readWorkItems(
    ids: string[],
    query: string,
    onItem: (id: string, payload: any) => void,
    tick?: Tick,
  ): Promise<Map<string, unknown>> {
    const errors = new Map<string, unknown>();
    // ADO rejects the whole batch when one id is not a number.
    const isNumber = (id: string) => /^\d+$/.test(id);
    const readable = ids.filter(isNumber);
    for (const id of ids) {
      if (!isNumber(id)) onItem(id, null);
    }
    tick?.(ids.length - readable.length);
    const batches: string[][] = [];
    for (let offset = 0; offset < readable.length; offset += WORK_ITEM_BATCH_SIZE) {
      batches.push(readable.slice(offset, offset + WORK_ITEM_BATCH_SIZE));
    }
    await mapWithConcurrency(batches, WORK_ITEM_BATCH_CONCURRENCY, async (batch) => {
      try {
        // errorPolicy=omit leaves out a work item that cannot be read instead of failing its batch.
        const data = await adoFetch(
          `${this.projectUrl}/_apis/wit/workitems?ids=${batch.join(",")}&${query}&errorPolicy=omit&api-version=7.1`,
        );
        const payloads = new Map<string, any>();
        for (const item of Array.isArray(data.value) ? data.value : []) {
          if (item) payloads.set(String(item.id), item);
        }
        for (const id of batch) onItem(id, payloads.get(id) ?? null);
      } catch (error) {
        console.error(`[ado] Failed to fetch work item${batch.length === 1 ? "" : "s"} ${batch.join(",")}:`, error);
        for (const id of batch) errors.set(id, error);
      }
      tick?.(batch.length);
    });
    return errors;
  }

  async fetchWorkItems(ids: string[], tick?: Tick): Promise<EnrichedWorkItem[]> {
    const now = Date.now();
    const result = new Map<string, EnrichedWorkItem>();
    const toFetch = [...new Set(ids)].filter((id) => {
      const cached = workItemCache.read(this.workItemCacheKey(id), now);
      if (cached) result.set(id, cached);
      return !cached;
    });
    tick?.(ids.length - toFetch.length);

    const errors = await this.readWorkItems(toFetch, `fields=${WORK_ITEM_FIELDS}`, (id, payload) => {
      result.set(id, this.cacheWorkItem(id, payload, now));
    }, tick);
    for (const [id, error] of errors) {
      const stale = shouldUseStaleFallback(error) ? workItemCache.read(this.workItemCacheKey(id), now, true) : null;
      result.set(id, stale ?? this.buildWorkItemFallback(id));
    }
    return ids.map((id) => result.get(id)!);
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
    return { workItemId, repoId, prId };
  }

  private parseWorkItemRelation(workItemId: string, relation: any): WorkItemRelation | null {
    const type = typeof relation?.rel === "string"
      ? WORK_ITEM_RELATION_TYPES[relation.rel.toLowerCase()]
      : undefined;
    if (!type || typeof relation.url !== "string") return null;
    const match = /\/_apis\/wit\/workItems\/(\d+)$/i.exec(relation.url);
    if (!match || match[1] === workItemId) return null;
    return { workItemId, type, targetId: match[1] };
  }

  private linksFromWorkItemPayload(item: any): WorkItemLinks {
    const workItemId = String(item.id);
    if (!Array.isArray(item.relations)) return NO_WORK_ITEM_LINKS;
    const pullRequests: WorkItemPullRequestLink[] = [];
    const relations = new Map<string, WorkItemRelation>();
    for (const relation of item.relations) {
      const pullRequest = this.parsePullRequestArtifactLink(workItemId, relation);
      if (pullRequest) {
        pullRequests.push(pullRequest);
        continue;
      }
      const workItemRelation = this.parseWorkItemRelation(workItemId, relation);
      if (workItemRelation) {
        relations.set(`${workItemRelation.type}:${workItemRelation.targetId}`, workItemRelation);
      }
    }
    return { pullRequests, relations: [...relations.values()] };
  }

  private linksFromPullRequestPayload(data: any, pr: PRRef): WorkItemPullRequestLink[] {
    if (!Array.isArray(data.workItemRefs)) return [];
    return data.workItemRefs.flatMap((ref: any) => {
      const workItemId = typeof ref?.id === "string" || typeof ref?.id === "number"
        ? String(ref.id)
        : "";
      return workItemId
        ? [{ workItemId, repoId: pr.repoId, prId: pr.prId }]
        : [];
    });
  }

  /**
   * The pull requests and other work items that work items link to. The same answer carries each
   * work item's fields, so a later fetchWorkItems for these ids is served from the cache.
   */
  async fetchWorkItemLinks(ids: string[], tick?: Tick): Promise<WorkItemLinksResult> {
    const now = Date.now();
    const result = new Map<string, WorkItemLinks>();
    const unique = [...new Set(ids)];
    const toFetch = unique.filter((id) => {
      const cached = workItemLinkCache.read(this.workItemCacheKey(id), now);
      if (cached) result.set(id, cached);
      return !cached;
    });
    tick?.(unique.length - toFetch.length);

    const errors = await this.readWorkItems(toFetch, "$expand=Relations", (id, payload) => {
      this.cacheWorkItem(id, payload, now);
      const links = payload ? this.linksFromWorkItemPayload(payload) : NO_WORK_ITEM_LINKS;
      workItemLinkCache.write(this.workItemCacheKey(id), links, now);
      result.set(id, links);
    }, tick);
    for (const [id, error] of errors) {
      const stale = shouldUseStaleFallback(error) ? workItemLinkCache.read(this.workItemCacheKey(id), now, true) : null;
      result.set(id, stale ?? NO_WORK_ITEM_LINKS);
    }

    return {
      pullRequests: unique.flatMap((id) => result.get(id)!.pullRequests),
      relations: unique.flatMap((id) => result.get(id)!.relations),
      warnings: errors.size > 0 ? ["Some ADO work items could not be refreshed."] : [],
    };
  }

  /**
   * Reads one pull request, with the work items it links when `withWorkItems` is set, and
   * remembers both. A pull request ADO says is not there comes back as a stub and is not reported
   * as a failed refresh: asking again would not find it.
   */
  private async readPullRequest(
    pr: PRRef,
    now: number,
    withWorkItems: boolean,
  ): Promise<{ details: EnrichedPR; links: WorkItemPullRequestLink[]; failed: boolean }> {
    const key = this.prCacheKey(pr);
    const cachedDetails = prCache.read(key, now);
    const cachedLinks = prLinkCache.read(key, now);
    if (cachedDetails && (cachedLinks || !withWorkItems)) {
      return { details: cachedDetails, links: cachedLinks ?? [], failed: false };
    }
    const hasGuid = REPOSITORY_GUID.test(pr.repoId);
    try {
      const data = await adoFetch(withWorkItems && hasGuid
        // Only the repository route returns work item refs, and it takes the repository's GUID. Task
        // links are stored with it. A link without one is read by id and reports no work items.
        ? `${this.baseUrl}/_apis/git/repositories/${pr.repoId}/pullrequests/${pr.prId}?includeWorkItemRefs=true&api-version=7.1`
        // Pull request ids are unique across the organization, so this route resolves links from
        // every project, including chat links that only carry a repository name.
        : `${this.baseUrl}/_apis/git/pullrequests/${pr.prId}?api-version=7.1`);
      // The id alone names a pull request in this organization. A link saved from another one
      // must not show whichever pull request happens to have the same number here.
      if (hasGuid && String(data.repository?.id).toLowerCase() !== pr.repoId.toLowerCase()) {
        throw new AdoRequestError(`Pull request ${pr.prId} is not in repository ${pr.repoId}`, false, 404);
      }
      const details = this.mapPullRequest(data, pr);
      const freshMs = details.status === "completed" ? COMPLETED_PR_FRESH_MS : undefined;
      prCache.write(key, details, now, freshMs);
      if (!withWorkItems) return { details, links: [], failed: false };
      const links = this.linksFromPullRequestPayload(data, pr);
      prLinkCache.write(key, links, now, freshMs);
      return { details, links, failed: false };
    } catch (err) {
      console.error(`[ado] Failed to fetch PR ${pr.repoId}#${pr.prId}:`, err);
      const stale = shouldUseStaleFallback(err);
      const details = (stale ? prCache.read(key, now, true) : null) ?? this.buildPRFallback(pr);
      const links = (stale ? prLinkCache.read(key, now, true) : null) ?? [];
      if (isNotFound(err)) {
        // One build reads a pull request twice, for its work items and for its details.
        prCache.write(key, details, now);
        prLinkCache.write(key, links, now);
      }
      return { details, links, failed: !isNotFound(err) };
    }
  }

  async fetchPullRequests(prs: PRRef[], tick?: Tick): Promise<EnrichedPR[]> {
    const now = Date.now();
    return mapWithConcurrency(prs, PULL_REQUEST_CONCURRENCY, async (pr) => {
      const { details } = await this.readPullRequest(pr, now, false);
      tick?.(1);
      return details;
    });
  }

  /** The work items that pull requests link to. A pull request saved without its repository's GUID reports none. */
  async fetchPullRequestWorkItems(prs: PRRef[], tick?: Tick): Promise<PullRequestLinksResult> {
    const now = Date.now();
    const unique = [...new Map(prs.map((pr) => [this.prCacheKey(pr), pr])).values()];
    const results = await mapWithConcurrency(unique, PULL_REQUEST_CONCURRENCY, async (pr) => {
      const result = await this.readPullRequest(pr, now, true);
      tick?.(1);
      return result;
    });
    return {
      links: results.flatMap((result) => result.links),
      warnings: results.some((result) => result.failed) ? ["Some ADO pull requests could not be refreshed."] : [],
    };
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

  /** Open work items assigned to the signed-in user, most recently changed first. */
  async fetchAssignedWorkItemIds(): Promise<AssignedWorkItemsResult> {
    const now = Date.now();
    const cacheKey = `${this.org}:${this.project}`;
    const cached = assignedWorkItemIdsCache.read(cacheKey, now);
    if (cached) return { ids: cached, warnings: [] };

    try {
      const data = await adoFetch(`${this.projectUrl}/_apis/wit/wiql?api-version=7.1`, { query: ASSIGNED_OPEN_WORK_QUERY });
      if (!Array.isArray(data.workItems)) {
        throw new Error("ADO assigned work query returned no work item list");
      }
      const ids = [...new Set<string>(data.workItems.flatMap((item: any) => (item?.id == null ? [] : [String(item.id)])))];
      assignedWorkItemIdsCache.write(cacheKey, ids, now);
      return { ids, warnings: [] };
    } catch (err) {
      console.error("[ado] Failed to fetch assigned work items:", err);
      return {
        ids: assignedWorkItemIdsCache.read(cacheKey, now, true) ?? [],
        warnings: ["Assigned ADO work items could not be refreshed."],
      };
    }
  }
}
