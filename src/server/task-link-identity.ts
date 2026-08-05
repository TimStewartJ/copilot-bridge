/**
 * Shared identity resolution for task work-item and pull-request links.
 *
 * Both the MCP tools and the REST link routes go through here so the two paths
 * cannot drift, and so a link is never persisted with a guessed provider.
 *
 * `repoId` is the durable identity a row is keyed by; `repoName` is display
 * text. Callers that know the durable id (an ADO repository GUID) should pass
 * `repoId`. When only a name is available it is still accepted as the id for
 * backwards compatibility — ADO resolves a repository name where it accepts an
 * id — but GitHub references are always canonicalized to `owner/repo` first.
 */

import type { ProviderName, ProvidersConfig } from "./providers/types.js";
import { err, ok, type Result } from "./tool-results.js";

export const PROVIDER_NAMES: readonly ProviderName[] = ["ado", "github", "linear"];

const PROVIDER_LIST = PROVIDER_NAMES.join(", ");
const GITHUB_NAME_SEGMENT = /^[A-Za-z0-9._-]+$/;

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

/**
 * Canonical durable repository id for a GitHub reference.
 * Accepts a github.com URL, `owner/repo`, or a bare repo name when an owner is configured.
 */
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

/**
 * Decide which provider owns a link.
 *
 * Precedence: explicit argument, then an exact github.com URL, then the single
 * configured provider, then unambiguous GitHub shorthand. Anything still
 * ambiguous fails — a wrong provider silently produces a dead, never-enriching
 * row, so the caller is asked to say which one it means.
 */
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

/**
 * Resolve a pull request link into a durable id plus a display name.
 *
 * `repoId` is the identity the row is keyed by (an ADO repository GUID, or a
 * canonical `owner/repo` for GitHub); `repoName` is only ever display text.
 *
 * An explicit `repoId` is authoritative: canonicalization upgrades a GitHub
 * reference to `owner/repo` when it can, but never rejects an id the caller
 * supplied — rows written before canonicalization hold un-upgradable ids (a
 * bare repo name with no configured owner) and must stay relinkable.
 */
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

  if (!explicitRepoId && !repoName) {
    return err("repoName or repoId is required");
  }

  let repoId = explicitRepoId;
  if (input.provider === "github") {
    const canonical = canonicalizeGitHubRepoId(explicitRepoId || repoName, input.providers?.github?.owner);
    if (!canonical && !explicitRepoId) {
      // Only a display name to go on, and it does not name a repository —
      // refuse rather than key a row on something that can never resolve.
      return err(
        `Could not resolve "${repoName}" to a GitHub repository. Use "owner/repo" or a github.com URL.`,
      );
    }
    repoId = canonical ?? explicitRepoId;
  }
  if (!repoId) repoId = repoName;

  return ok({
    repoId,
    ...(repoName ? { repoName } : {}),
    prId: prId.value,
    provider: input.provider,
  });
}

/**
 * Repo ids an unlink should try.
 *
 * Rows written before repo ids were canonicalized hold the raw display name, so
 * every plausible spelling is offered as a candidate. A delete is still keyed by
 * task, PR number and (when known) provider, so extra candidates cannot remove
 * an unrelated row.
 */
export function pullRequestRepoIdCandidates(input: {
  repoId?: unknown;
  repoName?: unknown;
  providers?: ProvidersConfig;
}): string[] {
  const explicit = typeof input.repoId === "string" ? input.repoId.trim() : "";
  const name = typeof input.repoName === "string" ? input.repoName.trim() : "";
  const canonical = canonicalizeGitHubRepoId(explicit || name, input.providers?.github?.owner) ?? "";
  return [...new Set([explicit, name, canonical].filter(Boolean))];
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

/**
 * Full resolution for the four link operations, shared by the MCP tools and the
 * REST routes so neither can drift from these rules. Callers map the `Result`
 * onto their own failure shape (a tool failure or a 400).
 *
 * Unlink resolves a provider only when the caller named one: omitting it means
 * "unlink from every provider".
 */
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
  return ok({ repoIds, prId: prId.value, provider: provider.value });
}
