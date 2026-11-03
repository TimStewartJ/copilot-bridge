// Deploy guards: what staging_deploy refuses to merge and push. The repository is public, so a
// commit authored with a blocked email or a term from the local denylist must never reach it.
// Everything here is pure; staging-tools.ts runs git and feeds the output in.

import { isAbsolute } from "node:path";
import { isRecord } from "../shared/is-record.js";
import {
  DEPLOY_GUARD_MAX_EMAIL_PATTERNS,
  DEPLOY_GUARD_MAX_PATH_LENGTH,
  DEPLOY_GUARD_MAX_PATTERN_LENGTH,
  type DeployGuardSettings,
} from "../shared/deploy-guards.js";

export type { DeployGuardSettings } from "../shared/deploy-guards.js";

/** Validates a deployGuards value; throws an Error naming the bad field. Unset or empty is undefined. */
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

/**
 * A reason the deploy is refused. A term finding names where the term is and which denylist line
 * it is, never the term itself: the result is written to job logs and the session.
 */
export type DeployGuardFinding =
  | { kind: "email"; sha: string; field: "author" | "committer"; email: string; pattern: string }
  | { kind: "term"; where: "deploy message"; termLine: number }
  | { kind: "term"; where: "commit message" | "new file path"; sha: string; termLine: number }
  | { kind: "term"; where: "added line"; sha: string; path: string; line: number; termLine: number };

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

export function checkDeployMessage(message: string, terms: readonly DenylistTerm[]): DeployGuardFinding[] {
  const match = findDenylistTerm(message, terms);
  return match ? [{ kind: "term", where: "deploy message", termLine: match.line }] : [];
}

export function checkCommits(
  commits: readonly DeployCommit[],
  patterns: readonly string[],
  terms: readonly DenylistTerm[],
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
  }
  return findings;
}

/** `git log -p` arguments for PatchTermScanner; each commit starts with a line of RS and its sha. */
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

/**
 * Reads `git log -p` output one line at a time and records denylist terms in added lines and in
 * the paths of added files, with the commit, path and line number in the new file. Lines inside a
 * hunk are counted from its header, so an added line that looks like a header is still scanned.
 */
export class PatchTermScanner {
  readonly findings: DeployGuardFinding[] = [];
  total = 0;
  private sha = "";
  private path = "";
  private oldRemaining = 0;
  private newRemaining = 0;
  private newLine = 0;

  constructor(private readonly terms: readonly DenylistTerm[]) {}

  private record(finding: DeployGuardFinding): void {
    this.total += 1;
    if (this.findings.length < MAX_KEPT_FINDINGS) this.findings.push(finding);
  }

  push(rawLine: string): void {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (this.oldRemaining > 0 || this.newRemaining > 0) {
      const marker = line[0];
      if (marker === "+") {
        const match = findDenylistTerm(line.slice(1), this.terms);
        if (match) {
          this.record({ kind: "term", where: "added line", sha: this.sha, path: this.path, line: this.newLine, termLine: match.line });
        }
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
    if (line.startsWith("new file mode")) {
      const match = this.path ? findDenylistTerm(this.path, this.terms) : undefined;
      if (match) this.record({ kind: "term", where: "new file path", sha: this.sha, termLine: match.line });
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
  return sections.join("\n\n");
}
