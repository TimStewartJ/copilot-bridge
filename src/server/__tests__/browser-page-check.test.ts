import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ab, BrowserCommandOptions, BrowserCommandResult } from "../agent-browser.js";
import type { PageBlock, PageSignals } from "../browser-page-check.js";
import type { TelemetryStore } from "../telemetry-store.js";
import { testPath } from "./test-paths.js";

const abMock = vi.hoisted(() => vi.fn<typeof ab>());

// Only the command runner is replaced; the span goes through the real telemetry path.
vi.mock("../agent-browser.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agent-browser.js")>()),
  ab: abMock,
}));

const { checkPage, classifyPage, describePageBlock } = await import("../browser-page-check.js");

/** How much of the page's text the page script returns. */
const TEXT_SAMPLE_LENGTH = 1_500;

const ARTICLE_BODY = "The dough rests overnight in the fridge, which slows the yeast and gives the lactic bacteria time to "
  + "work. In the morning it is shaped, left on the counter until it springs back slowly when pressed, and baked in a "
  + "covered pot so the steam keeps the crust soft for the first twenty minutes. Readers often ask whether the flour "
  + "matters: it does, though less than the temperature of the kitchen and the age of the starter. A wholemeal starter "
  + "ferments faster than a white one and brings a sharper taste. Leave a comment below with your results. Related "
  + "articles: Baking with rye. How to keep a starter alive on holiday. Ten mistakes every beginner makes.";

/**
 * Signals as the page script reports them: whitespace collapsed, the text cut to its beginning.
 * `textLength` makes the page that long by continuing `text` with ordinary prose. `scripts`
 * matters only to checkPage's second read, so pages have none unless a test says so.
 */
function page(signals: Partial<PageSignals> & { text: string }): PageSignals {
  let text = signals.text.replace(/\s+/g, " ").trim();
  while (text.length < (signals.textLength ?? 0)) text += ` ${ARTICLE_BODY}`;
  if (signals.textLength !== undefined) text = text.slice(0, signals.textLength);
  return {
    url: "https://www.example.com/",
    title: "",
    status: 200,
    inputs: 0,
    links: 0,
    scripts: 0,
    captchaSolved: false,
    markers: [],
    ...signals,
    textLength: text.length,
    text: text.slice(0, TEXT_SAMPLE_LENGTH),
  };
}

const SITE_HEADER = "Example Home Products Pricing Blog About Contact Sign in";
const CLOUDFLARE_FOOTER = "Cloudflare Ray ID: 8f2a6c1d9e3b4a57 • Your IP: Click to reveal 203.0.113.7 • Performance & security by Cloudflare";

const ordinaryArticle = page({
  url: "https://www.example.org/blog/overnight-sourdough",
  title: "Overnight sourdough for beginners – Example Bakery",
  text: `${SITE_HEADER} Overnight sourdough for beginners Published 10 March 2026`,
  textLength: 9_400,
  inputs: 1,
  links: 84,
});

const cloudflareChallenge = page({
  url: "https://www.example.com/pricing",
  title: "Just a moment...",
  status: 403,
  text: "www.example.com Verifying you are human. This may take a few seconds. www.example.com needs to review the "
    + "security of your connection before proceeding. Ray ID: 8f2a6c1d9e3b4a57 Performance & security by Cloudflare",
  links: 1,
  markers: ["cloudflare_challenge", "turnstile"],
});

const googleSorry = page({
  url: "https://www.google.com/sorry/index?continue=https://www.google.com/search%3Fq%3Dprivate%2Bmedical%2Bquestion&q=EgTLAHEH",
  title: "https://www.google.com/search?q=private+medical+question",
  status: 429,
  text: "About this page Our systems have detected unusual traffic from your computer network. This page checks to see "
    + "if it's really you sending the requests, and not a robot. Why did this happen? IP address: 203.0.113.7 "
    + "Time: 2026-03-10T12:00:00Z URL: https://www.google.com/search?q=private+medical+question",
  links: 1,
  markers: ["recaptcha"],
});

const akamaiDenied = page({
  url: "https://www.example.com/products",
  title: "Access Denied",
  status: 403,
  text: "Access Denied You don't have permission to access \"http://www.example.com/products\" on this server. "
    + "Reference #18.2d351ab8.1741608000.a4e16ab https://errors.edgesuite.net/18.2d351ab8.1741608000.a4e16ab",
});

const contactFormWithRecaptcha = page({
  url: "https://www.example.com/contact",
  title: "Contact us – Example",
  text: `${SITE_HEADER} Contact us We answer within two working days. Name Email address Subject Message `
    + "I agree to the privacy policy Send message Visit us Example Ltd, 1 Mill Lane, Springfield. Opening hours",
  textLength: 2_600,
  inputs: 5,
  links: 41,
  markers: ["recaptcha"],
});

/** A page that is nothing but a CAPTCHA widget and a line of the site's own. */
const ticketsQueue = page({
  url: "https://tickets.example.com/queue",
  title: "One moment – Example Tickets",
  text: "Example Tickets One moment while we get you in. Privacy Terms",
  links: 2,
  markers: ["turnstile"],
});

interface ClassificationCase {
  name: string;
  signals: PageSignals;
  expected: PageBlock | null;
}

// Real pages, and what the generic rules make of them. Where no element of a protection product
// is on the page, nobody is named: the block is reported as "This site".
const classificationCases: ClassificationCase[] = [
  {
    // A site that is down says the same as one that refuses a browser.
    name: "a bare 503 page",
    signals: page({
      url: "https://www.example.com/",
      title: "503 Service Temporarily Unavailable",
      status: 503,
      text: "503 Service Temporarily Unavailable nginx/1.24.0",
    }),
    expected: null,
  },
  {
    // What a check says counts on a page that links to next to nothing: a short post, a
    // discussion or a results page uses the same words and links to a lot.
    name: "a short post titled with what a check says, among the site's links",
    signals: page({
      url: "https://blog.example.com/why-i-am-not-a-robot",
      title: "Why I am not a robot",
      text: "Why I am not a robot. Sites keep asking me to prove it, and here is what I answer.",
      links: 30,
    }),
    expected: null,
  },
  {
    name: "a refusal that asks for a person, whatever it links to (named \"This site\")",
    signals: page({
      url: "https://shop.example.com/",
      title: "Access to this page has been denied",
      status: 403,
      text: "Please verify you are a human to continue shopping.",
      links: 12,
    }),
    expected: { kind: "challenge", by: "This site", status: 403 },
  },
  {
    name: "a search engine's own picture puzzle (named \"This site\")",
    signals: page({
      url: "https://duckduckgo.com/",
      title: "DuckDuckGo",
      text: "Unfortunately, bots use DuckDuckGo too. Please complete the following challenge. Select all squares containing a duck. Images not loading?",
      inputs: 9,
      links: 2,
    }),
    expected: { kind: "challenge", by: "This site", status: 200 },
  },
  {
    // Cloudflare's 5xx pages report trouble at the site's own server; they refuse nobody.
    name: "Cloudflare's \"521: Web server is down\" page",
    signals: page({
      url: "https://www.example.com/",
      title: "www.example.com | 521: Web server is down",
      status: 521,
      text: "Web server is down Error code 521 Visit cloudflare.com for more information. 2026-03-10 12:00:00 UTC You "
        + "Browser Working Frankfurt Cloudflare Working www.example.com Host Error What happened? The web server is not "
        + "returning a connection. As a result, the web page is not displaying. What can I do? If you are a visitor of "
        + "this website: Please try again in a few minutes. If you are the owner of this website: Contact your hosting "
        + `provider letting them know your web server is not responding. Additional troubleshooting information. ${CLOUDFLARE_FOOTER}`,
      links: 3,
      // Cloudflare's 5xx pages have the same #cf-error-details element as its 1xxx pages.
      markers: ["cloudflare_block"],
    }),
    expected: null,
  },
  {
    // The navigation makes it more than a bare check; the refusal with a CAPTCHA can still be passed.
    name: "a 403 page with the site's navigation and an hCaptcha (named \"This site\")",
    signals: page({
      url: "https://www.example.net/listing/42",
      title: "Example Listings",
      status: 403,
      text: `${SITE_HEADER} Tick the box to see this listing. Terms Privacy Imprint`,
      links: 28,
      markers: ["hcaptcha"],
    }),
    expected: { kind: "challenge", by: "This site", status: 403 },
  },
  {
    // The check is a full-page overlay: the shop page under it still has all of its text.
    name: "a PerimeterX check laid over a long shop page",
    signals: page({
      url: "https://www.example-store.com/search?q=boots",
      title: "Boots – Example Store",
      text: `${SITE_HEADER} Boots 1,204 results Sort by Relevance Filter Size Colour Brand Price`,
      textLength: 8_300,
      inputs: 3,
      links: 240,
      markers: ["perimeterx"],
    }),
    expected: { kind: "challenge", by: "HUMAN Security", status: 200 },
  },
  {
    name: "an AWS WAF CAPTCHA page",
    signals: page({
      url: "https://www.example.com/account",
      title: "Human Verification",
      status: 405,
      text: "Let's confirm you are human Complete the security check before continuing. This step verifies that you are "
        + "not a bot, which helps to protect your account and prevent spam. Begin",
      markers: ["aws_waf"],
    }),
    expected: { kind: "challenge", by: "AWS WAF", status: 405 },
  },
];

describe("classifyPage", () => {
  it.each(classificationCases.map((testCase) => ({ ...testCase, verdict: testCase.expected?.kind ?? "no block" })))(
    "reads $name as $verdict",
    ({ signals, expected }) => {
      expect(classifyPage(signals)).toEqual(expected);
    },
  );

  it("reports the block page of a protection product it has never seen", () => {
    // The design goal: no element of a known product is on these pages. How little they say,
    // what they ask for and the status they come with are enough.
    const shieldWall = { url: "https://www.example.net/listing/42", title: "ShieldWall", status: 403, links: 1 };
    const check = page({ ...shieldWall, text: "ShieldWall Please verify you are human to continue. Incident 7f3a-22c1" });
    const refusal = page({ ...shieldWall, text: "ShieldWall Your request was rejected. Incident 7f3a-22c1" });

    expect(classifyPage(check)).toStrictEqual({ kind: "challenge", by: "This site", status: 403 });
    // Asking for a person is a check whatever the status.
    expect(classifyPage({ ...check, status: 200 })).toStrictEqual({ kind: "challenge", by: "This site", status: 200 });
    expect(classifyPage(refusal)).toStrictEqual({ kind: "denied", by: "This site", status: 403 });
  });

  it.each([
    "Are you a robot?",
    "We do not allow automated access to this site.",
    "CHECKING YOUR BROWSER before accessing the site",
    "Enable JavaScript and cookies to continue",
  ])("takes a page that says little more than %j for a human check", (text) => {
    expect(classifyPage(page({ text }))).toStrictEqual({ kind: "challenge", by: "This site", status: 200 });
    // The title is read as well: some checks show their wording only there.
    expect(classifyPage(page({ title: text, text: "" }))?.kind).toBe("challenge");
  });

  it("leaves the status out when the browser reports none", () => {
    expect(classifyPage({ ...cloudflareChallenge, status: 0 })).toStrictEqual({ kind: "challenge", by: "Cloudflare" });
    expect(classifyPage({ ...ordinaryArticle, status: 0 })).toBeNull();
  });

  it("looks for a block by status or wording only on a page that says little", () => {
    const wording = page({ title: "Security check", text: "Please verify you are a human to continue." });
    const interstitial = page({ title: "JUST A MOMENT...", text: "" });
    const refusal = page({ status: 403, text: "403 Forbidden" });

    for (const signals of [wording, interstitial, refusal]) {
      expect(classifyPage(page({ ...signals, textLength: 1_499 }))).not.toBeNull();
      expect(classifyPage(page({ ...signals, textLength: 1_500 }))).toBeNull();
    }
  });

  it("names the product whose element is on the page, whichever rule found the block", () => {
    // Cloudflare's #cf-error-details decides nothing by itself; it says who serves the page.
    const named = (signals: PageSignals) => classifyPage({ ...signals, markers: [...signals.markers, "cloudflare_block"] });

    expect(named(page({ text: "Please verify you are a human to continue." })))
      .toStrictEqual({ kind: "challenge", by: "Cloudflare", status: 200 });
    expect(named(ticketsQueue)).toStrictEqual({ kind: "challenge", by: "Cloudflare", status: 200 });
    expect(named(akamaiDenied)).toStrictEqual({ kind: "denied", by: "Cloudflare", status: 403 });
    expect(named(page({ text: "Welcome back." }))).toBeNull();
    // A product that says what the page is comes before one that only names it.
    expect(named(page({ text: "", markers: ["datadome"] }))?.by).toBe("DataDome");
  });

  it("reads the title of Cloudflare's check before the page's wording, and the wording before the status", () => {
    const unmarked = { ...cloudflareChallenge, markers: [] };

    expect(classifyPage(unmarked)).toStrictEqual({ kind: "challenge", by: "Cloudflare", status: 403 });
    expect(classifyPage({ ...unmarked, title: "Security check" }))
      .toStrictEqual({ kind: "challenge", by: "This site", status: 403 });
    expect(classifyPage({ ...unmarked, title: "Security check", text: "Ray ID: 8f2a6c1d9e3b4a57" }))
      .toStrictEqual({ kind: "denied", by: "This site", status: 403 });
  });

  it("lets a product's refusal decide on a page of any length, as a check only while its CAPTCHA is unsolved", () => {
    const imperva = { ...ordinaryArticle, markers: ["imperva"] };

    expect(classifyPage(imperva)).toStrictEqual({ kind: "denied", by: "Imperva", status: 200 });
    expect(classifyPage({ ...imperva, markers: ["imperva", "recaptcha"] })?.kind).toBe("challenge");
    expect(classifyPage({ ...imperva, markers: ["imperva", "recaptcha"], captchaSolved: true })?.kind).toBe("denied");
  });
});

describe("classifyPage: a CAPTCHA widget", () => {
  it.each([
    ["arkose", "Arkose Labs"],
    ["geetest", "GeeTest"],
  ])("on a bare page is a check by its vendor (%s)", (marker, vendor) => {
    expect(classifyPage({ ...ticketsQueue, markers: [marker] }))
      .toStrictEqual({ kind: "challenge", by: vendor, status: 200 });
  });

  it("is a check while the page has no form field and fewer than ten links", () => {
    expect(classifyPage({ ...ticketsQueue, links: 9 })?.kind).toBe("challenge");
    expect(classifyPage({ ...ticketsQueue, links: 10 })?.kind).toBe("captcha");
    expect(classifyPage({ ...ticketsQueue, inputs: 1 })?.kind).toBe("captcha");
  });

  it("is a CAPTCHA inside a page once the page has as much text as real pages have", () => {
    const widget = { ...ticketsQueue, markers: ["recaptcha"] };
    expect(classifyPage(page({ ...widget, textLength: 1_499 }))?.kind).toBe("challenge");
    expect(classifyPage(page({ ...widget, textLength: 1_500 }))?.kind).toBe("captcha");
  });

  it("is ignored once it holds an answer", () => {
    expect(classifyPage({ ...ticketsQueue, captchaSolved: true })).toBeNull();
    expect(classifyPage({ ...contactFormWithRecaptcha, captchaSolved: true })).toBeNull();
    // What is left of a refused page is a refusal with nothing to pass.
    expect(classifyPage({ ...ticketsQueue, status: 403, links: 28, captchaSolved: true }))
      .toStrictEqual({ kind: "denied", by: "This site", status: 403 });
  });

  it("does not hide a product's check when it holds an answer", () => {
    expect(classifyPage({ ...cloudflareChallenge, captchaSolved: true }))
      .toStrictEqual({ kind: "challenge", by: "Cloudflare", status: 403 });
  });
});

describe("checkPage", () => {
  const recordSpan = vi.fn();
  const commandOptions: BrowserCommandOptions = {
    telemetryStore: { recordSpan } as unknown as TelemetryStore,
    toolName: "browser_fetch",
    browserOpId: "op-123",
    browserTarget: { sessionName: "bridge-public-2", profileDir: testPath("browser-profiles", "public-2") },
  };
  const NAVIGATED_AWAY: BrowserCommandResult = {
    ok: false,
    output: "Execution context was destroyed, most likely because of a navigation",
  };

  function evalReturns(output: string, ok = true): void {
    abMock.mockResolvedValue({ ok, output } satisfies BrowserCommandResult);
  }

  function decodeScript(command: readonly string[]): string {
    return Buffer.from(command[2], "base64").toString("utf-8");
  }

  /** The script `checkPage` hands to the browser, with or without the wait for the page to settle. */
  async function issuedScript(options?: { settle?: boolean }): Promise<string> {
    evalReturns(JSON.stringify(ordinaryArticle));
    await checkPage(commandOptions, options);
    const script = decodeScript(abMock.mock.calls[0][0]);
    abMock.mockReset();
    recordSpan.mockReset();
    return script;
  }

  interface FakePage {
    href: string;
    title?: string;
    /** Absent for a document without a body. */
    innerText?: string;
    responseStatus?: number;
    /** Whether a laid-out element matches a marker's selector. */
    matches?: (selector: string) => boolean;
    /** Whether an element that is not laid out matches a marker's selector, and what kind of element it is. */
    hidden?: (selector: string) => "DIV" | "SCRIPT" | undefined;
    /** Form fields, each either laid out or not. */
    fields?: boolean[];
    links?: number;
    scripts?: number;
    /** The values of the answer fields CAPTCHA widgets add to a form. */
    captchaAnswers?: string[];
  }

  class IdleMutationObserver {
    observe(): void {}
    disconnect(): void {}
  }

  /**
   * Runs the page script against a stand-in for the page's globals and returns what it evaluates
   * to. The stand-in tells the script's element queries apart by what they ask for: form
   * fields, links, CAPTCHA answers, or else the elements of a protection product.
   */
  function runPageScript(script: string, fake: FakePage, mutationObserver: unknown = IdleMutationObserver): unknown {
    const element = (laidOut: boolean, tagName = "DIV") => ({
      tagName,
      offsetWidth: laidOut ? 240 : 0,
      offsetHeight: laidOut ? 32 : 0,
      getClientRects: () => (laidOut ? [{}] : []),
    });
    const document = {
      title: fake.title,
      body: fake.innerText === undefined ? null : { innerText: fake.innerText },
      documentElement: {},
      scripts: { length: fake.scripts ?? 0 },
      querySelectorAll: (selector: string) => {
        if (selector.includes("-response")) return (fake.captchaAnswers ?? []).map((value) => ({ value }));
        if (selector.includes("a[href]")) return Array.from({ length: fake.links ?? 0 }, () => ({}));
        if (selector.startsWith("input")) return (fake.fields ?? []).map((laidOut) => element(laidOut));
        const hiddenTag = fake.hidden?.(selector);
        return [
          ...(hiddenTag ? [element(false, hiddenTag)] : []),
          ...(fake.matches?.(selector) ? [element(true)] : []),
        ];
      },
    };
    const performance = {
      getEntriesByType: (type: string) =>
        type === "navigation" && fake.responseStatus !== undefined ? [{ responseStatus: fake.responseStatus }] : [],
    };
    const evaluate = new Function("document", "location", "performance", "MutationObserver", `return ${script};`);
    return evaluate(document, { href: fake.href }, performance, mutationObserver);
  }

  const ticketsGate: FakePage = {
    href: "https://tickets.example.com/queue?event=42",
    title: "One moment – Example Tickets",
    innerText: "  Example Tickets\n\n  One   moment\twhile we get you in.  \n Privacy  Terms ",
    responseStatus: 403,
    links: 2,
    scripts: 3,
    matches: (selector) => selector.includes(".cf-turnstile"),
  };
  const ticketsGateSignals: PageSignals = {
    url: "https://tickets.example.com/queue?event=42",
    title: "One moment – Example Tickets",
    status: 403,
    textLength: 61,
    text: "Example Tickets One moment while we get you in. Privacy Terms",
    inputs: 0,
    links: 2,
    scripts: 3,
    captchaSolved: false,
    markers: ["turnstile"],
  };

  beforeEach(() => {
    abMock.mockReset();
    recordSpan.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("the script it issues", () => {
    it("reports what the page shows as JSON, which checkPage reads back field for field", async () => {
      abMock.mockImplementation(async (command) => ({
        ok: true,
        output: await runPageScript(decodeScript(command), ticketsGate) as string,
      }));

      const check = await checkPage(commandOptions);

      expect(check.signals).toStrictEqual(ticketsGateSignals);
      expect(check.block).toMatchObject({ kind: "challenge", status: 403 });
    });

    it("counts the form fields that are laid out, the links, the scripts, and a CAPTCHA that holds an answer", async () => {
      const script = await issuedScript();
      const innerText = `Overnight  sourdough\n\n${"flour water salt\n".repeat(400)}`;
      const collapsed = innerText.replace(/\s+/g, " ").trim();
      const contactForm: FakePage = {
        href: "https://www.example.com/contact",
        innerText,
        fields: [true, false, true, true],
        links: 41,
        scripts: 17,
        captchaAnswers: ["", "03AFcWeA5-token"],
        matches: (selector) => selector.includes("iframe[src*='recaptcha']"),
      };

      const signals = JSON.parse(await runPageScript(script, contactForm) as string);
      const unanswered = JSON.parse(await runPageScript(script, { ...contactForm, captchaAnswers: ["", ""] }) as string);

      expect(collapsed.length).toBeGreaterThan(TEXT_SAMPLE_LENGTH);
      expect(signals.textLength).toBe(collapsed.length);
      expect(signals.text).toBe(collapsed.slice(0, TEXT_SAMPLE_LENGTH));
      expect(signals).toMatchObject({ inputs: 3, links: 41, scripts: 17, captchaSolved: true, markers: ["recaptcha"] });
      expect(unanswered.captchaSolved).toBe(false);
    });

    it("keeps the other markers when the browser rejects one selector", async () => {
      const script = await issuedScript();

      const signals = JSON.parse(await runPageScript(script, {
        ...ticketsGate,
        matches: (selector) => {
          if (selector.includes("hcaptcha")) throw new SyntaxError("not a valid selector");
          return selector.includes(".cf-turnstile") || selector.includes("captcha-delivery.com");
        },
      }) as string);

      expect(signals.markers.sort()).toEqual(["datadome", "turnstile"]);
    });

    it("leaves out a protection product's container that the page keeps hidden, but counts its script", async () => {
      const script = await issuedScript();

      const signals = JSON.parse(await runPageScript(script, {
        ...ticketsGate,
        matches: () => false,
        hidden: (selector) => {
          if (selector.includes("/cdn-cgi/challenge-platform/")) return "SCRIPT";
          return selector.includes("#px-captcha") || selector.includes(".cf-turnstile") ? "DIV" : undefined;
        },
      }) as string);

      // A script is never laid out.
      expect(signals.markers).toEqual(["cloudflare_challenge"]);
    });

    it("copes with a page that has no body, title or reported status", async () => {
      const script = await issuedScript();

      const output = await runPageScript(script, { href: "about:blank" });

      expect(JSON.parse(output as string)).toStrictEqual({
        url: "about:blank",
        title: "",
        status: 0,
        textLength: 0,
        text: "",
        inputs: 0,
        links: 0,
        scripts: 0,
        captchaSolved: false,
        markers: [],
      });
    });
  });

  describe("with settle", () => {
    /** Stands in for the browser's observer and lets the test report changes to the page. */
    function observedPage() {
      const observers: Array<{ callback: () => void; observing: boolean }> = [];
      class RecordingMutationObserver {
        private readonly entry: { callback: () => void; observing: boolean };
        constructor(callback: () => void) {
          this.entry = { callback, observing: false };
          observers.push(this.entry);
        }
        observe(): void {
          this.entry.observing = true;
        }
        disconnect(): void {
          this.entry.observing = false;
        }
      }
      return {
        MutationObserver: RecordingMutationObserver,
        observing: () => observers.filter((observer) => observer.observing).length,
        change: () => observers.filter((observer) => observer.observing).forEach((observer) => observer.callback()),
      };
    }

    /** Longer than any wait the script allows itself. */
    const LONGER_THAN_ANY_SETTLE_MS = 60_000;

    it("issues a script that waits at most eight seconds for a page that never stops changing", async () => {
      const script = await issuedScript({ settle: true });
      vi.useFakeTimers();
      const observed = observedPage();
      let output: unknown;

      const running = (runPageScript(script, ticketsGate, observed.MutationObserver) as Promise<unknown>)
        .then((value) => { output = value; });
      const ticker = setInterval(observed.change, 100);
      await vi.advanceTimersByTimeAsync(7_999);
      expect(output).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      clearInterval(ticker);
      await running;

      expect(JSON.parse(output as string)).toStrictEqual(ticketsGateSignals);
      expect(observed.observing()).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("reads a page with content as soon as it has been still for a moment, and a nearly empty one later", async () => {
      const script = await issuedScript({ settle: true });
      vi.useFakeTimers();
      const settlesAfter = async (fake: FakePage): Promise<number> => {
        const started = Date.now();
        let settledAt: number | undefined;
        const running = (runPageScript(script, fake, observedPage().MutationObserver) as Promise<unknown>)
          .then(() => { settledAt ??= Date.now(); });
        await vi.advanceTimersByTimeAsync(LONGER_THAN_ANY_SETTLE_MS);
        await running;
        return settledAt! - started;
      };

      const full = await settlesAfter({ ...ticketsGate, innerText: "Example Tickets. ".repeat(40) });
      const nearlyEmpty = await settlesAfter(ticketsGate);

      expect(full).toBeLessThan(1_000);
      // An app that has yet to load its data, or a check about to pass by itself, gets more time.
      expect(nearlyEmpty).toBeGreaterThan(full);
      expect(nearlyEmpty).toBeLessThanOrEqual(8_000);
    });

    it("reads the page once more when the first read fails, as it does when the page redirects meanwhile", async () => {
      abMock
        .mockResolvedValueOnce(NAVIGATED_AWAY)
        .mockResolvedValueOnce({ ok: true, output: JSON.stringify(akamaiDenied) });

      await expect(checkPage(commandOptions, { settle: true })).resolves.toStrictEqual({
        signals: akamaiDenied,
        block: { kind: "denied", by: "This site", status: 403 },
      });

      expect(abMock).toHaveBeenCalledTimes(2);
      expect(abMock.mock.calls[1]).toEqual(abMock.mock.calls[0]);
      expect(recordSpan).toHaveBeenCalledTimes(1);
    });

    it("reads a page that keeps navigating as it stands, without waiting a third time", async () => {
      const plainScript = await issuedScript();
      abMock
        .mockResolvedValueOnce(NAVIGATED_AWAY)
        .mockResolvedValueOnce(NAVIGATED_AWAY)
        .mockResolvedValueOnce({ ok: true, output: JSON.stringify(akamaiDenied) });

      await expect(checkPage(commandOptions, { settle: true })).resolves.toMatchObject({
        signals: akamaiDenied,
        block: { kind: "denied" },
      });

      expect(abMock).toHaveBeenCalledTimes(3);
      expect(decodeScript(abMock.mock.calls[1][0])).not.toBe(plainScript);
      expect(decodeScript(abMock.mock.calls[2][0])).toBe(plainScript);
    });

    it("concludes nothing when the page cannot be read at all", async () => {
      abMock.mockResolvedValue(NAVIGATED_AWAY);

      await expect(checkPage(commandOptions, { settle: true })).resolves.toStrictEqual({ block: null });

      expect(abMock).toHaveBeenCalledTimes(3);
      expect(recordSpan).not.toHaveBeenCalled();
    });

    it("does not read again when the first read succeeds but makes no sense", async () => {
      evalReturns("null");

      await expect(checkPage(commandOptions, { settle: true })).resolves.toStrictEqual({ block: null });

      expect(abMock).toHaveBeenCalledTimes(1);
    });

    describe("a block found after the page settled", () => {
      /** How long a check is given to pass by itself. */
      const GRACE_MS = 5_000;
      const read = (signals: PageSignals) => ({ ok: true, output: JSON.stringify(signals) });
      /** Google's /sorry page before it has rendered: a 429 that says nothing yet. */
      const refusalThatRunsScripts = page({
        url: "https://www.google.com/sorry/index?continue=https://www.google.com/search%3Fq%3Dsourdough",
        status: 429,
        text: "",
        scripts: 2,
      });

      /** Runs a settled check up to the wait, and returns how to let the wait pass. */
      async function checkUntilTheWait() {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        let check: Awaited<ReturnType<typeof checkPage>> | undefined;
        const running = checkPage(commandOptions, { settle: true }).then((value) => { check = value; });
        await vi.advanceTimersByTimeAsync(GRACE_MS - 1);
        expect(check).toBeUndefined();
        expect(abMock).toHaveBeenCalledTimes(1);
        return async () => {
          await vi.advanceTimersByTimeAsync(1);
          await running;
          return check!;
        };
      }

      it("reads a human check again five seconds later, and reports the page behind it when the check has passed by itself", async () => {
        // A check is waited for whether or not its page has scripts.
        expect(cloudflareChallenge.scripts).toBe(0);
        abMock.mockResolvedValueOnce(read(cloudflareChallenge)).mockResolvedValueOnce(read(ordinaryArticle));

        const afterTheWait = await checkUntilTheWait();

        await expect(afterTheWait()).resolves.toStrictEqual({ signals: ordinaryArticle, block: null });
        expect(abMock).toHaveBeenCalledTimes(2);
        // The second read waits for the page that replaced the check to settle as well.
        expect(abMock.mock.calls[1]).toEqual(abMock.mock.calls[0]);
        expect(recordSpan).not.toHaveBeenCalled();
      });

      it("reports, once, a human check that is still there five seconds later", async () => {
        const later = { ...cloudflareChallenge, text: `${cloudflareChallenge.text} Verification is taking longer than expected.` };
        abMock.mockResolvedValueOnce(read(cloudflareChallenge)).mockResolvedValueOnce(read(later));

        const afterTheWait = await checkUntilTheWait();

        await expect(afterTheWait()).resolves.toStrictEqual({
          signals: later,
          block: { kind: "challenge", by: "Cloudflare", status: 403 },
        });
        expect(recordSpan).toHaveBeenCalledTimes(1);
      });

      it("reads a refusal whose page runs scripts again, and reports the check it turned into", async () => {
        abMock.mockResolvedValueOnce(read(refusalThatRunsScripts)).mockResolvedValueOnce(read(googleSorry));
        expect(classifyPage(refusalThatRunsScripts)?.kind).toBe("denied");

        const afterTheWait = await checkUntilTheWait();

        await expect(afterTheWait()).resolves.toStrictEqual({
          signals: googleSorry,
          block: { kind: "challenge", by: "This site", status: 429 },
        });
        expect(recordSpan).toHaveBeenCalledTimes(1);
        expect(recordSpan.mock.calls[0][0].metadata).toMatchObject({ kind: "challenge", by: "This site" });
      });

      it("concludes nothing when the page cannot be read after the wait: what it was is not what it is", async () => {
        abMock.mockResolvedValueOnce(read(cloudflareChallenge)).mockResolvedValue(NAVIGATED_AWAY);

        const afterTheWait = await checkUntilTheWait();

        await expect(afterTheWait()).resolves.toStrictEqual({ block: null });
        expect(abMock).toHaveBeenCalledTimes(4);
        expect(recordSpan).not.toHaveBeenCalled();
      });

      it.each([
        // A page without scripts cannot turn into another page by itself.
        ["a refusal whose page has no scripts", { ...refusalThatRunsScripts, scripts: 0 }],
        ["a CAPTCHA inside a page", { ...contactFormWithRecaptcha, scripts: 24 }],
        ["an ordinary page", { ...ordinaryArticle, scripts: 24 }],
      ])("reports %s at once", async (_name, signals) => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        abMock.mockResolvedValue(read(signals));

        await expect(checkPage(commandOptions, { settle: true })).resolves.toMatchObject({ signals });

        expect(abMock).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
      });

      it("does not wait for a human check without settle: the page has been open for a while then", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        abMock.mockResolvedValue(read(cloudflareChallenge));

        await expect(checkPage(commandOptions)).resolves.toStrictEqual({
          signals: cloudflareChallenge,
          block: { kind: "challenge", by: "Cloudflare", status: 403 },
        });

        expect(abMock).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
      });
    });
  });

  it("returns a captcha and records one browser.page.blocked span for it", async () => {
    const block = { kind: "captcha", by: "reCAPTCHA", status: 200 };
    evalReturns(JSON.stringify(contactFormWithRecaptcha));

    await expect(checkPage(commandOptions)).resolves.toStrictEqual({ signals: contactFormWithRecaptcha, block });

    expect(recordSpan).toHaveBeenCalledTimes(1);
    expect(recordSpan).toHaveBeenCalledWith(expect.objectContaining({
      name: "browser.page.blocked",
      metadata: expect.objectContaining({ kind: block.kind, by: block.by, urlHost: "www.example.com" }),
    }));
  });

  it("records the host of a blocked page, not its address or text", async () => {
    evalReturns(JSON.stringify(googleSorry));

    await checkPage(commandOptions);

    const [span] = recordSpan.mock.calls[0];
    expect(span.metadata).toMatchObject({ urlHost: "www.google.com", kind: "challenge", by: "This site" });
    const recorded = JSON.stringify(span);
    expect(recorded).not.toContain("private");
    expect(recorded).not.toContain("/sorry");
    expect(recorded).not.toContain("unusual traffic");
  });

  it("reports a block when there is no telemetry store, or recording the span fails", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    recordSpan.mockImplementation(() => {
      throw new Error("telemetry database is locked");
    });
    evalReturns(JSON.stringify(cloudflareChallenge));

    for (const options of [commandOptions, { toolName: "browser_fetch" }]) {
      await expect(checkPage(options)).resolves.toMatchObject({ block: { kind: "challenge", by: "Cloudflare" } });
    }
    expect(recordSpan).toHaveBeenCalledTimes(1);
  });

  it("concludes nothing from a failed eval with output that looks like a blocked page, and does not repeat it", async () => {
    evalReturns(JSON.stringify(cloudflareChallenge), false);

    await expect(checkPage(commandOptions)).resolves.toStrictEqual({ block: null });
    expect(abMock).toHaveBeenCalledTimes(1);
    expect(abMock.mock.calls[0][2]).toMatchObject({ browserTarget: commandOptions.browserTarget, skipRecovery: true });
    expect(recordSpan).not.toHaveBeenCalled();
  });

  it.each([
    ["text that is not JSON", "ReferenceError: document is not defined"],
    ["an object without an address", JSON.stringify({ title: "Just a moment...", markers: ["cloudflare_challenge"] })],
    ["markers that are not a list", JSON.stringify({ url: "https://www.example.com/", markers: "cloudflare_challenge" })],
  ])("concludes nothing from an eval that returns %s", async (_label, output) => {
    evalReturns(output);

    await expect(checkPage(commandOptions)).resolves.toStrictEqual({ block: null });
    expect(recordSpan).not.toHaveBeenCalled();
  });

  it("fills in the fields a page left out and drops markers that are not names", async () => {
    evalReturns(JSON.stringify({
      url: "https://www.example.com/",
      title: null,
      status: "200",
      textLength: "long",
      text: 12,
      inputs: "3",
      scripts: "many",
      captchaSolved: "yes",
      markers: ["datadome", 5, null, { id: "turnstile" }],
    }));

    await expect(checkPage(commandOptions)).resolves.toStrictEqual({
      signals: {
        url: "https://www.example.com/",
        title: "",
        status: 0,
        textLength: 0,
        text: "",
        inputs: 0,
        links: 0,
        scripts: 0,
        captchaSolved: false,
        markers: ["datadome"],
      },
      block: { kind: "challenge", by: "DataDome" },
    });
  });
});

describe("describePageBlock", () => {
  const denied: PageBlock = { kind: "denied", by: "Imperva", status: 403 };
  const refusedByTheSite: PageBlock = { kind: "denied", by: "This site", status: 403 };
  it("offers no handoff for a product's refusal, with or without a browser session", () => {
    const inSession = describePageBlock(denied, "bs-42");
    const oneShot = describePageBlock(denied);

    expect(inSession.guidance).toBe(oneShot.guidance);
    expect(oneShot.guidance).not.toContain("browser_session_handoff");
    expect(oneShot.guidance).not.toContain("browser_session_start");
    expect(oneShot.guidance).toMatch(/refused/i);
    expect(oneShot.guidance).toMatch(/another source/i);
  });

  it("allows that a refusal nothing explains may only want the user signed in", () => {
    const { guidance } = describePageBlock(refusedByTheSite, "bs-42");

    expect(guidance).toMatch(/repeating the same call will not help/i);
    expect(guidance).toMatch(/sign in/i);
    expect(guidance).toContain("browser_session_handoff");
    expect(guidance).toContain("bs-42");
    expect(guidance).toMatch(/another source/i);
  });

  it("says to try again later when 'This site' answers that it gets too many requests", () => {
    const { guidance } = describePageBlock({ ...refusedByTheSite, status: 429 }, "bs-42");

    expect(guidance).toMatch(/too many requests/i);
    expect(guidance).toMatch(/later/i);
    expect(guidance).not.toContain("browser_session_handoff");
  });
});
