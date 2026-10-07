// What a person types into a sign-in form while they have a browser on show, offered back to
// them to keep for agents, as a password manager offers to save a login. One watch per browser
// session, so the offer outlasts a view that reconnects.

import { createHash } from "node:crypto";

import type { BrowserLiveLoginMessage } from "../shared/browser-live.js";
import type { BrowserCommandOptions, BrowserTarget } from "./agent-browser.js";
import { loginHost, type BrowserLogin, type BrowserLogins, type SignInForm } from "./browser-logins.js";

/**
 * Finds a page's sign-in form the way a password manager does, with nothing known about the
 * site: one visible password field that is not for a new password, and the text field before it.
 * A sign-up or change-password form has more than one, or none for the current password.
 * `bridgePassword` marks a field whose password was read, so that it is still found after the
 * page turned it into text to show the password.
 */
const FIND_SIGN_IN_FORM = `
  const shown = (e) => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
  const inputs = [...document.querySelectorAll("input")].filter(shown);
  const passwords = inputs.filter((e) => (e.type === "password" || e.bridgePassword) && e.getAttribute("autocomplete") !== "new-password");
  const password = passwords.length === 1 ? passwords[0] : null;
  const before = password
    ? inputs.filter((e) => (e.type === "text" || e.type === "email") && (!password.form || e.form === password.form) && (password.compareDocumentPosition(e) & 2)).reverse()
    : [];
  const username = before.find((e) => e.type === "email" || /username|email/.test(e.getAttribute("autocomplete") || "")) || before[0] || null;`;

const script = (result: string): string => `(() => {${FIND_SIGN_IN_FORM}\n  ${result}\n})()`;

/** An expression that is 1 on a page showing a sign-in form with both fields, else 0. */
export const SIGN_IN_FORM_PRESENT = script("return username && password ? 1 : 0;");
/** The form's address and what its two fields hold, or null. The result is a password: log it nowhere. */
export const SIGN_IN_FORM_VALUES_SCRIPT = script(
  "if (!username || !password) return null; password.bridgePassword = true; return [location.href, username.value, password.value];",
);
/** The page's address, and whether it shows a sign-in form. */
export const SIGN_IN_PAGE_SCRIPT = `[location.href, ${SIGN_IN_FORM_PRESENT}]`;
/** Empties a password field that a refused sign-in left filled. */
export const CLEAR_PASSWORD_SCRIPT = script("if (password) password.value = ''; return 0;");

export function parseSignInForm(output: string): SignInForm | undefined {
  try {
    const [url, username, password] = JSON.parse(output) as unknown[];
    return typeof url === "string" && typeof username === "string" && typeof password === "string"
      ? { url, username, password }
      : undefined;
  } catch {
    // Not quoted: what failed to parse may hold the password.
    return undefined;
  }
}

/**
 * Keys travel to the page through the browser's stream and the read through its command line,
 * so a read can overtake the last characters typed. It is repeated after this long until two
 * agree.
 */
const SETTLE_MS = 50;
const MAX_READS = 4;
/** An offer nobody answered is forgotten, and the password with it. */
const OFFER_TTL_MS = 10 * 60_000;

const same = (a: SignInForm | undefined, b: SignInForm | undefined): boolean =>
  a?.url === b?.url && a?.username === b?.username && a?.password === b?.password;
/** Tells a sign-in from another without keeping its password. */
const fingerprint = (form: SignInForm): string =>
  createHash("sha256").update(JSON.stringify([form.url, form.username, form.password])).digest("hex");

export class LoginWatch {
  private readonly listeners = new Set<(message: BrowserLiveLoginMessage) => void>();
  private typed = false;
  /** A sign-in the person typed and has not yet said what to do with. */
  private offer: { form: SignInForm; replaces: boolean; at: number } | undefined;
  /**
   * What they last declined to keep, and what they last kept: neither is offered again. "Not now"
   * holds while the form is on show, so that typing it again does not ask again; the next visit does.
   */
  private declined: string | undefined;
  private kept: { form: string; login: BrowserLogin } | undefined;
  /** Set while the view says that a login was saved. */
  private saved: BrowserLogin | undefined;
  /** The saved login of the page on show, when it shows a sign-in form. */
  private fillable: BrowserLogin | undefined;
  private failed = false;
  /** What the views were last told. A view starts out with nothing on offer. */
  private told = JSON.stringify({ type: "login", state: "none" } satisfies BrowserLiveLoginMessage);

  constructor(
    private readonly logins: BrowserLogins,
    private readonly wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  /** Tells a view what there is to offer, now and whenever it changes. */
  watch(listener: (message: BrowserLiveLoginMessage) => void): () => void {
    this.listeners.add(listener);
    const message = this.message();
    if (message.state !== "none") listener(message);
    return () => this.listeners.delete(listener);
  }

  private message(): BrowserLiveLoginMessage {
    if (this.offer && Date.now() - this.offer.at >= OFFER_TTL_MS) this.offer = undefined;
    const failed = this.failed ? { failed: true } : {};
    if (this.offer) {
      const { form, replaces } = this.offer;
      return { type: "login", state: "save", host: new URL(form.url).host, username: form.username, ...(replaces ? { replaces } : {}), ...failed };
    }
    if (this.saved) return { type: "login", state: "saved", host: loginHost(this.saved), username: this.saved.username };
    if (this.fillable) return { type: "login", state: "fill", host: loginHost(this.fillable), username: this.fillable.username, ...failed };
    return { type: "login", state: "none" };
  }

  /** `answer`: a view asked for something and waits to hear how it went, also when nothing changed. */
  private tell(answer = false): void {
    const message = this.message();
    const text = JSON.stringify(message);
    if (text === this.told && !answer) return;
    this.told = text;
    for (const listener of [...this.listeners]) listener(message);
  }

  /** A key went to the page, so its form may hold something new. */
  keyPressed(): void {
    this.typed = true;
  }

  /**
   * Called before a key or click that can submit a form reaches the page, which is the last
   * moment its fields can be read: the page is gone right after.
   */
  async submitting(read: () => Promise<SignInForm | undefined>): Promise<void> {
    if (!this.typed) return;
    this.typed = false;
    let form = await read();
    for (let reads = 1; form && reads < MAX_READS; reads++) {
      await this.wait(SETTLE_MS);
      const again = await read();
      if (same(again, form)) break;
      form = again;
    }
    if (!form?.username || !form.password || same(form, this.offer?.form)) return;
    const typed = fingerprint(form);
    if (typed === this.declined) return;
    const existing = await this.logins.forPage(form.url);
    // What was kept is offered anew once it is no longer what is saved: removed, or refused by the site.
    if (typed === this.kept?.form && existing?.savedAt === this.kept.login.savedAt && !existing.failedAt) return;
    this.offer = { form, replaces: !!existing, at: Date.now() };
    this.saved = undefined;
    this.failed = false;
    this.tell();
  }

  /** The page on show was read. */
  async pageRead(url: string, hasSignInForm: boolean): Promise<void> {
    if (!hasSignInForm) this.declined = undefined;
    const saved = hasSignInForm ? await this.logins.forPage(url) : undefined;
    // A login the site refused would be refused again; the person types it, and can save that.
    const fillable = saved?.failedAt ? undefined : saved;
    if (fillable?.id !== this.fillable?.id && !this.offer) this.failed = false;
    this.fillable = fillable;
    this.tell();
  }

  /** The person went elsewhere by the view's own controls, or another tab came on show. */
  left(): void {
    this.offer = undefined;
    this.saved = undefined;
    this.failed = false;
    this.tell();
  }

  async save(target: BrowserTarget): Promise<void> {
    const offer = this.offer;
    if (!offer) return;
    const login = await this.logins.save(offer.form, target).catch(() => undefined);
    // Another sign-in may have been typed meanwhile, and is then the one on offer.
    if (this.offer === offer) {
      this.failed = !login;
      if (login) this.offer = undefined;
    }
    if (login) {
      this.kept = { form: fingerprint(offer.form), login };
      this.saved = login;
    }
    this.tell(true);
  }

  /** Signs in on the page on show with its saved login. */
  async fill(options: BrowserCommandOptions): Promise<void> {
    const login = this.fillable;
    if (!login || this.offer) return;
    const result = await this.logins.signIn(login, options).catch(() => undefined);
    this.failed = !result?.ok;
    this.tell(true);
  }

  /** The person does not want what is offered, or has read what was said. */
  dismiss(): void {
    if (this.offer) this.declined = fingerprint(this.offer.form);
    this.offer = undefined;
    this.saved = undefined;
    this.failed = false;
    this.tell();
  }
}
