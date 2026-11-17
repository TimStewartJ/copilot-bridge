// Tells real pages from checks, refusals and CAPTCHAs, which agents misread as broken.

import { ab, safeRecordBrowserSpan, type BrowserCommandOptions } from "./agent-browser.js";

export interface PageSignals {
  url: string;
  title: string;
  /** HTTP status of the document, 0 when the browser does not report one. */
  status: number;
  /** Length of the page's visible text, and its beginning. */
  textLength: number;
  text: string;
  /** Visible form fields and links: what a page has when it is more than a check. */
  inputs: number;
  links: number;
  /** Scripts in the page: one without any cannot turn into another page by itself. */
  scripts: number;
  /** A CAPTCHA on the page already holds an answer. */
  captchaSolved: boolean;
  /** Ids from PAGE_MARKERS whose selector matched. */
  markers: string[];
}

/** challenge: passable check page; denied: refusal; captcha: normal page with a CAPTCHA. */
export type PageBlockKind = "challenge" | "denied" | "captcha";

export interface PageBlock {
  kind: PageBlockKind;
  /** Who is asking, in words for a person: a protection vendor or "This site". */
  by: string;
  status?: number;
}

/** Markers refine and name; blocks are found without them. A `name` marker alone is no block. */
interface PageMarker {
  id: string;
  by: string;
  role: "challenge" | "denied" | "name" | "captcha";
  selector: string;
}

const PAGE_MARKERS: readonly PageMarker[] = [
  { id: "cloudflare_challenge", by: "Cloudflare", role: "challenge", selector: "#challenge-form, #challenge-error-text, #challenge-running, script[src*='/cdn-cgi/challenge-platform/'][src*='chl_page']" },
  // Also on Cloudflare's pages for an origin that is down.
  { id: "cloudflare_block", by: "Cloudflare", role: "name", selector: "#cf-error-details, .cf-error-details" },
  // These lay their check over the page's own content, so the page's text and status say nothing.
  { id: "datadome", by: "DataDome", role: "challenge", selector: "iframe[src*='captcha-delivery.com']" },
  { id: "perimeterx", by: "HUMAN Security", role: "challenge", selector: "#px-captcha, [id^='px-captcha']" },
  { id: "aws_waf", by: "AWS WAF", role: "challenge", selector: "awswaf-captcha, #captcha-container.awswaf" },
  { id: "imperva", by: "Imperva", role: "denied", selector: "iframe[src*='_Incapsula_Resource']" },
  { id: "turnstile", by: "Cloudflare Turnstile", role: "captcha", selector: "iframe[src*='challenges.cloudflare.com'], .cf-turnstile" },
  // The invisible variant scores visitors in the background and asks nothing of them.
  { id: "recaptcha", by: "reCAPTCHA", role: "captcha", selector: "iframe[src*='recaptcha'][src*='anchor']:not([src*='size=invisible'])" },
  { id: "hcaptcha", by: "hCaptcha", role: "captcha", selector: "iframe[src*='hcaptcha.com'], .h-captcha" },
  { id: "arkose", by: "Arkose Labs", role: "captcha", selector: "iframe[src*='arkoselabs.com'], iframe[src*='funcaptcha']" },
  { id: "geetest", by: "GeeTest", role: "captcha", selector: "iframe[src*='geetest.com'], .geetest_holder, .geetest_captcha" },
];

const TEXT_SAMPLE_LENGTH = 1_500;
/** A page that stands in for the content says little; real pages rarely stay under this. */
const SPARSE_TEXT_LENGTH = 1_500;
/** A bare check page links only to its vendor and the site's terms; real pages link to dozens. */
const BARE_PAGE_MAX_LINKS = 10;
const PAGE_CHECK_TIMEOUT_MS = 10_000;
const SETTLED_PAGE_CHECK_TIMEOUT_MS = 20_000;
const CHALLENGE_GRACE_MS = 5_000;

/** Settle on DOM quiet (longer if text is sparse), not network idle: ad-heavy sites never idle. */
const SETTLE_QUIET_MS = 700;
const SETTLE_SPARSE_TEXT_LENGTH = 200;
const SETTLE_SPARSE_MIN_MS = 4_000;
const SETTLE_MAX_MS = 8_000;
const SETTLE_SCRIPT = `await new Promise((resolve) => {
    const started = Date.now();
    let quiet;
    const finish = () => { observer.disconnect(); clearTimeout(quiet); clearTimeout(limit); resolve(); };
    const settled = () => {
      const length = ((document.body && document.body.innerText) || "").trim().length;
      if (length >= ${SETTLE_SPARSE_TEXT_LENGTH} || Date.now() - started >= ${SETTLE_SPARSE_MIN_MS}) finish();
      else quiet = setTimeout(settled, ${SETTLE_QUIET_MS});
    };
    const observer = new MutationObserver(() => { clearTimeout(quiet); quiet = setTimeout(settled, ${SETTLE_QUIET_MS}); });
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    quiet = setTimeout(settled, ${SETTLE_QUIET_MS});
    const limit = setTimeout(finish, ${SETTLE_MAX_MS});
  });`;

function pageSignalsScript(settle: boolean): string {
  const script = `(async () => {
  ${settle ? SETTLE_SCRIPT : ""}
  const shown = (element) => !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
  // Sites keep a protection product's container in every page, hidden until it is needed.
  const present = (element) => element.tagName === "SCRIPT" || shown(element);
  const markers = [];
  for (const [id, selector] of ${JSON.stringify(PAGE_MARKERS.map((marker) => [marker.id, marker.selector]))}) {
    try { if ([...document.querySelectorAll(selector)].some(present)) markers.push(id); } catch {}
  }
  const text = ((document.body && document.body.innerText) || "").replace(/\\s+/g, " ").trim();
  const navigation = performance.getEntriesByType("navigation")[0];
  const answers = "[name='cf-turnstile-response'], [name='g-recaptcha-response'], [name='h-captcha-response']";
  return JSON.stringify({
    url: location.href,
    title: document.title || "",
    status: (navigation && navigation.responseStatus) || 0,
    textLength: text.length,
    text: text.slice(0, ${TEXT_SAMPLE_LENGTH}),
    inputs: [...document.querySelectorAll("input:not([type=hidden]), textarea, select")].filter(shown).length,
    links: document.querySelectorAll("a[href]").length,
    scripts: document.scripts.length,
    captchaSolved: [...document.querySelectorAll(answers)].some((element) => !!element.value),
    markers,
  });
})()`;
  // Base64 survives every shell the command may pass through.
  return Buffer.from(script, "utf-8").toString("base64");
}

const PAGE_SIGNALS_SCRIPT = pageSignalsScript(false);
const SETTLED_PAGE_SIGNALS_SCRIPT = pageSignalsScript(true);

/** How a page asks for a person, from any vendor; counted only on a page that says little else. */
const HUMAN_CHECK_TEXT = new RegExp([
  "(verify|verifying|confirm|prove) (that )?you('| a)?re (a |not a )?(human|robot)",
  "are you a (robot|human)",
  "not a (robot|bot)",
  "prove your humanity",
  "bot or not",
  "unusual traffic",
  "automated (access|queries|requests)",
  "complete the security check",
  "checking your browser",
  "enable javascript and cookies to continue",
  "select all (the )?(squares|images)",
  "solve (the|this) puzzle",
].join("|"), "i");
/** Who asks, when nothing on the page names a product. */
const NO_PRODUCT = "This site";
/** The title of Cloudflare's check in every language, before and after the page has rendered. */
const INTERSTITIAL_TITLE = /^just a moment/i;

/** A block page says little and asks for a person or is a refusal; vendor markers refine that. */
export function classifyPage(signals: PageSignals): PageBlock | null {
  const found = PAGE_MARKERS.filter((marker) => signals.markers.includes(marker.id));
  const product = found.find((marker) => marker.role === "challenge" || marker.role === "denied")
    ?? found.find((marker) => marker.role === "name");
  const widget = signals.captchaSolved ? undefined : found.find((marker) => marker.role === "captcha");
  const sparse = signals.textLength < SPARSE_TEXT_LENGTH;
  const status = signals.status || undefined;
  const block = (kind: PageBlockKind, by: string): PageBlock => ({ kind, by, ...(status ? { status } : {}) });

  if (product?.role === "challenge") return block("challenge", product.by);
  // A refusal that shows a CAPTCHA can be passed.
  if (product?.role === "denied") return block(widget ? "challenge" : "denied", product.by);
  if (sparse) {
    const refused = signals.status === 403 || signals.status === 429;
    // A check page links to little; a post or results page using the same words links to a lot.
    const bare = signals.links < BARE_PAGE_MAX_LINKS;
    if (INTERSTITIAL_TITLE.test(signals.title)) return block("challenge", product?.by ?? "Cloudflare");
    if ((bare || refused) && HUMAN_CHECK_TEXT.test(`${signals.title} ${signals.text}`)) {
      return block("challenge", product?.by ?? NO_PRODUCT);
    }
    // A CAPTCHA alone is a check; with fields around it, it is one step of a form.
    if (widget && bare && signals.inputs === 0) return block("challenge", product?.by ?? widget.by);
    // Not 503: a site that is down says the same.
    if (refused) return block(widget ? "challenge" : "denied", product?.by ?? NO_PRODUCT);
  }
  return widget ? block("captcha", widget.by) : null;
}

function parsePageSignals(output: string): PageSignals | undefined {
  try {
    const parsed = JSON.parse(output) as Partial<PageSignals> | null;
    if (!parsed || typeof parsed.url !== "string" || !Array.isArray(parsed.markers)) return undefined;
    return {
      url: parsed.url,
      title: typeof parsed.title === "string" ? parsed.title : "",
      status: typeof parsed.status === "number" ? parsed.status : 0,
      textLength: typeof parsed.textLength === "number" ? parsed.textLength : 0,
      text: typeof parsed.text === "string" ? parsed.text : "",
      inputs: typeof parsed.inputs === "number" ? parsed.inputs : 0,
      links: typeof parsed.links === "number" ? parsed.links : 0,
      scripts: typeof parsed.scripts === "number" ? parsed.scripts : 0,
      captchaSolved: parsed.captchaSolved === true,
      markers: parsed.markers.filter((marker): marker is string => typeof marker === "string"),
    };
  } catch {
    return undefined;
  }
}

export interface PageCheck {
  /** Absent when the page could not be read; nothing is concluded then. */
  signals?: PageSignals;
  block: PageBlock | null;
}

/** Whether the site blocks the agent; with `settle`, first waits for the page to stop changing. */
export async function checkPage(
  commandOptions: BrowserCommandOptions,
  options: { settle?: boolean } = {},
): Promise<PageCheck> {
  const run = (settle: boolean) => ab(
    ["eval", "-b", settle ? SETTLED_PAGE_SIGNALS_SCRIPT : PAGE_SIGNALS_SCRIPT],
    settle ? SETTLED_PAGE_CHECK_TIMEOUT_MS : PAGE_CHECK_TIMEOUT_MS,
    { ...commandOptions, skipRecovery: true },
  );
  const read = async (settle: boolean): Promise<PageSignals | undefined> => {
    let result = await run(settle);
    if (!result.ok && settle) {
      // Navigating while settling kills the wait script: wait once more, then read the page as is.
      result = await run(true);
      if (!result.ok) result = await run(false);
    }
    return result.ok ? parsePageSignals(result.output) : undefined;
  };
  let signals = await read(options.settle === true);
  if (!signals) return { block: null };
  let block = classifyPage(signals);
  if (options.settle && block && block.kind !== "captcha" && (block.kind === "challenge" || signals.scripts > 0)) {
    // Many checks clear by themselves in seconds; recheck before reporting a block.
    await new Promise<void>((resolve) => setTimeout(resolve, CHALLENGE_GRACE_MS));
    signals = await read(true);
    // The page went somewhere else and cannot be read: what it was is no longer what it is.
    if (!signals) return { block: null };
    block = classifyPage(signals);
  }
  if (block) {
    let urlHost: string | undefined;
    try {
      urlHost = new URL(signals.url).host;
    } catch {
      urlHost = undefined;
    }
    safeRecordBrowserSpan(commandOptions.telemetryStore, "browser.page.blocked", 0, {
      browserOpId: commandOptions.browserOpId,
      toolName: commandOptions.toolName,
      browserSession: commandOptions.browserTarget?.sessionName,
      urlHost,
      kind: block.kind,
      by: block.by,
      status: block.status,
    });
  }
  return { signals, block };
}

export interface PageBlockNotice {
  kind: PageBlockKind;
  by: string;
  guidance: string;
}

const REPORT_INSTEAD = "Otherwise use another source and say that this site blocked automated access.";

/** What an agent should do about a block; without browserSessionId the browser is already gone. */
export function describePageBlock(block: PageBlock, browserSessionId?: string): PageBlockNotice {
  const status = block.status && block.status >= 400 ? ` (HTTP ${block.status})` : "";
  const handoff = browserSessionId
    ? `call browser_session_handoff with browserSessionId ${browserSessionId} so the user can do it in the live browser`
    : "open the page in a browser session (browser_session_start, then browser_session_exec) and call "
      + "browser_session_handoff so the user can do it in the live browser";
  let guidance: string;
  if (block.kind === "challenge") {
    guidance = `${block.by} is showing a human check instead of the content${status}. Repeating the same call will not `
      + `get past it. To get through, ${handoff}. ${REPORT_INSTEAD}`;
  } else if (block.kind === "denied" && block.status === 429) {
    guidance = `${block.by} answered that it is getting too many requests${status}. Repeating the call now will not `
      + "help; try this site again later, or use another source.";
  } else if (block.kind === "denied" && block.by === NO_PRODUCT) {
    // Nothing says why: a site refusing automation answers like one that wants a sign-in.
    guidance = `${block.by} refused this request${status} and the page offers nothing to pass. Repeating the same call `
      + `will not help. If the page needs an account or a permission the user has, ${handoff.replace("do it in", "sign in through")}. `
      + "Otherwise use another source and say that this site refused access.";
  } else if (block.kind === "denied") {
    guidance = `${block.by} refused this browser${status} and offers no check to pass, so repeating the call or `
      + `handing the browser to the user will not help. Use another source and say that this site blocked automated access.`;
  } else {
    guidance = `This page has a CAPTCHA (${block.by}), which needs a person. The rest of the page can be used as `
      + `usual; before the step it protects, ${handoff}.`;
  }
  return { kind: block.kind, by: block.by, guidance };
}

/** The fields a tool result carries for a page check: `blocked`, `captcha`, or nothing. */
export interface PageBlockFields {
  blocked?: PageBlockNotice;
  captcha?: PageBlockNotice;
}

export function pageBlockFields(check: PageCheck, browserSessionId?: string): PageBlockFields {
  if (!check.block) return {};
  const notice = describePageBlock(check.block, browserSessionId);
  return check.block.kind === "captcha" ? { captcha: notice } : { blocked: notice };
}
