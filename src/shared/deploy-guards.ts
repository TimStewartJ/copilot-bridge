/** Checks staging_deploy runs on the commits it is about to merge and push; see src/server/deploy-guards.ts. */
export interface DeployGuardSettings {
  /** Author and committer emails that block a deploy, matched case-insensitively; `*` matches any run of characters. */
  blockedEmailPatterns?: string[];
  /** Absolute path to a local text file with one blocked term per line; `#` starts a comment line. */
  denylistFile?: string;
}

export const DEPLOY_GUARD_MAX_EMAIL_PATTERNS = 20;
export const DEPLOY_GUARD_MAX_PATTERN_LENGTH = 200;
export const DEPLOY_GUARD_MAX_PATH_LENGTH = 1_000;
