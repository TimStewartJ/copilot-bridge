const TUNNEL_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{1,58}[a-z0-9])$/;
const OFF_RE = /^(0|false|no|off)$/i;

export type TunnelConfig = {
  /**
   * Persistent dev tunnels the launcher hosts. The first is the primary one whose URL
   * the Bridge publishes for links. Empty means the launcher hosts no tunnel.
   */
  names: string[];
  /** Configuration problems and deprecation notes for the launcher log. */
  warnings: string[];
};

export function normalizeTunnelName(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return TUNNEL_NAME_RE.test(normalized) ? normalized : null;
}

/**
 * Reads `BRIDGE_TUNNEL_NAMES`. When it is not set at all, a legacy `BRIDGE_TUNNEL_NAME`
 * still names a single tunnel unless `BRIDGE_ENABLE_TUNNEL` turns it off, so existing
 * installs keep their tunnel. Invalid names are reported and skipped.
 */
export function resolveTunnelConfig(env: NodeJS.ProcessEnv = process.env): TunnelConfig {
  const warnings: string[] = [];
  const legacyName = env.BRIDGE_TUNNEL_NAME?.trim() ?? "";
  const legacyEnable = env.BRIDGE_ENABLE_TUNNEL?.trim() ?? "";
  let entries: string[];
  if (env.BRIDGE_TUNNEL_NAMES === undefined) {
    if (!legacyName || OFF_RE.test(legacyEnable)) return { names: [], warnings };
    warnings.push("BRIDGE_TUNNEL_NAME is deprecated; rename it to BRIDGE_TUNNEL_NAMES");
    entries = [legacyName];
  } else {
    if (legacyName || legacyEnable) {
      warnings.push("BRIDGE_TUNNEL_NAMES is set, so BRIDGE_TUNNEL_NAME and BRIDGE_ENABLE_TUNNEL are ignored");
    }
    entries = env.BRIDGE_TUNNEL_NAMES.split(/[\s,]+/).filter(Boolean);
  }

  const names: string[] = [];
  for (const entry of entries) {
    const name = normalizeTunnelName(entry);
    if (!name) {
      warnings.push(
        `Skipping invalid tunnel name "${entry}". Use 3-60 letters, numbers, and hyphens, starting and ending with a letter or number.`,
      );
    } else if (!names.includes(name)) {
      names.push(name);
    }
  }
  return { names, warnings };
}
