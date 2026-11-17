// Pure checks for what staging_deploy refuses to push to the public repo; staging-tools runs git.

import { basename, isAbsolute } from "node:path";
import { isRecord } from "../shared/is-record.js";
import {
  DEPLOY_GUARD_MAX_EMAIL_PATTERNS,
  DEPLOY_GUARD_MAX_PATH_LENGTH,
  DEPLOY_GUARD_MAX_PATTERN_LENGTH,
  type DeployGuardSettings,
} from "../shared/deploy-guards.js";
import { findOwnerName, isAuthorLine, type OwnerIdentity } from "./owner-identity.js";

export type { DeployGuardSettings } from "../shared/deploy-guards.js";

/** Validates deployGuards, throwing an Error naming the bad field; unset or empty is undefined. */
export function parseDeployGuardSettings(value: unknown): DeployGuardSettings | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error("deployGuards must be an object");
  for (const key of Object.keys(value)) {
    if (key !== "blockedEmailPatterns" && key !== "denylistFile") {
      throw new Error(`deployGuards key "${key}" is not supported`);
    }
  }
  const settings: DeployGuardSettings = {};
  const patterns = value.blockedEmailPatterns;
  if (patterns !== undefined && patterns !== null) {
    if (!Array.isArray(patterns) || patterns.length > DEPLOY_GUARD_MAX_EMAIL_PATTERNS) {
      throw new Error(
        `deployGuards.blockedEmailPatterns must be a list of at most ${DEPLOY_GUARD_MAX_EMAIL_PATTERNS} patterns`,
      );
    }
    const normalized = patterns.map((pattern) => {
      const trimmed = typeof pattern === "string" ? pattern.trim() : "";
      if (!trimmed || trimmed.length > DEPLOY_GUARD_MAX_PATTERN_LENGTH) {
        throw new Error(
          `deployGuards.blockedEmailPatterns entries must be non-empty text of at most ${DEPLOY_GUARD_MAX_PATTERN_LENGTH} characters`,
        );
      }
      return trimmed;
    });
    if (normalized.length > 0) settings.blockedEmailPatterns = normalized;
  }
  const file = value.denylistFile;
  if (file !== undefined && file !== null) {
    if (typeof file !== "string") throw new Error("deployGuards.denylistFile must be a string");
    const trimmed = file.trim();
    if (trimmed) {
      if (trimmed.length > DEPLOY_GUARD_MAX_PATH_LENGTH || !isAbsolute(trimmed)) {
        throw new Error("deployGuards.denylistFile must be an absolute path");
      }
      settings.denylistFile = trimmed;
    }
  }
  return Object.keys(settings).length > 0 ? settings : undefined;
}

export function hasDeployGuards(settings: DeployGuardSettings | undefined): settings is DeployGuardSettings {
  return Boolean(settings?.blockedEmailPatterns?.length || settings?.denylistFile);
}

function emailPatternRegExp(pattern: string): RegExp {
  const source = pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${source}$`, "i");
}

/** The first pattern the email matches, or undefined. */
export function matchBlockedEmail(email: string, patterns: readonly string[]): string | undefined {
  const trimmed = email.trim();
  if (!trimmed) return undefined;
  return patterns.find((pattern) => emailPatternRegExp(pattern).test(trimmed));
}

/** A denylist term, lowercased, and the line of the denylist file it came from. */
export interface DenylistTerm {
  term: string;
  line: number;
}

export function parseDenylist(text: string): DenylistTerm[] {
  const terms: DenylistTerm[] = [];
  text.replace(/^\uFEFF/, "").split(/\r?\n/).forEach((raw, index) => {
    const term = raw.trim();
    if (!term || term.startsWith("#")) return;
    terms.push({ term: term.toLowerCase(), line: index + 1 });
  });
  return terms;
}

export function findDenylistTerm(text: string, terms: readonly DenylistTerm[]): DenylistTerm | undefined {
  if (terms.length === 0 || !text) return undefined;
  const lower = text.toLowerCase();
  return terms.find((entry) => lower.includes(entry.term));
}

/** A refusal reason; a term finding names where and which denylist line, never the term itself. */
export type DeployGuardFinding =
  | { kind: "email"; sha: string; field: "author" | "committer"; email: string; pattern: string }
  | { kind: "term"; where: "deploy message"; termLine: number }
  | { kind: "term"; where: "commit message" | "new file path"; sha: string; termLine: number }
  | { kind: "term"; where: "added line"; sha: string; path: string; line: number; termLine: number }
  | { kind: "owner"; where: "deploy message"; word: string }
  | { kind: "owner"; where: "commit message" | "new file path"; sha: string; word: string }
  | { kind: "owner"; where: "added line"; sha: string; path: string; line: number; word: string };

const NO_OWNER: OwnerIdentity = { names: [] };

export interface DeployCommit {
  sha: string;
  authorEmail: string;
  committerEmail: string;
  message: string;
}

/** `git log --format=` for parseCommitLog: fields split by NUL, commits ended by RS. */
export const COMMIT_LOG_FORMAT = "%H%x00%ae%x00%ce%x00%B%x1e";

export function parseCommitLog(output: string): DeployCommit[] {
  const commits: DeployCommit[] = [];
  for (const record of output.split("\x1e")) {
    const trimmed = record.replace(/^\s+/, "");
    if (!trimmed) continue;
    const [sha = "", authorEmail = "", committerEmail = "", ...rest] = trimmed.split("\0");
    commits.push({ sha: sha.trim(), authorEmail, committerEmail, message: rest.join("\0") });
  }
  return commits;
}

export function checkDeployMessage(
  message: string,
  terms: readonly DenylistTerm[],
  owner: OwnerIdentity = NO_OWNER,
): DeployGuardFinding[] {
  const findings: DeployGuardFinding[] = [];
  const match = findDenylistTerm(message, terms);
  if (match) findings.push({ kind: "term", where: "deploy message", termLine: match.line });
  const word = findOwnerName(message, owner);
  if (word) findings.push({ kind: "owner", where: "deploy message", word });
  return findings;
}

export function checkCommits(
  commits: readonly DeployCommit[],
  patterns: readonly string[],
  terms: readonly DenylistTerm[],
  owner: OwnerIdentity = NO_OWNER,
): DeployGuardFinding[] {
  const findings: DeployGuardFinding[] = [];
  for (const commit of commits) {
    for (const field of ["author", "committer"] as const) {
      const email = field === "author" ? commit.authorEmail : commit.committerEmail;
      const pattern = matchBlockedEmail(email, patterns);
      if (pattern) findings.push({ kind: "email", sha: commit.sha, field, email: email.trim(), pattern });
    }
    const match = findDenylistTerm(commit.message, terms);
    if (match) findings.push({ kind: "term", where: "commit message", sha: commit.sha, termLine: match.line });
    const word = findOwnerName(commit.message, owner);
    if (word) findings.push({ kind: "owner", where: "commit message", sha: commit.sha, word });
  }
  return findings;
}

/** `git log -p` args for PatchTermScanner; each commit starts with an RS line and its sha. */
export const PATCH_LOG_ARGS = [
  "log",
  "-p",
  "--format=%x1e%H",
  "--no-color",
  "--no-ext-diff",
  "--no-renames",
  "--no-prefix",
  "--unified=0",
] as const;

const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const MAX_KEPT_FINDINGS = 50;

function unquotePath(path: string): string {
  return path.length >= 2 && path.startsWith("\"") && path.endsWith("\"") ? path.slice(1, -1) : path;
}

/** Finds denylist terms and the owner's name in git log -p added lines and new file paths. */
export class PatchTermScanner {
  readonly findings: DeployGuardFinding[] = [];
  total = 0;
  private sha = "";
  private path = "";
  private oldRemaining = 0;
  private newRemaining = 0;
  private newLine = 0;

  constructor(
    private readonly terms: readonly DenylistTerm[],
    private readonly owner: OwnerIdentity = NO_OWNER,
  ) {}

  private record(finding: DeployGuardFinding): void {
    this.total += 1;
    if (this.findings.length < MAX_KEPT_FINDINGS) this.findings.push(finding);
  }

  push(rawLine: string): void {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (this.oldRemaining > 0 || this.newRemaining > 0) {
      const marker = line[0];
      if (marker === "+") {
        const added = line.slice(1);
        const match = findDenylistTerm(added, this.terms);
        if (match) {
          this.record({ kind: "term", where: "added line", sha: this.sha, path: this.path, line: this.newLine, termLine: match.line });
        }
        const authorField = basename(this.path) === "package.json" && isAuthorLine(added);
        const word = authorField ? undefined : findOwnerName(added, this.owner);
        if (word) this.record({ kind: "owner", where: "added line", sha: this.sha, path: this.path, line: this.newLine, word });
        this.newRemaining -= 1;
        this.newLine += 1;
      } else if (marker === "-") {
        this.oldRemaining -= 1;
      } else if (marker === " ") {
        this.oldRemaining -= 1;
        this.newRemaining -= 1;
        this.newLine += 1;
      }
      return;
    }
    if (line.startsWith("\x1e")) {
      this.sha = line.slice(1).trim();
      this.path = "";
      return;
    }
    if (line.startsWith("diff --git ")) {
      // With --no-prefix an added file's header is "diff --git <path> <path>".
      const rest = line.slice("diff --git ".length);
      const half = (rest.length - 1) / 2;
      this.path = Number.isInteger(half) && rest.slice(0, half) === rest.slice(half + 1)
        ? unquotePath(rest.slice(0, half))
        : "";
      return;
    }
    if (line.startsWith("+++ ")) {
      const path = unquotePath(line.slice(4));
      if (path !== "/dev/null") this.path = path;
      return;
    }
    // agent-text-audit: tool-output (git diff output)
    if (line.startsWith("new file mode")) {
      const match = this.path ? findDenylistTerm(this.path, this.terms) : undefined;
      if (match) this.record({ kind: "term", where: "new file path", sha: this.sha, termLine: match.line });
      const word = this.path ? findOwnerName(this.path, this.owner) : undefined;
      if (word) this.record({ kind: "owner", where: "new file path", sha: this.sha, word });
      return;
    }
    const hunk = HUNK_HEADER.exec(line);
    if (hunk) {
      this.oldRemaining = hunk[1] === undefined ? 1 : Number(hunk[1]);
      this.newLine = Number(hunk[2]);
      this.newRemaining = hunk[3] === undefined ? 1 : Number(hunk[3]);
    }
  }
}

function shortSha(sha: string): string {
  return sha.slice(0, 10);
}

function describeFinding(finding: DeployGuardFinding): string {
  if (finding.kind === "email") {
    return `${shortSha(finding.sha)} ${finding.field} email ${finding.email} matches blocked pattern ${finding.pattern}`;
  }
  if (finding.kind === "owner") {
    const word = `"${finding.word}"`;
    switch (finding.where) {
      case "deploy message":
        return `the staging_deploy message contains ${word}`;
      case "commit message":
        return `commit message ${shortSha(finding.sha)} contains ${word}`;
      case "new file path":
        return `a file added in ${shortSha(finding.sha)} has ${word} in its path`;
      case "added line":
        return `${finding.path}:${finding.line} in ${shortSha(finding.sha)} adds ${word}`;
    }
  }
  const term = `denylist line ${finding.termLine}`;
  switch (finding.where) {
    case "deploy message":
      return `the staging_deploy message contains the term on ${term}`;
    case "commit message":
      return `commit message ${shortSha(finding.sha)} contains the term on ${term}`;
    case "new file path":
      return `a file added in ${shortSha(finding.sha)} has the term on ${term} in its path (git show --name-status ${shortSha(finding.sha)})`;
    case "added line":
      return `${finding.path}:${finding.line} in ${shortSha(finding.sha)} adds the term on ${term}`;
  }
}

/** The text an agent gets when a guard refuses a deploy: what fired, where, and how to fix it. */
export function formatDeployGuardFailure(
  findings: readonly DeployGuardFinding[],
  context: { prodBranch?: string; stagingDir: string; denylistFile?: string; omitted?: number },
): string {
  const emails = findings.filter((finding) => finding.kind === "email");
  const terms = findings.filter((finding) => finding.kind === "term");
  const owners = findings.filter((finding) => finding.kind === "owner");
  const sections: string[] = [
    "Deploy guards refused this deploy. Nothing was merged or pushed; the staging worktree is intact.",
  ];
  if (emails.length > 0) {
    sections.push([
      "Blocked commit emails:",
      ...emails.map((finding) => `- ${describeFinding(finding)}`),
      `Fix: check that \`git config user.email\` in ${context.stagingDir} is not blocked, then rewrite the commits with the repository's configured identity: ` +
        `\`git rebase ${context.prodBranch ?? "<production branch>"} --exec "git commit --amend --no-edit --reset-author"\` ` +
        "(for the last commit alone, `git commit --amend --no-edit --reset-author`). Then call staging_deploy again.",
    ].join("\n"));
  }
  if (terms.length > 0) {
    const omitted = context.omitted ? [`- and ${context.omitted} more`] : [];
    // agent-text-audit: bridge-text (its own finding label)
    const inCommits = terms.some((finding) => finding.where !== "deploy message");
    const fix = inCommits
      ? "Fix: remove the term. Every commit in the range is pushed, so rewrite the commit that added it " +
        `(\`git rebase -i ${context.prodBranch ?? "<production branch>"}\` to fix up, squash or reword it) rather than only adding a commit that deletes it. ` +
        "Then call staging_deploy again."
      : "Fix: call staging_deploy again with a message that does not contain the term. Nothing was committed.";
    sections.push([
      `Denylisted terms (from ${context.denylistFile ?? "the denylist file"}; the line numbers say which term):`,
      ...terms.map((finding) => `- ${describeFinding(finding)}`),
      ...omitted,
      fix,
    ].join("\n"));
  }
  if (owners.length > 0) {
    // agent-text-audit: bridge-text (its own finding label)
    const inCommits = owners.some((finding) => finding.where !== "deploy message");
    sections.push([
      "The owner's name (package.json author), which this public repository must not contain:",
      ...owners.map((finding) => `- ${describeFinding(finding)}`),
      inCommits
        ? "Fix: write \"the user\" or a made-up name, and rewrite the commit that added it " +
          `(\`git rebase -i ${context.prodBranch ?? "<production branch>"}\`) rather than adding a commit that deletes it. ` +
          "Then call staging_deploy again."
        : "Fix: call staging_deploy again with a message that says \"the user\" instead. Nothing was committed.",
    ].join("\n"));
  }
  return sections.join("\n\n");
}
