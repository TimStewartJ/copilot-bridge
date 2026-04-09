// browser_fetch — lightweight direct tool that uses agent-browser to fetch a
// page and return its accessibility-tree snapshot.  Sits between web_fetch
// (pure HTTP) and the full browser skill (multi-step interactive flows).

import { defineTool } from "@github/copilot-sdk";
import { execSync } from "node:child_process";

const FETCH_TIMEOUT = 30_000;

function run(cmd: string): { ok: boolean; output: string } {
  try {
    const output = execSync(cmd, { encoding: "utf-8", timeout: FETCH_TIMEOUT });
    return { ok: true, output: output.trim() };
  } catch (err: any) {
    return { ok: false, output: err.stderr || err.stdout || String(err) };
  }
}

function ab(session: string, command: string): { ok: boolean; output: string } {
  return run(`agent-browser --session ${session} ${command}`);
}

function cleanup(session: string): void {
  try {
    ab(session, "close");
  } catch {
    // best-effort
  }
}

export const BROWSER_FETCH_TOOLS = [
  defineTool("browser_fetch", {
    description:
      "Fetch a web page using a real browser and return its content as an accessibility snapshot. " +
      "Use this instead of web_fetch when a site requires JavaScript rendering, blocks bots, " +
      "returns empty/broken content via web_fetch, or is a single-page app (SPA). " +
      "For multi-step interactive flows (login, form filling, pagination), use the browser skill instead.",
    parameters: {
      type: "object" as const,
      properties: {
        url: {
          type: "string",
          description: "The URL to fetch",
        },
        selector: {
          type: "string",
          description:
            "Optional CSS selector to scope the snapshot to a specific part of the page (e.g., 'main', '#content', 'article')",
        },
      },
      required: ["url"],
    },
    handler: async (args: any) => {
      const url: string = args.url;
      const selector: string | undefined = args.selector;
      const session = `bf-${Date.now()}`;

      const check = run("which agent-browser");
      if (!check.ok) {
        return {
          error:
            "agent-browser is not installed. Install it with: npm install -g agent-browser && agent-browser install",
        };
      }

      try {
        const openResult = ab(session, `open "${url}"`);
        if (!openResult.ok) {
          cleanup(session);
          return { error: `Failed to open URL: ${openResult.output.slice(0, 200)}` };
        }

        ab(session, "wait --load networkidle");

        const scope = selector ? ` -s "${selector}"` : "";
        const snapshot = ab(session, `snapshot -i${scope}`);

        // Also grab the page title and final URL for context
        const titleResult = ab(session, "get title");
        const urlResult = ab(session, "get url");

        cleanup(session);

        if (!snapshot.ok) {
          return { error: `Failed to capture page: ${snapshot.output.slice(0, 200)}` };
        }

        return {
          url: urlResult.ok ? urlResult.output : url,
          title: titleResult.ok ? titleResult.output : undefined,
          snapshot: snapshot.output,
        };
      } catch (err: any) {
        cleanup(session);
        return { error: `Browser fetch failed: ${String(err).slice(0, 200)}` };
      }
    },
  }),
];
