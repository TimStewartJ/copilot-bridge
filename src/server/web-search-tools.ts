// Web search tool — uses agent-browser to search Google (with DuckDuckGo fallback)

import { defineTool } from "@github/copilot-sdk";
import { execSync } from "node:child_process";

const SESSION_NAME = "web-search";
const SEARCH_TIMEOUT = 30_000;

function run(cmd: string): { ok: boolean; output: string } {
  try {
    const output = execSync(cmd, { encoding: "utf-8", timeout: SEARCH_TIMEOUT });
    return { ok: true, output: output.trim() };
  } catch (err: any) {
    return { ok: false, output: err.stderr || err.stdout || String(err) };
  }
}

function ab(command: string): { ok: boolean; output: string } {
  return run(`agent-browser --session ${SESSION_NAME} ${command}`);
}

function cleanup(): void {
  try {
    ab("close");
  } catch {
    // best-effort
  }
}

// No JSON.stringify — agent-browser eval auto-serializes return values
const GOOGLE_EXTRACT_JS = `
Array.from(document.querySelectorAll('#search .g, #rso .g'))
  .map(el => {
    const linkEl = el.querySelector('a[href]');
    const titleEl = el.querySelector('h3');
    const snippetEl = el.querySelector('[data-sncf], .VwiC3b, [style*="-webkit-line-clamp"]');
    if (!linkEl || !titleEl) return null;
    const href = linkEl.getAttribute('href') || '';
    if (href.startsWith('/search') || href.startsWith('/url?') === false && !href.startsWith('http')) return null;
    const url = href.startsWith('/url?') ? new URL(href, location.origin).searchParams.get('q') || href : href;
    return {
      title: titleEl.textContent?.trim() || '',
      url,
      snippet: snippetEl?.textContent?.trim() || ''
    };
  })
  .filter(Boolean)
`;

const DDG_EXTRACT_JS = `
Array.from(document.querySelectorAll('.result, .web-result'))
  .map(el => {
    const linkEl = el.querySelector('a.result__a, a[data-testid="result-title-a"]');
    const snippetEl = el.querySelector('.result__snippet, a.result__snippet, [data-result="snippet"]');
    if (!linkEl) return null;
    let url = linkEl.getAttribute('href') || '';
    // Unwrap DuckDuckGo redirect URLs
    if (url.includes('duckduckgo.com/l/')) {
      try { url = new URL(url, location.origin).searchParams.get('uddg') || url; } catch {}
    }
    return {
      title: linkEl.textContent?.trim() || '',
      url,
      snippet: snippetEl?.textContent?.trim() || ''
    };
  })
  .filter(Boolean)
`;

function runExtraction(
  engine: "google" | "duckduckgo",
  maxResults: number,
): { results: Array<{ title: string; url: string; snippet: string }>; source: string } | { error: string } {
  const js = engine === "google" ? GOOGLE_EXTRACT_JS : DDG_EXTRACT_JS;

  let output: string;
  try {
    // Pipe JS via stdin — avoids shell escaping issues
    output = execSync(`agent-browser --session ${SESSION_NAME} eval --stdin`, {
      input: js,
      encoding: "utf-8",
      timeout: SEARCH_TIMEOUT,
    }).trim();
  } catch (err: any) {
    return { error: `Failed to extract results: ${(err.stderr || err.stdout || String(err)).slice(0, 200)}` };
  }

  try {
    let parsed = JSON.parse(output);
    // agent-browser may double-encode (string wrapping JSON)
    if (typeof parsed === "string") {
      parsed = JSON.parse(parsed);
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return { error: "No results found" };
    }
    return {
      results: parsed.slice(0, maxResults),
      source: engine,
    };
  } catch {
    return { error: `Failed to parse results: ${output.slice(0, 200)}` };
  }
}

function searchGoogle(query: string): boolean {
  const url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
  const openResult = ab(`open "${url}"`);
  if (!openResult.ok) return false;

  ab('wait --load networkidle');
  return true;
}

function searchDuckDuckGo(query: string): boolean {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const openResult = ab(`open "${url}"`);
  if (!openResult.ok) return false;

  ab('wait --load networkidle');
  return true;
}

export const WEB_SEARCH_TOOLS = [
  defineTool("web_search", {
    description:
      "Search the web using a real browser. Returns structured results (title, URL, snippet) " +
      "from Google with automatic DuckDuckGo fallback. Use this when you need to find current " +
      "information, look up documentation, research topics, or answer questions that require " +
      "up-to-date web knowledge. Requires agent-browser to be installed.",
    parameters: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "The search query",
        },
        max_results: {
          type: "number",
          description: "Maximum number of results to return (default: 5)",
        },
      },
      required: ["query"],
    },
    handler: async (args: any) => {
      const maxResults = args.max_results ?? 5;
      const query: string = args.query;

      // Check agent-browser is available
      const check = run("which agent-browser");
      if (!check.ok) {
        return {
          error:
            "agent-browser is not installed. Install it with: npm install -g agent-browser && agent-browser install",
        };
      }

      try {
        // Try Google first
        const googleOk = searchGoogle(query);
        if (googleOk) {
          const googleResults = runExtraction("google", maxResults);
          if ("results" in googleResults && googleResults.results.length > 0) {
            cleanup();
            return googleResults;
          }
        }

        // Fallback to DuckDuckGo
        const ddgOk = searchDuckDuckGo(query);
        if (!ddgOk) {
          cleanup();
          return { error: "Failed to open search engine" };
        }

        const results = runExtraction("duckduckgo", maxResults);
        cleanup();
        return results;
      } catch (err: any) {
        cleanup();
        return { error: `Search failed: ${String(err).slice(0, 200)}` };
      }
    },
  }),
];
