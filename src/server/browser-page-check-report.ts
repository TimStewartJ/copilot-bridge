// Opens real sites in a public browser and prints what the page check makes of each: the way to
// see whether block detection still matches what sites serve. Run with
// `npm run report:browser-blocks -- [url ...]`; without URLs it visits a list of sites that are
// known for turning automated browsers away, and a few that never do.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ab } from "./agent-browser.js";
import { BrowserBroker } from "./browser-broker.js";
import { checkPage } from "./browser-page-check.js";

const DEFAULT_URLS = [
  "https://www.g2.com/products/slack/reviews",
  "https://www.yelp.com/biz/the-french-laundry-yountville",
  "https://www.target.com/",
  "https://www.zillow.com/homes/San-Jose,-CA_rb/",
  "https://www.ebay.com/sch/i.html?_nkw=lego",
  "https://www.glassdoor.com/Reviews/index.htm",
  "https://www.crunchbase.com/organization/openai",
  "https://www.reddit.com/r/programming/",
  "https://www.amazon.com/dp/B0CHX3QBCH",
  "https://www.google.com/search?q=weather",
  "https://www.google.com/recaptcha/api2/demo",
  "https://accounts.hcaptcha.com/demo",
  "https://httpbin.org/status/403",
  "https://httpbin.org/status/503",
  "https://en.wikipedia.org/wiki/CAPTCHA",
];
/** As many pages at once as an agent opens with parallel tool calls. */
const PARALLEL = 3;

const urls = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_URLS;
const copilotHome = await mkdtemp(join(tmpdir(), "bridge-page-check-"));
const broker = new BrowserBroker({ copilotHome });
// Each agent-browser command is logged as it runs; only the report belongs on the terminal.
console.log = () => undefined;

async function report(url: string): Promise<string> {
  const startedAt = Date.now();
  try {
    const check = await broker.withEphemeralContext("public", { toolName: "page_check_report", browserOpId: "report" }, async (lease) => {
      const options = { browserTarget: lease.browserTarget, toolName: "page_check_report" };
      // A refusal without a body fails the navigation and still leaves a page to look at.
      await ab(["open", url], 45_000, options);
      return checkPage(options, { settle: true });
    });
    const signals = check.signals;
    const verdict = check.block ? `${check.block.kind.toUpperCase()} by ${check.block.by}` : signals ? "ok" : "UNREADABLE";
    return [
      new URL(url).host.padEnd(26),
      `${String(Date.now() - startedAt).padStart(6)}ms`,
      `status=${String(signals?.status ?? "?").padEnd(3)}`,
      `text=${String(signals?.textLength ?? "?").padStart(6)}`,
      `links=${String(signals?.links ?? "?").padStart(3)}`,
      `inputs=${String(signals?.inputs ?? "?").padStart(2)}`,
      verdict.padEnd(30),
      `markers=${signals?.markers.join(",") || "-"}`,
      `| ${(signals?.title ?? "").slice(0, 40)}`,
    ].join("  ");
  } catch (error) {
    return `${url}  ERROR ${String(error).slice(0, 160)}`;
  }
}

try {
  for (let index = 0; index < urls.length; index += PARALLEL) {
    const lines = await Promise.all(urls.slice(index, index + PARALLEL).map(report));
    process.stdout.write(`${lines.join("\n")}\n`);
  }
} finally {
  await rm(copilotHome, { recursive: true, force: true });
}
process.exit(0);
