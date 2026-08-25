/**
 * Canonical storage form for work item identifiers.
 *
 * `task_work_items.itemId` is keyed on the exact stored string, so link, unlink,
 * and the persisted rows must all agree on one normalization. This module is the
 * single owner of that rule.
 */

import { canonicalizeGitHubWorkItemId } from "./providers/github.js";

/**
 * Strip leading zeroes textually rather than round-tripping through `Number`,
 * which silently collapses distinct identifiers above `Number.MAX_SAFE_INTEGER`.
 */
function stripLeadingZeroes(value: string): string {
  const stripped = value.replace(/^0+/, "");
  return stripped === "" ? "0" : stripped;
}

/** Normalize numeric-looking IDs (e.g. "00123" → "123") and GitHub refs (URL → "owner/repo#123"). */
export function normalizeWorkItemIdValue(id: string): string {
  const trimmed = canonicalizeGitHubWorkItemId(id);
  if (/^\d+$/.test(trimmed)) return stripLeadingZeroes(trimmed);
  return trimmed;
}
