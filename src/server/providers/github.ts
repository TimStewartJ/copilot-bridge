// GitHub provider — enriches issues and pull requests via the GitHub REST API.
// Auth is ambient (no secrets in settings): BRIDGE_COPILOT_GITHUB_TOKEN → GH_TOKEN →
// GITHUB_TOKEN → `gh auth token`. Without any token, public repositories still enrich.

import { execFile } from "node:child_process";
import type { PRRef, EnrichedWorkItem, EnrichedPR, WorkTrackingProvider, GitHubProviderConfig } from "./types.js";
import { createProviderCache, type ProviderCache } from "./cache.js";

const API_ROOT = "https://api.github.com";
const WEB_ROOT = "https://github.com";
const NO_URL = "#";

const REQUEST_TIMEOUT_MS = 10_000;
const CLI_TOKEN_TIMEOUT_MS = 10_000;
const CLI_TOKEN_TTL_MS = 30 * 60_000;
const CLI_TOKEN_MISSING_TTL_MS = 5 * 60_000;
const DEFAULT_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 15 * 60_000;

const TOKEN_ENV_KEYS = ["BRIDGE_COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"] as const;
const NAME_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

interface RepoRef {
  owner: string;
  repo: string;
}

interface IssueRef extends RepoRef {
  number: number;
}

/** Provider metadata without caller-facing identity fields, so cache entries stay canonical. */
type IssueMetadata = Omit<EnrichedWorkItem, "id" | "provider">;
type PRMetadata = Omit<EnrichedPR, "repoId" | "prId" | "provider">;

// ── Reference parsing ─────────────────────────────────────────────

/** Repo/owner segments must be plain names — "." and ".." would escape the API path. */
function isNameSegment(value: string): boolean {
  return NAME_SEGMENT_RE.test(value) && value !== "." && value !== "..";
}

function sanitizeSegment(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  return isNameSegment(trimmed) ? trimmed : "";
}

function parsePositiveInt(value: string | number): number | null {
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/** Parse a github.com issue/pull URL. Only exact github.com https URLs are accepted. */
function parseIssueUrl(value: string): IssueRef | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") return null;

  // Trailing segments (e.g. /files) are ignored; the leading shape must match exactly.
  const [owner, repo, kind, numberText] = url.pathname.split("/").filter(Boolean);
  if (kind !== "issues" && kind !== "pull") return null;
  if (!owner || !repo || !isNameSegment(owner) || !isNameSegment(repo)) return null;

  const number = numberText ? parsePositiveInt(numberText) : null;
  return number === null ? null : { owner, repo, number };
}

/**
 * Canonicalize a GitHub-style work item reference to `owner/repo#123`.
 * Non-GitHub ids (ADO numbers, Linear identifiers) pass through unchanged.
 */
export function canonicalizeGitHubWorkItemId(id: string): string {
  const trimmed = id.trim();
  const fromUrl = parseIssueUrl(trimmed);
  if (fromUrl) return `${fromUrl.owner}/${fromUrl.repo}#${fromUrl.number}`;
  if (trimmed.startsWith("#") && /^\d+$/.test(trimmed.slice(1))) return trimmed.slice(1);
  return trimmed;
}

// ── Token resolution ──────────────────────────────────────────────

let cliToken: { value: string | null; expiresAt: number } | null = null;
let cliTokenInFlight: Promise<string | null> | null = null;

function readTokenFromEnv(): string | null {
  for (const key of TOKEN_ENV_KEYS) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return null;
}

function runGhAuthToken(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "gh",
      ["auth", "token", "--hostname", "github.com"],
      { timeout: CLI_TOKEN_TIMEOUT_MS },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(typeof stdout === "string" ? stdout : String(stdout));
      },
    );
  });
}

/** Read a token from `gh` (cached, single in-flight lookup). Returns null when unavailable. */
async function readTokenFromCli(): Promise<string | null> {
  if (cliToken && Date.now() < cliToken.expiresAt) return cliToken.value;
  if (cliTokenInFlight) return cliTokenInFlight;

  cliTokenInFlight = (async () => {
    let value: string | null = null;
    try {
      value = (await runGhAuthToken()).trim() || null;
    } catch {
      // `gh` missing, not on PATH, or not logged in — enrich anonymously instead.
      // Error details are intentionally not logged: they can echo CLI output.
      console.warn("[github] No token from `gh auth token`; continuing unauthenticated");
    }
    cliToken = {
      value,
      expiresAt: Date.now() + (value ? CLI_TOKEN_TTL_MS : CLI_TOKEN_MISSING_TTL_MS),
    };
    cliTokenInFlight = null;
    return value;
  })();

  return cliTokenInFlight;
}

async function resolveToken(): Promise<string | null> {
  return readTokenFromEnv() ?? await readTokenFromCli();
}

// ── Requests ──────────────────────────────────────────────────────

class GitHubRequestError extends Error {
  readonly transient: boolean;

  constructor(message: string, transient: boolean) {
    super(message);
    this.name = "GitHubRequestError";
    this.transient = transient;
  }
}

let rateLimitCooldownUntil = 0;

function clampCooldown(ms: number): number {
  return Math.min(Math.max(ms, 1_000), MAX_COOLDOWN_MS);
}

/** Cooldown for primary (403 + remaining: 0) and secondary (429, Retry-After, or body text) limits. */
function rateLimitCooldownMs(res: Response, detail: string, now: number): number | null {
  if (res.status !== 403 && res.status !== 429) return null;

  const retryAfter = Number(res.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return clampCooldown(retryAfter * 1000);

  if (res.headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    if (Number.isFinite(reset) && reset > 0) return clampCooldown(reset * 1000 - now);
    return DEFAULT_COOLDOWN_MS;
  }

  // Secondary limits can arrive as a bare 403 whose only signal is the message body.
  if (/rate limit|abuse detection/i.test(detail)) return DEFAULT_COOLDOWN_MS;

  return res.status === 429 ? DEFAULT_COOLDOWN_MS : null;
}

/** Read a short, safe description of an error response (GitHub returns `{ message }`). */
async function readErrorDetail(res: Response): Promise<string> {
  try {
    const body = (await res.text()).trim();
    if (!body) return "";
    try {
      const parsed = JSON.parse(body);
      if (typeof parsed?.message === "string") return parsed.message.slice(0, 200);
    } catch {
      // Not JSON — fall through to the raw snippet.
    }
    return body.replace(/\s+/g, " ").slice(0, 200);
  } catch {
    return "";
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

function isTransientError(err: unknown): boolean {
  return err instanceof GitHubRequestError && err.transient;
}

async function githubFetch(path: string, anonymous = false): Promise<any> {
  const now = Date.now();
  if (!anonymous && now < rateLimitCooldownUntil) {
    throw new GitHubRequestError("GitHub API rate limit cooldown in effect", true);
  }

  const token = anonymous ? null : await resolveToken();
  let res: Response;
  try {
    res = await fetch(`${API_ROOT}${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "copilot-bridge",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    // Network failures, aborts, and AbortSignal timeouts (DOMException) are all retryable.
    throw new GitHubRequestError(`GitHub API request failed (${describeError(err)})`, true);
  }

  if (!res.ok) {
    const detail = await readErrorDetail(res);
    const cooldown = rateLimitCooldownMs(res, detail, Date.now());
    if (cooldown !== null) {
      // Monotonic: a racing response must never shorten an active cooldown.
      rateLimitCooldownUntil = Math.max(rateLimitCooldownUntil, Date.now() + cooldown);
      throw new GitHubRequestError(`GitHub API rate limited (${res.status}): ${detail}`, true);
    }
    if (res.status === 401 && token) {
      // The token was rejected — drop a cached CLI token and try once anonymously.
      if (cliToken?.value === token) cliToken = null;
      return githubFetch(path, true);
    }
    const transient = res.status === 408 || res.status >= 500;
    throw new GitHubRequestError(`GitHub API ${res.status}: ${res.statusText || detail}`, transient);
  }

  try {
    return await res.json();
  } catch (err) {
    throw new GitHubRequestError(`GitHub API returned invalid JSON (${describeError(err)})`, true);
  }
}

// ── Enrichment cache ──────────────────────────────────────────────

const issueCache = createProviderCache<IssueMetadata>();
const prCache = createProviderCache<PRMetadata>();
const issueInFlight = new Map<string, Promise<IssueMetadata>>();
const prInFlight = new Map<string, Promise<PRMetadata>>();

export function clearGitHubProviderState(): void {
  cliToken = null;
  rateLimitCooldownUntil = 0;
  issueCache.clear();
  prCache.clear();
  issueInFlight.clear();
  prInFlight.clear();
}

/** Collapse concurrent loads of the same reference into one request. */
function loadOnce<T>(inFlight: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) return existing;
  const pending = load().finally(() => {
    if (inFlight.get(key) === pending) inFlight.delete(key);
  });
  inFlight.set(key, pending);
  return pending;
}

/**
 * Serve stale data for retryable failures. Definitive failures (404/401/403) replace any
 * cached metadata with the fallback so missing references neither resurrect old data nor
 * re-request on every refetch.
 */
function recover<T>(cache: ProviderCache<T>, key: string, err: unknown, now: number, fallback: T): T {
  if (isTransientError(err)) return cache.read(key, now, true) ?? fallback;
  cache.write(key, fallback, now);
  return fallback;
}

// ── Mapping ───────────────────────────────────────────────────────

function issueKey(ref: IssueRef): string {
  return `${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}#${ref.number}`;
}

function prKey(ref: RepoRef, prId: number): string {
  return `${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}!${prId}`;
}

function issueWebUrl(ref: IssueRef, isPullRequest = false): string {
  return `${WEB_ROOT}/${ref.owner}/${ref.repo}/${isPullRequest ? "pull" : "issues"}/${ref.number}`;
}

function prWebUrl(ref: RepoRef, prId: number): string {
  return `${WEB_ROOT}/${ref.owner}/${ref.repo}/pull/${prId}`;
}

function issueFallback(ref: IssueRef | null): IssueMetadata {
  return {
    title: null,
    state: null,
    type: null,
    assignedTo: null,
    areaPath: ref ? `${ref.owner}/${ref.repo}` : null,
    url: ref ? issueWebUrl(ref) : NO_URL,
  };
}

function prFallback(ref: RepoRef | null, prId: number | null, repoName?: string): PRMetadata {
  return {
    repoName: ref ? `${ref.owner}/${ref.repo}` : repoName ?? null,
    title: null,
    status: null,
    createdBy: null,
    reviewerCount: 0,
    url: ref && prId !== null ? prWebUrl(ref, prId) : NO_URL,
  };
}

function mapIssue(ref: IssueRef, data: any): IssueMetadata {
  const isPullRequest = Boolean(data?.pull_request);
  const state = typeof data?.state === "string" ? data.state.toLowerCase() : null;
  return {
    title: typeof data?.title === "string" ? data.title : null,
    state: state === "open" ? "Open" : state === "closed" ? "Closed" : null,
    type: isPullRequest ? "Pull Request" : "Issue",
    assignedTo: data?.assignee?.login ?? data?.assignees?.[0]?.login ?? null,
    areaPath: `${ref.owner}/${ref.repo}`,
    url: issueWebUrl(ref, isPullRequest),
  };
}

function mapPR(ref: RepoRef, prId: number, data: any): PRMetadata {
  const state = typeof data?.state === "string" ? data.state.toLowerCase() : null;
  const status: EnrichedPR["status"] = data?.merged_at
    ? "completed"
    : state === "open" ? "active" : state === "closed" ? "abandoned" : null;
  // Counts pending review requests — GitHub drops reviewers once they submit a review.
  const reviewerCount = (Array.isArray(data?.requested_reviewers) ? data.requested_reviewers.length : 0)
    + (Array.isArray(data?.requested_teams) ? data.requested_teams.length : 0);

  return {
    repoName: `${ref.owner}/${ref.repo}`,
    title: typeof data?.title === "string" ? data.title : null,
    status,
    createdBy: data?.user?.login ?? null,
    reviewerCount,
    url: prWebUrl(ref, prId),
  };
}

// ── Loaders ───────────────────────────────────────────────────────

async function loadIssue(key: string, ref: IssueRef): Promise<IssueMetadata> {
  try {
    const data = await githubFetch(`/repos/${ref.owner}/${ref.repo}/issues/${ref.number}`);
    const metadata = mapIssue(ref, data);
    issueCache.write(key, metadata, Date.now());
    return metadata;
  } catch (err) {
    console.error(`[github] Failed to fetch issue ${key}:`, describeError(err));
    return recover(issueCache, key, err, Date.now(), issueFallback(ref));
  }
}

async function loadPR(key: string, ref: RepoRef, prId: number): Promise<PRMetadata> {
  try {
    const data = await githubFetch(`/repos/${ref.owner}/${ref.repo}/pulls/${prId}`);
    const metadata = mapPR(ref, prId, data);
    prCache.write(key, metadata, Date.now());
    return metadata;
  } catch (err) {
    console.error(`[github] Failed to fetch PR ${key}:`, describeError(err));
    return recover(prCache, key, err, Date.now(), prFallback(ref, prId));
  }
}

// ── Provider ──────────────────────────────────────────────────────

export class GitHubProvider implements WorkTrackingProvider {
  readonly name = "github" as const;
  private readonly owner: string;
  private readonly defaultRepo: string;

  constructor(config: GitHubProviderConfig) {
    this.owner = sanitizeSegment(config.owner);
    this.defaultRepo = sanitizeSegment(config.defaultRepo);
  }

  /** Resolve "owner/repo", "repo", or "" (configured defaults) into a repo ref. */
  private resolveRepo(value: string): RepoRef | null {
    const trimmed = value.trim();
    if (!trimmed) {
      return this.owner && this.defaultRepo ? { owner: this.owner, repo: this.defaultRepo } : null;
    }
    const segments = trimmed.split("/");
    if (segments.length === 2 && segments.every(isNameSegment)) {
      return { owner: segments[0], repo: segments[1] };
    }
    if (segments.length === 1 && this.owner && isNameSegment(segments[0])) {
      return { owner: this.owner, repo: segments[0] };
    }
    return null;
  }

  /** Accepts "owner/repo#123", "repo#123", "#123", "123", or a github.com issue/pull URL. */
  private parseIssueRef(rawId: string): IssueRef | null {
    const value = rawId.trim();
    if (!value) return null;
    if (/^https?:\/\//i.test(value)) return parseIssueUrl(value);

    const parts = value.split("#");
    if (parts.length > 2) return null;
    const number = parsePositiveInt(parts.length === 2 ? parts[1] : parts[0]);
    if (number === null) return null;

    const repo = this.resolveRepo(parts.length === 2 ? parts[0] : "");
    return repo ? { ...repo, number } : null;
  }

  private parsePRRepo(pr: PRRef): RepoRef | null {
    return this.resolveRepo(pr.repoId?.trim() || pr.repoName?.trim() || "");
  }

  getWorkItemUrl(id: string): string {
    const ref = this.parseIssueRef(id);
    return ref ? issueWebUrl(ref) : NO_URL;
  }

  getPullRequestUrl(pr: PRRef): string {
    const ref = this.parsePRRepo(pr);
    const prId = parsePositiveInt(pr.prId);
    return ref && prId !== null ? prWebUrl(ref, prId) : NO_URL;
  }

  async fetchWorkItems(ids: string[]): Promise<EnrichedWorkItem[]> {
    if (ids.length === 0) return [];

    const now = Date.now();
    const parsed = ids.map((id) => ({ id, ref: this.parseIssueRef(id) }));
    const pending = new Map<string, IssueRef>();
    for (const { ref } of parsed) {
      if (!ref) continue;
      const key = issueKey(ref);
      if (!issueCache.read(key, now)) pending.set(key, ref);
    }

    const fetched = new Map<string, IssueMetadata>();
    await Promise.all([...pending].map(async ([key, ref]) => {
      fetched.set(key, await loadOnce(issueInFlight, key, () => loadIssue(key, ref)));
    }));

    // Results keep the caller's raw id so aliases of the same issue stay distinct.
    return parsed.map(({ id, ref }) => {
      const key = ref ? issueKey(ref) : null;
      const metadata = key
        ? issueCache.read(key, now) ?? fetched.get(key) ?? issueFallback(ref)
        : issueFallback(null);
      return { id, provider: "github" as const, ...metadata };
    });
  }

  async fetchPullRequests(prs: PRRef[]): Promise<EnrichedPR[]> {
    if (prs.length === 0) return [];

    const now = Date.now();
    const parsed = prs.map((pr) => {
      const prId = parsePositiveInt(pr.prId);
      const ref = prId === null ? null : this.parsePRRepo(pr);
      return { pr, ref, prId };
    });

    const pending = new Map<string, { ref: RepoRef; prId: number }>();
    for (const { ref, prId } of parsed) {
      if (!ref || prId === null) continue;
      const key = prKey(ref, prId);
      if (!prCache.read(key, now)) pending.set(key, { ref, prId });
    }

    const fetched = new Map<string, PRMetadata>();
    await Promise.all([...pending].map(async ([key, { ref, prId }]) => {
      fetched.set(key, await loadOnce(prInFlight, key, () => loadPR(key, ref, prId)));
    }));

    return parsed.map(({ pr, ref, prId }) => {
      const key = ref && prId !== null ? prKey(ref, prId) : null;
      const metadata = key
        ? prCache.read(key, now) ?? fetched.get(key) ?? prFallback(ref, prId, pr.repoName)
        : prFallback(ref, prId, pr.repoName);
      return { repoId: pr.repoId, prId: pr.prId, provider: "github" as const, ...metadata };
    });
  }
}
