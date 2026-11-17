/** Sole owner of work item id normalization; task_work_items.itemId matches the exact string. */

import { canonicalizeGitHubWorkItemId } from "./providers/github.js";

/** Textual, not via `Number`, which collapses distinct ids above `Number.MAX_SAFE_INTEGER`. */
function stripLeadingZeroes(value: string): string {
  const stripped = value.replace(/^0+/, "");
  return stripped === "" ? "0" : stripped;
}

/** Normalizes numeric IDs ("00123" → "123") and GitHub refs (URL → "owner/repo#123"). */
export function normalizeWorkItemIdValue(id: string): string {
  const trimmed = canonicalizeGitHubWorkItemId(id);
  if (/^\d+$/.test(trimmed)) return stripLeadingZeroes(trimmed);
  return trimmed;
}
