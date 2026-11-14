const TUNNEL_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{1,58}[a-z0-9])$/;
const GITHUB_ACCOUNT_RE = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;
// agent-text-audit: format (environment flag)
const OFF_RE = /^(0|false|no|off)$/i;
const GITHUB_PREFIX = "github:";

/**
 * How the launcher authenticates `devtunnel host`. `cli` uses the devtunnel CLI's own
 * login. `github` is for a tunnel owned by a GitHub account: the launcher mints a host
 * token with the GitHub credential Git Credential Manager already stores, so this tunnel
 * can run next to tunnels owned by the CLI's Microsoft login.
 */
export type TunnelHostAuthKind = "cli" | "github";

export type TunnelSpec = {
  name: string;
  auth: TunnelHostAuthKind;
  /**
   * GitHub account whose stored credential hosts a `github` tunnel. Without one, the
   * credential helper's default github.com account is used.
   */
  githubAccount?: string;
};

export type TunnelConfig = {
  /**
   * Persistent dev tunnels the launcher hosts. The first is the primary one whose URL
   * the Bridge publishes for links. Empty means the launcher hosts no tunnel.
   */
  tunnels: TunnelSpec[];
  /** Configuration problems and deprecation notes for the launcher log. */
  warnings: string[];
};

export function normalizeTunnelName(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return TUNNEL_NAME_RE.test(normalized) ? normalized : null;
}

/** Formats a tunnel the way `BRIDGE_TUNNEL_NAMES` lists it. */
export function formatTunnelSpec(tunnel: TunnelSpec): string {
  if (tunnel.auth !== "github") return tunnel.name;
  return tunnel.githubAccount ? `${GITHUB_PREFIX}${tunnel.githubAccount}/${tunnel.name}` : `${GITHUB_PREFIX}${tunnel.name}`;
}

function parseTunnelEntry(entry: string): TunnelSpec | null {
  if (!entry.toLowerCase().startsWith(GITHUB_PREFIX)) {
    const name = normalizeTunnelName(entry);
    return name ? { name, auth: "cli" } : null;
  }
  const rest = entry.slice(GITHUB_PREFIX.length);
  const slash = rest.indexOf("/");
  const name = normalizeTunnelName(slash < 0 ? rest : rest.slice(slash + 1));
  if (!name) return null;
  if (slash < 0) return { name, auth: "github" };
  const githubAccount = rest.slice(0, slash);
  return GITHUB_ACCOUNT_RE.test(githubAccount) ? { name, auth: "github", githubAccount } : null;
}

/**
 * Reads `BRIDGE_TUNNEL_NAMES`. An entry written `github:<name>` names a tunnel owned
 * by a GitHub account, and `github:<account>/<name>` also says which stored GitHub
 * credential hosts it. When the list is not set at all, a legacy `BRIDGE_TUNNEL_NAME`
 * still names a single tunnel unless `BRIDGE_ENABLE_TUNNEL` turns it off, so existing
 * installs keep their tunnel. Invalid names are reported and skipped.
 */
export function resolveTunnelConfig(env: NodeJS.ProcessEnv = process.env): TunnelConfig {
  const warnings: string[] = [];
  const legacyName = env.BRIDGE_TUNNEL_NAME?.trim() ?? "";
  const legacyEnable = env.BRIDGE_ENABLE_TUNNEL?.trim() ?? "";
  let entries: string[];
  if (env.BRIDGE_TUNNEL_NAMES === undefined) {
    if (!legacyName || OFF_RE.test(legacyEnable)) return { tunnels: [], warnings };
    warnings.push("BRIDGE_TUNNEL_NAME is deprecated; rename it to BRIDGE_TUNNEL_NAMES");
    entries = [legacyName];
  } else {
    if (legacyName || legacyEnable) {
      warnings.push("BRIDGE_TUNNEL_NAMES is set, so BRIDGE_TUNNEL_NAME and BRIDGE_ENABLE_TUNNEL are ignored");
    }
    entries = env.BRIDGE_TUNNEL_NAMES.split(/[\s,]+/).filter(Boolean);
  }

  const tunnels: TunnelSpec[] = [];
  for (const entry of entries) {
    const tunnel = parseTunnelEntry(entry);
    if (!tunnel) {
      warnings.push(
        `Skipping invalid tunnel name "${entry}". Use 3-60 letters, numbers, and hyphens, starting and ending with a letter or number, optionally prefixed with "github:" or "github:<GitHub account>/".`,
      );
    } else if (!tunnels.some((existing) => existing.name === tunnel.name)) {
      tunnels.push(tunnel);
    }
  }
  return { tunnels, warnings };
}
