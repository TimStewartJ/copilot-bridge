import type { McpServerConfig } from "../../api";
import { getMcpServerTransport } from "../../../mcp-config";

// The editor form owns these fields, so saving the form may replace or clear them.
const FORM_FIELDS = new Set(["type", "command", "args", "env", "executionScope", "url", "headers", "tools"]);
const LOCAL_ONLY_FIELDS = new Set(["workingDirectory"]);
const REMOTE_ONLY_FIELDS = new Set(["oauthClientId", "oauthPublicClient", "oauthGrantType", "auth"]);

/** Keep stored fields the form hides (deferTools, OAuth); drop the other transport's fields. */
export function withUneditedMcpServerFields<T extends McpServerConfig>(
  initial: McpServerConfig,
  edited: T,
): T {
  const otherTransportFields = getMcpServerTransport(edited) === "local"
    ? REMOTE_ONLY_FIELDS
    : LOCAL_ONLY_FIELDS;
  const unedited = Object.fromEntries(
    Object.entries(initial).filter(([key]) => !FORM_FIELDS.has(key) && !otherTransportFields.has(key)),
  );
  return { ...unedited, ...edited };
}
