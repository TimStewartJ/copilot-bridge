/**
 * The runtime's built-in GitHub MCP server, by the name `disabledMcpServers` takes. The runtime
 * connects it on a session's first prompt, even when the session can use none of its tools, and
 * that prompt waits for it: measured on 6 Oct 2026 with gpt-6-luna, the first prompt of a new or
 * cold-resumed tool-less session took 1.9 to 2.5 s with it and 0.8 to 1.5 s without. Sessions
 * that cannot use GitHub tools and are answered out loud switch it off.
 */
export const BUILT_IN_GITHUB_MCP_SERVER = "github-mcp-server";
