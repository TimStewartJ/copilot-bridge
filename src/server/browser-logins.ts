// Logins the user saved for the Bridge's browsers, so that an agent can sign in again when a site
// has signed out. The passwords are in agent-browser's vault, which fills them into a page
// without printing them; this module keeps the list of what is saved and for which site.

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { ab, saveAgentBrowserLogin, type BrowserCommandOptions, type BrowserCommandResult, type BrowserTarget } from "./agent-browser.js";

export interface BrowserLogin {
  /** Its name in agent-browser's vault. */
  id: string;
  /** The site it signs in to, as the origin of the page that showed the sign-in form. */
  origin: string;
  username: string;
  savedAt: string;
  /** The site did not accept it when an agent last used it. It is not tried again until it is saved anew. */
  failedAt?: string;
}

/** What a person typed into a sign-in form. */
export interface SignInForm {
  url: string;
  username: string;
  password: string;
}

/** agent-browser's vault, as far as the Bridge uses it. Tests supply their own. */
export interface BrowserLoginVault {
  save(id: string, form: SignInForm, target: BrowserTarget): Promise<{ ok: boolean; output: string }>;
  /** Fills the login into the page on show and submits it. Refuses a page of another site. */
  signIn(id: string, options: BrowserCommandOptions): Promise<BrowserCommandResult>;
  remove(id: string, options: BrowserCommandOptions): Promise<BrowserCommandResult>;
}

/** Longer than agent-browser waits for a form's fields, so its own answer arrives. */
const SIGN_IN_TIMEOUT_MS = 45_000;
const VAULT_TIMEOUT_MS = 20_000;

const agentBrowserVault: BrowserLoginVault = {
  save: (id, form, target) => saveAgentBrowserLogin(id, form, target, VAULT_TIMEOUT_MS),
  signIn: (id, options) => ab(["auth", "login", id, "--no-navigate"], SIGN_IN_TIMEOUT_MS, { ...options, skipRecovery: true }),
  remove: (id, options) => ab(["auth", "delete", id], VAULT_TIMEOUT_MS, { ...options, skipRecovery: true }),
};

function originOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}

/** The site of a login, as a person names it. */
export function loginHost(login: Pick<BrowserLogin, "origin">): string {
  return new URL(login.origin).host;
}

export class BrowserLogins {
  private readonly file: string;
  private readonly prefix: string;
  private readonly vault: BrowserLoginVault;
  private logins: Promise<BrowserLogin[]> | undefined;
  private writes: Promise<void> = Promise.resolve();

  /**
   * `file` lists the logins. The vault is the operating-system user's, shared by every Bridge
   * that user runs, so names in it start with `scope`, which tells this Bridge's from the others'.
   */
  constructor(options: { file: string; scope: string; vault?: BrowserLoginVault }) {
    this.file = options.file;
    this.prefix = `bridge-${createHash("sha1").update(options.scope).digest("hex").slice(0, 8)}-`;
    this.vault = options.vault ?? agentBrowserVault;
  }

  private read(): Promise<BrowserLogin[]> {
    // A list that is missing or cannot be read is an empty one, which the next save writes anew.
    this.logins ??= readFile(this.file, "utf-8").then((text) => {
      const listed = JSON.parse(text) as unknown;
      return Array.isArray(listed)
        ? listed.filter((login): login is BrowserLogin => typeof login?.id === "string" && login.id.startsWith(this.prefix)
          && typeof login.username === "string" && typeof login.savedAt === "string" && !!originOf(login.origin))
        : [];
    }).catch(() => []);
    return this.logins;
  }

  private change(update: (logins: BrowserLogin[]) => BrowserLogin[]): Promise<void> {
    const written = this.writes.then(async () => {
      const next = update(await this.read());
      this.logins = Promise.resolve(next);
      await mkdir(dirname(this.file), { recursive: true });
      const partial = `${this.file}.${process.pid}.tmp`;
      await writeFile(partial, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      await rename(partial, this.file);
    });
    this.writes = written.catch(() => undefined);
    return written;
  }

  async list(): Promise<BrowserLogin[]> {
    return [...await this.read()];
  }

  /** The login saved for the site of this page. */
  async forPage(url: string): Promise<BrowserLogin | undefined> {
    const origin = originOf(url);
    return origin ? (await this.read()).find((login) => login.origin === origin) : undefined;
  }

  /** Keeps a login for its site, in place of the one kept for it before. */
  async save(form: SignInForm, target: BrowserTarget): Promise<BrowserLogin | undefined> {
    const origin = originOf(form.url);
    if (!origin || !form.username || !form.password) return undefined;
    const login: BrowserLogin = {
      id: `${this.prefix}${createHash("sha1").update(origin).digest("hex").slice(0, 16)}`,
      origin,
      username: form.username,
      savedAt: new Date().toISOString(),
    };
    // The vault checks the page against this address by its origin; the rest of it, which can
    // carry one-time values, is not kept.
    const saved = await this.vault.save(login.id, { ...form, url: `${origin}/` }, target);
    if (!saved.ok) return undefined;
    await this.change((logins) => [...logins.filter((other) => other.id !== login.id), login]);
    return login;
  }

  signIn(login: BrowserLogin, options: BrowserCommandOptions): Promise<BrowserCommandResult> {
    return this.vault.signIn(login.id, options);
  }

  /** The site turned the login down. */
  markFailed(id: string): Promise<void> {
    return this.change((logins) => logins.map((login) => (login.id === id ? { ...login, failedAt: new Date().toISOString() } : login)));
  }

  /** Forgets a login. False when it is not one of this Bridge's or the vault kept it. */
  async remove(id: string, options: BrowserCommandOptions): Promise<boolean> {
    if (!(await this.read()).some((login) => login.id === id)) return false;
    const removed = await this.vault.remove(id, options);
    // A login the vault no longer has is gone all the same.
    if (!removed.ok && !/not found/i.test(removed.output)) return false;
    await this.change((logins) => logins.filter((login) => login.id !== id));
    return true;
  }
}
