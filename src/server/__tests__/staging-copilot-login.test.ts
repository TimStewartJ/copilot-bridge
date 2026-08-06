import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTestDir } from "./helpers.js";
import {
  resolveDefaultCopilotHome,
  seedStagingCopilotLogin,
} from "../staging-backend-manager.js";

function writeConfig(dir: string, config: unknown): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(config, null, 2));
  return path;
}

function readConfig(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as Record<string, unknown>;
}

const LOGIN_POINTER = {
  loggedInUsers: [{ host: "https://github.com", login: "someone_example" }],
  lastLoggedInUser: { host: "https://github.com", login: "someone_example" },
};

describe("seedStagingCopilotLogin", () => {
  it("copies the login pointer into an empty staging copilot home", () => {
    const root = makeTestDir("bridge-staging-copilot-login-");
    const source = join(root, "source");
    const target = join(root, "target");
    writeConfig(source, { ...LOGIN_POINTER, firstLaunchAt: "2026-01-01T00:00:00.000Z" });

    expect(seedStagingCopilotLogin(target, { sourceCopilotHome: source })).toBe(true);
    expect(readConfig(target)).toMatchObject(LOGIN_POINTER);
  });

  it("preserves existing staging config fields while adding the pointer", () => {
    const root = makeTestDir("bridge-staging-copilot-login-");
    const source = join(root, "source");
    const target = join(root, "target");
    writeConfig(source, LOGIN_POINTER);
    writeConfig(target, { firstLaunchAt: "2026-05-05T00:00:00.000Z" });

    expect(seedStagingCopilotLogin(target, { sourceCopilotHome: source })).toBe(true);
    const seeded = readConfig(target);
    expect(seeded.firstLaunchAt).toBe("2026-05-05T00:00:00.000Z");
    expect(seeded).toMatchObject(LOGIN_POINTER);
  });

  it("copies only the login pointer and never other account state", () => {
    const root = makeTestDir("bridge-staging-copilot-login-");
    const source = join(root, "source");
    const target = join(root, "target");
    writeConfig(source, {
      ...LOGIN_POINTER,
      trustedFolders: ["D:/secret-repo"],
      expAssignmentsCache: { flag: true },
      staff: true,
    });

    expect(seedStagingCopilotLogin(target, { sourceCopilotHome: source })).toBe(true);
    const seeded = readConfig(target);
    expect(seeded).toMatchObject(LOGIN_POINTER);
    expect(seeded.trustedFolders).toBeUndefined();
    expect(seeded.expAssignmentsCache).toBeUndefined();
    expect(seeded.staff).toBeUndefined();
  });

  it("reads a source config written as JSONC with a comment header", () => {
    // The real Copilot CLI config is JSONC: it opens with a comment header and
    // stores "https://github.com", so neither JSON.parse nor a naive comment
    // regex handles it. Earlier fixtures used JSON.stringify and missed this.
    const root = makeTestDir("bridge-staging-copilot-login-");
    const source = join(root, "source");
    const target = join(root, "target");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "config.json"), [
      "// User settings belong in settings.json.",
      "// This file is managed automatically.",
      JSON.stringify(LOGIN_POINTER, null, 2),
    ].join("\n"));

    expect(seedStagingCopilotLogin(target, { sourceCopilotHome: source })).toBe(true);
    expect(readConfig(target)).toMatchObject(LOGIN_POINTER);
  });

  it("reports failure when the source copilot home has no config", () => {
    const root = makeTestDir("bridge-staging-copilot-login-");
    const target = join(root, "target");
    expect(seedStagingCopilotLogin(target, {
      sourceCopilotHome: join(root, "missing"),
    })).toBe(false);
    expect(existsSync(join(target, "config.json"))).toBe(false);
  });

  it("reports failure when the source config has no signed-in account", () => {
    const root = makeTestDir("bridge-staging-copilot-login-");
    const source = join(root, "source");
    const target = join(root, "target");
    writeConfig(source, { firstLaunchAt: "2026-01-01T00:00:00.000Z" });

    expect(seedStagingCopilotLogin(target, { sourceCopilotHome: source })).toBe(false);
  });

  it("reports failure on an unparseable source config instead of throwing", () => {
    const root = makeTestDir("bridge-staging-copilot-login-");
    const source = join(root, "source");
    const target = join(root, "target");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "config.json"), "{ not json");

    expect(seedStagingCopilotLogin(target, { sourceCopilotHome: source })).toBe(false);
  });

  it("recovers from a corrupt staging config by rewriting it", () => {
    const root = makeTestDir("bridge-staging-copilot-login-");
    const source = join(root, "source");
    const target = join(root, "target");
    writeConfig(source, LOGIN_POINTER);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "config.json"), "{ not json");

    expect(seedStagingCopilotLogin(target, { sourceCopilotHome: source })).toBe(true);
    expect(readConfig(target)).toMatchObject(LOGIN_POINTER);
  });
});

describe("resolveDefaultCopilotHome", () => {
  it("derives the copilot home from the Windows user profile", () => {
    const resolved = resolveDefaultCopilotHome({ USERPROFILE: join("C:", "Users", "someone") });
    expect(resolved).toBe(join("C:", "Users", "someone", ".copilot"));
  });

  it("falls back to HOME when USERPROFILE is absent", () => {
    const resolved = resolveDefaultCopilotHome({ HOME: join("/home", "someone") });
    expect(resolved).toBe(join("/home", "someone", ".copilot"));
  });

  it("returns undefined when no home is set", () => {
    expect(resolveDefaultCopilotHome({})).toBeUndefined();
    expect(resolveDefaultCopilotHome({ HOME: "   " })).toBeUndefined();
  });
});
