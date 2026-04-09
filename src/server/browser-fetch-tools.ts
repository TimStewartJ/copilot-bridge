// browser_fetch — lightweight direct tool that uses agent-browser to fetch a
// page and return its accessibility-tree snapshot.  Sits between web_fetch
// (pure HTTP) and the full browser skill (multi-step interactive flows).

import { defineTool } from "@github/copilot-sdk";
import { run, ab } from "./agent-browser.js";

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

      const check = await run("which agent-browser");
      if (!check.ok) {
        return {
          error:
            "agent-browser is not installed. Install it with: npm install -g agent-browser && agent-browser install",
        };
      }

      try {
        const openResult = await ab(`open "${url}"`);
        if (!openResult.ok) {
          return { error: `Failed to open URL: ${openResult.output.slice(0, 200)}` };
        }

        await ab("wait --load networkidle");

        const scope = selector ? ` -s "${selector}"` : "";
        const snapshot = await ab(`snapshot -i${scope}`);

        // Also grab the page title and final URL for context
        const [titleResult, urlResult] = await Promise.all([ab("get title"), ab("get url")]);

        if (!snapshot.ok) {
          return { error: `Failed to capture page: ${snapshot.output.slice(0, 200)}` };
        }

        return {
          url: urlResult.ok ? urlResult.output : url,
          title: titleResult.ok ? titleResult.output : undefined,
          snapshot: snapshot.output,
        };
      } catch (err: any) {
        return { error: `Browser fetch failed: ${String(err).slice(0, 200)}` };
      }
    },
  }),
];
