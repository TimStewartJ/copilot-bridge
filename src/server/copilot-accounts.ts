import { isRecord } from "../shared/is-record.js";
import type { CopilotAccount } from "../shared/copilot-accounts.js";

/**
 * Credentials the runtime borrows rather than holds: the gh CLI's login and token environment
 * variables. Switching to them is not what the account list is for.
 */
const BORROWED_AUTH_TYPES = new Set(["gh-cli", "env"]);

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function accountKey(host: string, login: string): string {
  return `${host.replace(/\/+$/, "").toLowerCase()} ${login.toLowerCase()}`;
}

/** Usable entries of `account.getAllUsers`, keyed for quota lookups. */
export function signedInAccountIds(users: unknown): string[] {
  return toCopilotAccounts(users, undefined, new Map()).map((account) => account.id);
}

function usedPercent(quota: unknown): number | null {
  const premium = isRecord(quota) && isRecord(quota.quotaSnapshots) ? quota.quotaSnapshots.premium_interactions : undefined;
  if (!isRecord(premium) || premium.isUnlimitedEntitlement === true) return null;
  const remaining = premium.remainingPercentage;
  if (typeof remaining !== "number" || !Number.isFinite(remaining)) return null;
  return Math.min(100, Math.max(0, 100 - remaining));
}

/**
 * The runtime's `account.getAllUsers` entries as the account list shows them. The entries carry
 * tokens; only the fields named here leave this function.
 */
export function toCopilotAccounts(
  users: unknown,
  currentAuthInfo: unknown,
  quotaById: ReadonlyMap<string, unknown>,
): CopilotAccount[] {
  const current = isRecord(currentAuthInfo) ? currentAuthInfo : undefined;
  const currentLogin = text(current?.login) ?? (isRecord(current?.copilotUser) ? text(current.copilotUser.login) : null);
  const currentKey = currentLogin ? accountKey(text(current?.host) ?? "https://github.com", currentLogin) : null;
  const seen = new Set<string>();
  const accounts: CopilotAccount[] = [];
  for (const user of Array.isArray(users) ? users : []) {
    if (!isRecord(user) || !isRecord(user.authInfo)) continue;
    const info = user.authInfo;
    const id = text(user.selectionId);
    const host = text(info.host) ?? "https://github.com";
    const copilotUser = isRecord(info.copilotUser) ? info.copilotUser : undefined;
    const login = text(info.login) ?? text(copilotUser?.login);
    if (!id || !login || BORROWED_AUTH_TYPES.has(String(info.type))) continue;
    const key = accountKey(host, login);
    if (seen.has(key)) continue;
    seen.add(key);
    const organizations = Array.isArray(copilotUser?.organization_login_list)
      ? copilotUser.organization_login_list.filter((org): org is string => typeof org === "string")
      : [];
    accounts.push({
      id,
      host,
      login,
      plan: text(copilotUser?.copilot_plan),
      organizations,
      active: key === currentKey,
      usedPercent: usedPercent(quotaById.get(id)),
    });
  }
  return accounts;
}
