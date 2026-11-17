/** Shared by MCP and REST: repoId keys a row (ADO GUID or owner/repo); repoName is display. */

import type { ProviderName, ProvidersConfig } from "./providers/types.js";
import { err, ok, type Result } from "./tool-results.js";

export const PROVIDER_NAMES: readonly ProviderName[] = ["ado", "github", "linear"];

const PROVIDER_LIST = PROVIDER_NAMES.join(", ");
const GITHUB_NAME_SEGMENT = /^[A-Za-z0-9._-]+$/;
const ADO_REPOSITORY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function resolveAdoRepositoryId(value: string): Result<string> {
  return ADO_REPOSITORY_ID.test(value)
    ? ok(value.toLowerCase())
    : err(
      `Azure DevOps pull requests are linked by repository GUID. Pass the pull request's repository.id as repoId instead of "${value}".`,
    );
}

export function isProviderName(value: unknown): value is ProviderName {
  return typeof value === "string" && (PROVIDER_NAMES as readonly string[]).includes(value);
}

function stripGitSuffix(segment: string): string {
  return segment.endsWith(".git") ? segment.slice(0, -4) : segment;
}

/** Parse `owner/repo` out of an exact github.com URL. Returns null for anything else. */
export function parseGitHubRepoUrl(value: string): { owner: string; repo: string } | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase();
  if (host !== "github.com" && host !== "www.github.com") return null;

  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 2) return null;
  const owner = segments[0];
  const repo = stripGitSuffix(segments[1]);
  return GITHUB_NAME_SEGMENT.test(owner) && GITHUB_NAME_SEGMENT.test(repo) ? { owner, repo } : null;
}

/** True for a bare `owner/repo` shorthand (no URL, no ref suffix). */
function isGitHubRepoShorthand(value: string): boolean {
  const segments = value.trim().split("/");
  return segments.length === 2 && segments.every((segment) => GITHUB_NAME_SEGMENT.test(segment));
}

/** True for a GitHub-shaped work item reference: `owner/repo#123`. */
function isGitHubWorkItemShorthand(value: string): boolean {
  const [repoPart, numberPart, ...rest] = value.trim().split("#");
  return rest.length === 0
    && numberPart !== undefined
    && /^\d+$/.test(numberPart)
    && isGitHubRepoShorthand(repoPart);
}

/** Durable GitHub repo id from a URL, `owner/repo`, or a bare name with a default owner. */
export function canonicalizeGitHubRepoId(value: string, defaultOwner?: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const fromUrl = parseGitHubRepoUrl(trimmed);
  if (fromUrl) return `${fromUrl.owner}/${fromUrl.repo}`;

  const segments = trimmed.split("/").map(stripGitSuffix);
  if (segments.length === 2 && segments.every((segment) => GITHUB_NAME_SEGMENT.test(segment))) {
    return `${segments[0]}/${segments[1]}`;
  }
  const owner = defaultOwner?.trim();
  if (segments.length === 1 && owner && GITHUB_NAME_SEGMENT.test(segments[0])) {
    return `${owner}/${segments[0]}`;
  }
  return null;
}

function configuredProviders(providers: ProvidersConfig | undefined): ProviderName[] {
  return PROVIDER_NAMES.filter((name) => Boolean(providers?.[name]));
}

// Explicit, github URL, sole provider, GitHub shorthand; else fail: a wrong guess is a dead row.
export function resolveLinkProvider(options: {
  explicit?: unknown;
  ref?: unknown;
  providers?: ProvidersConfig;
}): Result<ProviderName> {
  const { explicit, ref, providers } = options;

  if (explicit !== undefined && explicit !== null && explicit !== "") {
    return isProviderName(explicit)
      ? ok(explicit)
      : err(`provider must be one of: ${PROVIDER_LIST}`);
  }

  const reference = typeof ref === "string" ? ref.trim() : "";
  if (reference && parseGitHubRepoUrl(reference)) return ok("github");

  const configured = configuredProviders(providers);
  if (configured.length === 1) return ok(configured[0]);

  if (reference && (isGitHubRepoShorthand(reference) || isGitHubWorkItemShorthand(reference))) {
    return ok("github");
  }

  return err(
    `Could not determine the provider for "${reference || "this link"}". Pass provider explicitly (${PROVIDER_LIST}).`,
  );
}

/** Parse a pull request number. Accepts a number or a numeric string (REST bodies). */
export function parsePullRequestId(value: unknown): Result<number> {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() !== ""
      ? Number(value.trim())
      : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return err("prId must be a positive whole number");
  }
  return ok(parsed);
}

export interface ResolvedPullRequestLink {
  repoId: string;
  repoName?: string;
  prId: number;
  provider: ProviderName;
}

export function resolvePullRequestRef(input: {
  repoId?: unknown;
  repoName?: unknown;
  prId?: unknown;
  provider: ProviderName;
  providers?: ProvidersConfig;
}): Result<ResolvedPullRequestLink> {
  const prId = parsePullRequestId(input.prId);
  if (!prId.ok) return prId;

  const explicitRepoId = typeof input.repoId === "string" ? input.repoId.trim() : "";
  const repoName = typeof input.repoName === "string" ? input.repoName.trim() : "";

  let repoId = explicitRepoId || repoName;
  if (!repoId) {
    return err("repoName or repoId is required");
  }

  if (input.provider === "ado") {
    const adoRepoId = resolveAdoRepositoryId(repoId);
    if (!adoRepoId.ok) return adoRepoId;
    repoId = adoRepoId.value;
  }

  if (input.provider === "github") {
    const canonical = canonicalizeGitHubRepoId(repoId, input.providers?.github?.owner);
    if (!canonical) {
      // Refuse rather than key a row on something that can never resolve.
      return err(
        `Could not resolve "${repoId}" to a GitHub repository. Use "owner/repo" or a github.com URL.`,
      );
    }
    repoId = canonical;
  }

  return ok({
    repoId,
    ...(repoName ? { repoName } : {}),
    prId: prId.value,
    provider: input.provider,
  });
}

/** Also the canonical GitHub form; safe because deletes are keyed by task and PR too. */
export function pullRequestRepoIdCandidates(input: {
  repoId?: unknown;
  repoName?: unknown;
  providers?: ProvidersConfig;
}): string[] {
  const explicit = typeof input.repoId === "string" ? input.repoId.trim() : "";
  const name = typeof input.repoName === "string" ? input.repoName.trim() : "";
  const ref = explicit || name;
  if (!ref) return [];
  const canonical = canonicalizeGitHubRepoId(ref, input.providers?.github?.owner) ?? "";
  return [...new Set([ref, canonical].filter(Boolean))];
}

/** Normalize a work item reference. Accepts a string or a number. */
export function normalizeWorkItemRef(value: unknown): Result<string> {
  const ref = typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
  return ref ? ok(ref) : err("workItemId is required");
}

/** `undefined`, `null` and `""` all mean "the caller did not name a provider". */
function validateOptionalProvider(provider: unknown): Result<ProviderName | undefined> {
  if (provider === undefined || provider === null || provider === "") return ok(undefined);
  return isProviderName(provider) ? ok(provider) : err(`provider must be one of: ${PROVIDER_LIST}`);
}

export interface LinkRequest {
  workItemId?: unknown;
  repoId?: unknown;
  repoName?: unknown;
  prId?: unknown;
  provider?: unknown;
  providers?: ProvidersConfig;
}

/** Unlink without a provider unlinks from every provider. */
export function resolveWorkItemLink(request: LinkRequest): Result<{ workItemId: string; provider: ProviderName }> {
  const workItemId = normalizeWorkItemRef(request.workItemId);
  if (!workItemId.ok) return workItemId;
  const provider = resolveLinkProvider({ explicit: request.provider, ref: workItemId.value, providers: request.providers });
  if (!provider.ok) return provider;
  return ok({ workItemId: workItemId.value, provider: provider.value });
}

export function resolveWorkItemUnlink(request: LinkRequest): Result<{ workItemId: string; provider?: ProviderName }> {
  const workItemId = normalizeWorkItemRef(request.workItemId);
  if (!workItemId.ok) return workItemId;
  const provider = validateOptionalProvider(request.provider);
  if (!provider.ok) return provider;
  return ok({ workItemId: workItemId.value, provider: provider.value });
}

export function resolvePullRequestLink(request: LinkRequest): Result<ResolvedPullRequestLink> {
  const provider = resolveLinkProvider({
    explicit: request.provider,
    ref: request.repoId ?? request.repoName,
    providers: request.providers,
  });
  if (!provider.ok) return provider;
  return resolvePullRequestRef({ ...request, provider: provider.value });
}

export function resolvePullRequestUnlink(request: LinkRequest): Result<{
  repoIds: string[];
  prId: number;
  provider?: ProviderName;
}> {
  const prId = parsePullRequestId(request.prId);
  if (!prId.ok) return prId;

  // Unlink never infers: an unnamed provider means "every provider".
  const provider = validateOptionalProvider(request.provider);
  if (!provider.ok) return provider;

  const repoIds = pullRequestRepoIdCandidates(request);
  if (repoIds.length === 0) return err("repoName or repoId is required");
  if (provider.value === "ado") {
    const adoRepoId = resolveAdoRepositoryId(repoIds[0]);
    if (!adoRepoId.ok) return adoRepoId;
    return ok({ repoIds: [adoRepoId.value], prId: prId.value, provider: provider.value });
  }
  return ok({ repoIds, prId: prId.value, provider: provider.value });
}
