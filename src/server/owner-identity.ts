// Finds the repository owner's name, read from package.json, in text bound for the public repo.
import { isRecord } from "../shared/is-record.js";

/** Who owns the repository, as package.json says: name words, and the GitHub handle and repo. */
export interface OwnerIdentity {
  names: string[];
  handle?: string;
  repo?: string;
}

const MIN_NAME_LENGTH = 2;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The owner from a package.json: name words of `author`, handle and repo of `repository`. */
export function readOwnerIdentity(packageJson: unknown): OwnerIdentity {
  const record = isRecord(packageJson) ? packageJson : {};
  const author = record.author;
  const authorName = typeof author === "string"
    ? author.replace(/<[^>]*>|\([^)]*\)/g, "")
    : isRecord(author) && typeof author.name === "string" ? author.name : "";
  const names = authorName.split(/[^\p{L}]+/u).filter((word) => word.length >= MIN_NAME_LENGTH);
  const repository = record.repository;
  const url = typeof repository === "string"
    ? repository
    : isRecord(repository) && typeof repository.url === "string" ? repository.url : "";
  const match = /(?:github\.com[/:]|^github:|^)([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?(?:[/#?]|$)/.exec(url);
  return { names, ...(match ? { handle: match[1], repo: match[2] } : {}) };
}

/** Removes the handle where it is public by design: GitHub URLs, the repo slug, the npm scope. */
function maskPublicHandle(text: string, identity: OwnerIdentity): string {
  if (!identity.handle) return text;
  const handle = escapeRegExp(identity.handle);
  const repo = identity.repo ? escapeRegExp(identity.repo) : undefined;
  const contexts = [
    `(?:github\\.com|githubusercontent\\.com)[/:]${handle}(?![A-Za-z0-9-])`,
    `@${handle}/`,
    ...(repo ? [`(?<![A-Za-z0-9-])${handle}/${repo}(?![A-Za-z0-9._-])`] : []),
  ];
  return text.replace(new RegExp(contexts.join("|"), "gi"), " ");
}

/** Identifier parts of text: split on non-letters and camelCase, so `needsAda` yields `Ada`. */
function nameTokens(text: string): string[] {
  return text
    .split(/[^\p{L}]+/u)
    .flatMap((chunk) => chunk.replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2").replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1 $2").split(" "))
    .filter(Boolean);
}

/** The first word that is the owner's name or holds their full name or handle, if any. */
export function findOwnerName(text: string, identity: OwnerIdentity): string | undefined {
  if (identity.names.length === 0 || !text) return undefined;
  const names = new Set(identity.names.map((name) => name.toLowerCase()));
  const joined = [identity.names.join("").toLowerCase(), identity.handle?.toLowerCase()]
    .filter((value): value is string => typeof value === "string" && value.length > MIN_NAME_LENGTH);
  const masked = maskPublicHandle(text, identity);
  for (const token of nameTokens(masked)) {
    const lower = token.toLowerCase();
    if (names.has(lower)) return token;
  }
  for (const chunk of masked.split(/[^\p{L}]+/u)) {
    const lower = chunk.toLowerCase();
    if (joined.some((value) => lower.includes(value))) return chunk;
  }
  return undefined;
}

/** Whether a package.json line is its `author` field, where the owner's name belongs. */
export function isAuthorLine(line: string): boolean {
  return /^\s*"author"\s*:/.test(line);
}
