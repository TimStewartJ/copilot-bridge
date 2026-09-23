const TUNNEL_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{1,58}[a-z0-9])$/;
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

/**
 * Reads `BRIDGE_TUNNEL_NAMES`. An entry written `github:<name>` names a tunnel owned
 * by a GitHub account. When the list is not set at all, a legacy `BRIDGE_TUNNEL_NAME`
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
    const github = entry.toLowerCase().startsWith(GITHUB_PREFIX);
    const name = normalizeTunnelName(github ? entry.slice(GITHUB_PREFIX.length) : entry);
    if (!name) {
      warnings.push(
        `Skipping invalid tunnel name "${entry}". Use 3-60 letters, numbers, and hyphens, starting and ending with a letter or number, optionally prefixed with "github:".`,
      );
    } else if (!tunnels.some((tunnel) => tunnel.name === name)) {
      tunnels.push({ name, auth: github ? "github" : "cli" });
    }
  }
  return { tunnels, warnings };
}
