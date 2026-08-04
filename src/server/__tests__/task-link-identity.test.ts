import { describe, expect, it } from "vitest";
import {
  canonicalizeGitHubRepoId,
  resolvePullRequestUnlink,
  resolveWorkItemUnlink,
  normalizeWorkItemRef,
  parseGitHubRepoUrl,
  parsePullRequestId,
  pullRequestRepoIdCandidates,
  resolveLinkProvider,
  resolvePullRequestLink,
} from "../task-link-identity.js";

describe("resolveLinkProvider", () => {
  it("honors an explicit provider", () => {
    expect(resolveLinkProvider({ explicit: "linear", ref: "https://github.com/o/r" })).toEqual({ ok: true, value: "linear" });
  });

  it("rejects an unknown explicit provider", () => {
    const result = resolveLinkProvider({ explicit: "gitlab", ref: "o/r" });
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain("provider must be one of");
  });

  it("infers github from an exact github.com URL even when another provider is configured", () => {
    expect(resolveLinkProvider({
      ref: "https://github.com/octo/widget/pull/12",
      providers: { ado: { org: "o", project: "p" } },
    })).toEqual({ ok: true, value: "github" });
  });

  it("does not treat lookalike hosts as github", () => {
    expect(parseGitHubRepoUrl("https://github.com.evil.test/octo/widget")).toBeNull();
    expect(parseGitHubRepoUrl("https://notgithub.com/octo/widget")).toBeNull();
    expect(resolveLinkProvider({ ref: "https://notgithub.com/octo/widget" })).toMatchObject({ ok: false });
  });

  it("falls back to the single configured provider", () => {
    expect(resolveLinkProvider({ ref: "12345", providers: { ado: { org: "o", project: "p" } } }))
      .toEqual({ ok: true, value: "ado" });
  });

  it("does not guess when several providers are configured", () => {
    const result = resolveLinkProvider({
      ref: "12345",
      providers: { ado: { org: "o", project: "p" }, linear: { apiKey: "k", workspace: "w" } },
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain("Pass provider explicitly");
  });

  it("infers github from unambiguous shorthand when nothing is configured", () => {
    expect(resolveLinkProvider({ ref: "octo/widget" })).toEqual({ ok: true, value: "github" });
    expect(resolveLinkProvider({ ref: "octo/widget#7" })).toEqual({ ok: true, value: "github" });
  });

  it("never silently defaults to ado", () => {
    expect(resolveLinkProvider({ ref: "12345" })).toMatchObject({ ok: false });
    expect(resolveLinkProvider({ ref: "" })).toMatchObject({ ok: false });
  });
});

describe("canonicalizeGitHubRepoId", () => {
  it("canonicalizes URLs, .git suffixes and shorthand", () => {
    expect(canonicalizeGitHubRepoId("https://github.com/octo/widget/pull/3")).toBe("octo/widget");
    expect(canonicalizeGitHubRepoId("https://github.com/octo/widget.git")).toBe("octo/widget");
    expect(canonicalizeGitHubRepoId("octo/widget")).toBe("octo/widget");
    expect(canonicalizeGitHubRepoId("widget", "octo")).toBe("octo/widget");
  });

  it("returns null when a bare repo has no owner to resolve against", () => {
    expect(canonicalizeGitHubRepoId("widget")).toBeNull();
    expect(canonicalizeGitHubRepoId("")).toBeNull();
  });
});

describe("parsePullRequestId", () => {
  it("accepts positive whole numbers and numeric strings", () => {
    expect(parsePullRequestId(12)).toEqual({ ok: true, value: 12 });
    expect(parsePullRequestId("12")).toEqual({ ok: true, value: 12 });
  });

  it("rejects everything that is not a positive safe integer", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2, null, "", "abc", undefined]) {
      expect(parsePullRequestId(bad)).toMatchObject({ ok: false });
    }
  });
});

describe("resolvePullRequestLink", () => {
  it("keeps a durable ADO repository id distinct from the display name", () => {
    const result = resolvePullRequestLink({
      repoId: "3f2b9c62-0d6a-4b73-8a9b-2f4e0d1a5c77",
      repoName: "Widget.Service",
      prId: 42,
      provider: "ado",
    });
    expect(result).toEqual({
      ok: true,
      value: {
        repoId: "3f2b9c62-0d6a-4b73-8a9b-2f4e0d1a5c77",
        repoName: "Widget.Service",
        prId: 42,
        provider: "ado",
      },
    });
  });

  it("derives a canonical repo id for github refs", () => {
    expect(resolvePullRequestLink({ repoName: "https://github.com/octo/widget", prId: 7, provider: "github" }))
      .toMatchObject({ ok: true, value: { repoId: "octo/widget", repoName: "https://github.com/octo/widget" } });
    expect(resolvePullRequestLink({ repoName: "widget", prId: 7, provider: "github", providers: { github: { owner: "octo" } } }))
      .toMatchObject({ ok: true, value: { repoId: "octo/widget" } });
  });

  it("canonicalizes an explicit github repo id instead of trusting it verbatim", () => {
    expect(resolvePullRequestLink({ repoId: "https://github.com/octo/widget", repoName: "widget", prId: 7, provider: "github" }))
      .toMatchObject({ ok: true, value: { repoId: "octo/widget", repoName: "widget" } });
  });

  it("fails on an unresolvable github repository instead of persisting a dead row", () => {
    const result = resolvePullRequestLink({ repoName: "widget", prId: 7, provider: "github" });
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain("Could not resolve");
  });

  it("requires a repository reference and a valid prId", () => {
    expect(resolvePullRequestLink({ prId: 7, provider: "ado" })).toMatchObject({ ok: false });
    expect(resolvePullRequestLink({ repoName: "repo", prId: "x", provider: "ado" })).toMatchObject({ ok: false });
    expect(resolvePullRequestLink({ repoName: "repo", prId: 1.5, provider: "ado" })).toMatchObject({ ok: false });
  });
});

describe("pullRequestRepoIdCandidates", () => {
  it("includes the legacy raw id alongside the canonical one", () => {
    expect(pullRequestRepoIdCandidates({ repoName: "https://github.com/octo/widget" })).toEqual([
      "https://github.com/octo/widget",
      "octo/widget",
    ]);
  });

  it("does not duplicate an already-canonical id", () => {
    expect(pullRequestRepoIdCandidates({ repoName: "octo/widget" })).toEqual(["octo/widget"]);
  });

  it("keeps a durable id and its display name as separate candidates", () => {
    expect(pullRequestRepoIdCandidates({ repoId: "guid-1", repoName: "Widget.Service" })).toEqual([
      "guid-1",
      "Widget.Service",
    ]);
  });

  it("returns nothing when no repository reference is given", () => {
    expect(pullRequestRepoIdCandidates({})).toEqual([]);
    expect(pullRequestRepoIdCandidates({ repoName: "   " })).toEqual([]);
  });
});

describe("normalizeWorkItemRef", () => {
  it("accepts strings and numbers", () => {
    expect(normalizeWorkItemRef(" 4242 ")).toEqual({ ok: true, value: "4242" });
    expect(normalizeWorkItemRef(4242)).toEqual({ ok: true, value: "4242" });
  });

  it("rejects empty and non-scalar references", () => {
    for (const bad of ["", "   ", null, undefined, {}]) {
      expect(normalizeWorkItemRef(bad)).toMatchObject({ ok: false });
    }
  });
});

describe("unlink provider handling", () => {
  const providers = { ado: { org: "o", project: "p" }, github: { owner: "octo" } };

  it("treats undefined, null and empty provider identically on both unlink paths", () => {
    for (const provider of [undefined, null, ""]) {
      expect(resolvePullRequestUnlink({ repoName: "octo/widget", prId: 5, provider, providers }))
        .toEqual({ ok: true, value: { repoIds: ["octo/widget"], prId: 5, provider: undefined } });
      expect(resolveWorkItemUnlink({ workItemId: "42", provider }))
        .toEqual({ ok: true, value: { workItemId: "42", provider: undefined } });
    }
  });

  it("never infers a provider on unlink", () => {
    expect(resolvePullRequestUnlink({ repoName: "https://github.com/octo/widget", prId: 5, providers }))
      .toMatchObject({ ok: true, value: { provider: undefined } });
  });

  it("keeps an explicitly named provider and rejects an invalid one", () => {
    expect(resolvePullRequestUnlink({ repoName: "octo/widget", prId: 5, provider: "github", providers }))
      .toMatchObject({ ok: true, value: { provider: "github" } });
    expect(resolvePullRequestUnlink({ repoName: "octo/widget", prId: 5, provider: "gitlab", providers }))
      .toMatchObject({ ok: false });
    expect(resolveWorkItemUnlink({ workItemId: "42", provider: "gitlab" })).toMatchObject({ ok: false });
  });
});
