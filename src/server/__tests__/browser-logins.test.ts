import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { BrowserLiveLoginMessage } from "../../shared/browser-live.js";
import type { BrowserTarget } from "../agent-browser.js";
import { LoginWatch, parseSignInForm } from "../browser-login-watch.js";
import { BrowserLogins, loginHost, type BrowserLoginVault, type SignInForm } from "../browser-logins.js";
import { makeTestDir } from "./helpers.js";

const TARGET: BrowserTarget = { sessionName: "test-browser", profileDir: "profile" };
const FORM: SignInForm = { url: "https://accounts.example.com/login?state=one-time", username: "tim@example.com", password: "correct horse" };

function fakeVault(overrides: Partial<BrowserLoginVault> = {}) {
  const kept = new Map<string, SignInForm>();
  const vault: BrowserLoginVault = {
    save: vi.fn(async (id, form) => {
      kept.set(id, form);
      return { ok: true, output: "" };
    }),
    signIn: vi.fn(async (id) => (kept.has(id) ? { ok: true, output: "" } : { ok: false, output: `Auth profile '${id}' not found` })),
    remove: vi.fn(async (id) => (kept.delete(id) ? { ok: true, output: "" } : { ok: false, output: `Auth profile '${id}' not found` })),
    ...overrides,
  };
  return { vault, kept };
}

function createLogins(overrides: Partial<BrowserLoginVault> = {}, dir = makeTestDir("browser-logins")) {
  const { vault, kept } = fakeVault(overrides);
  const file = join(dir, "browser-logins.json");
  return { logins: new BrowserLogins({ file, scope: dir, vault }), vault, kept, file, dir };
}

describe("BrowserLogins", () => {
  it("keeps a login for the site of the page it was typed on, without the password in its list", async () => {
    const { logins, kept, file } = createLogins();

    const login = await logins.save(FORM, TARGET);

    expect(login).toMatchObject({ origin: "https://accounts.example.com", username: "tim@example.com" });
    expect(loginHost(login!)).toBe("accounts.example.com");
    expect(login!.id).toMatch(/^bridge-[0-9a-f]{8}-[0-9a-f]{16}$/);
    // The vault gets the password and the site, not an address that held one-time values.
    expect(kept.get(login!.id)).toEqual({ ...FORM, url: "https://accounts.example.com/" });
    const written = await readFile(file, "utf-8");
    expect(written).not.toContain(FORM.password);
    expect(JSON.parse(written)).toEqual([login]);
    expect(await logins.forPage("https://accounts.example.com/other/page")).toEqual(login);
    expect(await logins.forPage("https://www.example.com/")).toBeUndefined();
    expect(await logins.forPage("not an address")).toBeUndefined();
  });

  it("replaces the login of a site and clears that it was refused", async () => {
    const { logins } = createLogins();
    const first = await logins.save(FORM, TARGET);
    await logins.markFailed(first!.id);
    expect((await logins.list())[0].failedAt).toBeTruthy();

    const second = await logins.save({ ...FORM, username: "other@example.com", password: "new" }, TARGET);

    expect(second!.id).toBe(first!.id);
    expect(await logins.list()).toEqual([second]);
    expect(second!.failedAt).toBeUndefined();
  });

  it("lists what an earlier run kept, and only this Bridge's logins", async () => {
    const first = createLogins();
    const login = await first.logins.save(FORM, TARGET);
    const stored = JSON.parse(await readFile(first.file, "utf-8")) as unknown[];
    await writeFile(first.file, JSON.stringify([...stored, { id: "bridge-other-1", origin: "https://x.example", username: "u", savedAt: "now" }, "junk"]));

    const again = createLogins({}, first.dir);

    expect(await again.logins.list()).toEqual([login]);
  });

  it("keeps nothing when the vault does not take it, or when there is nothing to sign in with", async () => {
    const { logins } = createLogins({ save: async () => ({ ok: false, output: "no" }) });

    expect(await logins.save(FORM, TARGET)).toBeUndefined();
    expect(await logins.save({ ...FORM, url: "file:///etc/passwd" }, TARGET)).toBeUndefined();
    expect(await logins.save({ ...FORM, password: "" }, TARGET)).toBeUndefined();
    expect(await logins.list()).toEqual([]);
  });

  it("treats a list it cannot read as empty, and writes it anew on the next save", async () => {
    const { logins, file } = createLogins();
    await writeFile(file, "{ not json");

    expect(await logins.list()).toEqual([]);
    const login = await logins.save(FORM, TARGET);
    expect(JSON.parse(await readFile(file, "utf-8"))).toEqual([login]);
  });

  it("removes a login, also one the vault no longer has, and nothing it does not list", async () => {
    const { logins, kept, vault } = createLogins();
    const login = await logins.save(FORM, TARGET);
    kept.clear();

    expect(await logins.remove("bridge-someone-elses", { browserTarget: TARGET })).toBe(false);
    expect(vault.remove).not.toHaveBeenCalled();
    expect(await logins.remove(login!.id, { browserTarget: TARGET })).toBe(true);
    expect(await logins.list()).toEqual([]);
  });

  it("keeps a login the vault failed to remove", async () => {
    const { logins } = createLogins({ remove: async () => ({ ok: false, output: "daemon did not answer" }) });
    const login = await logins.save(FORM, TARGET);

    expect(await logins.remove(login!.id, { browserTarget: TARGET })).toBe(false);
    expect(await logins.list()).toEqual([login]);
  });
});

describe("parseSignInForm", () => {
  it("reads what the page script returns and nothing else", () => {
    expect(parseSignInForm(JSON.stringify([FORM.url, FORM.username, FORM.password]))).toEqual(FORM);
    expect(parseSignInForm("null")).toBeUndefined();
    expect(parseSignInForm(JSON.stringify([1280, 720, FORM.url, "title"]))).toBeUndefined();
    expect(parseSignInForm("{ broken")).toBeUndefined();
  });
});

describe("LoginWatch", () => {
  function createWatch(overrides: Partial<BrowserLoginVault> = {}) {
    const { logins, vault } = createLogins(overrides);
    const watch = new LoginWatch(logins, async () => undefined);
    const told: BrowserLiveLoginMessage[] = [];
    watch.watch((message) => told.push(message));
    const reads = (...forms: Array<SignInForm | undefined>) => {
      const read = vi.fn(async () => (forms.length > 1 ? forms.shift() : forms[0]));
      return read;
    };
    return { watch, logins, vault, told, reads, last: () => told[told.length - 1] };
  }

  it("does not read the page before a click when nothing was typed", async () => {
    const { watch, reads, told } = createWatch();
    const read = reads(FORM);

    await watch.submitting(read);

    expect(read).not.toHaveBeenCalled();
    expect(told).toEqual([]);
  });

  it("offers what was typed, once two reads of the form agree", async () => {
    const { watch, reads, last } = createWatch();
    // The first read overtook the last characters on their way to the page.
    const read = reads({ ...FORM, password: "correct ho" }, FORM, FORM);
    watch.keyPressed();

    await watch.submitting(read);

    expect(read).toHaveBeenCalledTimes(3);
    expect(last()).toEqual({ type: "login", state: "save", host: "accounts.example.com", username: "tim@example.com" });
    expect(JSON.stringify(last())).not.toContain("correct");
  });

  it("offers nothing for a form with an empty field or no form at all", async () => {
    const { watch, reads, told } = createWatch();
    for (const form of [undefined, { ...FORM, password: "" }, { ...FORM, username: "" }]) {
      watch.keyPressed();
      await watch.submitting(reads(form));
    }
    expect(told).toEqual([]);
  });

  it("saves the offer when asked, says so, and does not offer the same sign-in again", async () => {
    const { watch, reads, logins, told, last } = createWatch();
    watch.keyPressed();
    await watch.submitting(reads(FORM));

    await watch.save(TARGET);

    expect(last()).toEqual({ type: "login", state: "saved", host: "accounts.example.com", username: "tim@example.com" });
    expect(await logins.list()).toHaveLength(1);
    watch.dismiss();
    expect(last()).toEqual({ type: "login", state: "none" });
    const before = told.length;
    watch.keyPressed();
    await watch.submitting(reads(FORM));
    expect(told).toHaveLength(before);
  });

  it("offers a kept sign-in again once it was removed or the site refused it", async () => {
    const { watch, reads, logins, last } = createWatch();
    watch.keyPressed();
    await watch.submitting(reads(FORM));
    await watch.save(TARGET);
    watch.dismiss();
    const login = (await logins.list())[0];

    await logins.markFailed(login.id);
    watch.keyPressed();
    await watch.submitting(reads(FORM));
    expect(last()).toMatchObject({ state: "save", replaces: true });
    await watch.save(TARGET);
    watch.dismiss();

    await logins.remove(login.id, { browserTarget: TARGET });
    watch.keyPressed();
    await watch.submitting(reads(FORM));
    expect(last()).toEqual({ type: "login", state: "save", host: "accounts.example.com", username: "tim@example.com" });
  });

  it("offers to update when another password is typed for a saved site", async () => {
    const { watch, reads, last } = createWatch();
    watch.keyPressed();
    await watch.submitting(reads(FORM));
    await watch.save(TARGET);

    watch.keyPressed();
    await watch.submitting(reads({ ...FORM, password: "changed" }));

    expect(last()).toMatchObject({ state: "save", replaces: true });
  });

  it("keeps the offer and says that saving failed, each time it is tried", async () => {
    const { watch, reads, told, last } = createWatch({ save: async () => ({ ok: false, output: "no" }) });
    watch.keyPressed();
    await watch.submitting(reads(FORM));

    await watch.save(TARGET);
    expect(last()).toMatchObject({ state: "save", failed: true });
    // The view waits for an answer to every request, also one that changes nothing.
    const before = told.length;
    await watch.save(TARGET);
    expect(told).toHaveLength(before + 1);
    expect(last()).toMatchObject({ state: "save", failed: true });
  });

  it("forgets a declined offer and one the person walked away from", async () => {
    const { watch, reads, last, told } = createWatch();
    watch.keyPressed();
    await watch.submitting(reads(FORM));
    watch.dismiss();
    expect(last()).toEqual({ type: "login", state: "none" });
    const before = told.length;
    watch.keyPressed();
    await watch.submitting(reads(FORM));
    expect(told).toHaveLength(before);
    // "Not now" is for this visit to the form: after the page moved on, the same sign-in is offered again.
    await watch.pageRead("https://accounts.example.com/home", false);
    watch.keyPressed();
    await watch.submitting(reads(FORM));
    expect(last()).toMatchObject({ state: "save" });
    watch.dismiss();

    watch.keyPressed();
    await watch.submitting(reads({ ...FORM, password: "second try" }));
    expect(last()).toMatchObject({ state: "save" });
    watch.left();
    expect(last()).toEqual({ type: "login", state: "none" });
    await watch.save(TARGET);
    expect(last()).toEqual({ type: "login", state: "none" });
  });

  it("does not offer to sign in with a login the site refused", async () => {
    const { watch, logins, told } = createWatch();
    const login = await logins.save(FORM, TARGET);
    await logins.markFailed(login!.id);

    await watch.pageRead("https://accounts.example.com/login", true);

    expect(told).toEqual([]);
  });

  it("offers to sign in on a page that shows the form of a saved login, and reports a fill that failed", async () => {
    const { watch, logins, vault, told, last } = createWatch();
    const login = await logins.save(FORM, TARGET);

    await watch.pageRead("https://accounts.example.com/login", true);
    expect(last()).toEqual({ type: "login", state: "fill", host: "accounts.example.com", username: "tim@example.com" });

    const before = told.length;
    await watch.fill({ browserTarget: TARGET });
    expect(vault.signIn).toHaveBeenCalledWith(login!.id, { browserTarget: TARGET });
    // The view hears that its request was carried out, though what it offers is unchanged.
    expect(told).toHaveLength(before + 1);

    vi.mocked(vault.signIn).mockResolvedValueOnce({ ok: false, output: "Timed out waiting for username field" });
    await watch.fill({ browserTarget: TARGET });
    expect(last()).toMatchObject({ state: "fill", failed: true });

    await watch.pageRead("https://accounts.example.com/home", false);
    expect(last()).toEqual({ type: "login", state: "none" });
    await watch.pageRead("https://other.example.com/login", true);
    expect(last()).toEqual({ type: "login", state: "none" });
  });

  it("tells a view that connects later what is on offer", async () => {
    const { watch, reads } = createWatch();
    watch.keyPressed();
    await watch.submitting(reads(FORM));
    const later: BrowserLiveLoginMessage[] = [];

    const stop = watch.watch((message) => later.push(message));

    expect(later).toEqual([{ type: "login", state: "save", host: "accounts.example.com", username: "tim@example.com" }]);
    stop();
    watch.dismiss();
    expect(later).toHaveLength(1);
  });
});
