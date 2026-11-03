import { describe, expect, it } from "vitest";
import {
  PatchTermScanner,
  checkCommits,
  checkDeployMessage,
  formatDeployGuardFailure,
  matchBlockedEmail,
  parseCommitLog,
  parseDenylist,
} from "../deploy-guards.js";

describe("deploy guards", () => {
  it.each([
    ["dev@corp.example.com", ["*@corp.example.com"], "*@corp.example.com"],
    ["Dev@CORP.Example.com", ["*@corp.example.com"], "*@corp.example.com"],
    ["dev@corp.example.com.evil", ["*@corp.example.com"], undefined],
    ["dev@sub.corp.example.com", ["*@*.corp.example.com"], "*@*.corp.example.com"],
    ["user@example.com", ["*@corp.example.com", "user@example.com"], "user@example.com"],
    ["user+tag@example.com", ["user+tag@example.com"], "user+tag@example.com"],
    ["userXexample.com", ["user.example.com"], undefined],
    ["", ["*"], undefined],
  ])("matches %s against %j", (email, patterns, expected) => {
    expect(matchBlockedEmail(email, patterns)).toBe(expected);
  });

  it("parses the denylist, skipping comments and blank lines and keeping line numbers", () => {
    expect(parseDenylist("\uFEFF# private names\r\nAlpha Codename\n\n  beta  \n  # indented comment\n")).toEqual([
      { term: "alpha codename", line: 2 },
      { term: "beta", line: 4 },
    ]);
  });

  it("checks commit emails and messages from git log output", () => {
    const log = [
      "aaaaaaaaaa1\0dev@corp.example.com\0user@example.com\0Add a thing\n\nUses ALPHA internally\n\x1e",
      "\nbbbbbbbbbb2\0user@example.com\0user@example.com\0Clean commit\n\x1e\n",
    ].join("");
    const commits = parseCommitLog(log);
    expect(commits.map((commit) => commit.sha)).toEqual(["aaaaaaaaaa1", "bbbbbbbbbb2"]);
    expect(checkCommits(commits, ["*@corp.example.com"], parseDenylist("alpha"))).toEqual([
      { kind: "email", sha: "aaaaaaaaaa1", field: "author", email: "dev@corp.example.com", pattern: "*@corp.example.com" },
      { kind: "term", where: "commit message", sha: "aaaaaaaaaa1", termLine: 1 },
    ]);
    expect(checkDeployMessage("Ship Alpha support", parseDenylist("alpha"))).toEqual([
      { kind: "term", where: "deploy message", termLine: 1 },
    ]);
  });

  it("finds terms in added lines and new file paths with the line in the new file", () => {
    const scanner = new PatchTermScanner(parseDenylist("# terms\nalpha\nbeta"));
    const patch = [
      "\x1ecccccccccc3",
      "",
      "diff --git src/a.ts src/a.ts",
      "index 1111111..2222222 100644",
      "--- src/a.ts",
      "+++ src/a.ts",
      "@@ -3,2 +10,3 @@ export function f() {",
      "-const old = 'alpha';",
      "-const gone = 1;",
      "+const kept = 1;",
      "+++ looks like a header but mentions BETA",
      "+const name = 'Alpha';",
      "\\ No newline at end of file",
      "@@ -20 +22 @@",
      "-x",
      "+y",
      "diff --git docs/alpha-notes.md docs/alpha-notes.md",
      "new file mode 100644",
      "index 0000000..3333333",
      "--- /dev/null",
      "+++ docs/alpha-notes.md",
      "@@ -0,0 +1 @@",
      "+nothing here",
    ];
    for (const line of patch) scanner.push(line);
    expect(scanner.findings).toEqual([
      { kind: "term", where: "added line", sha: "cccccccccc3", path: "src/a.ts", line: 11, termLine: 3 },
      { kind: "term", where: "added line", sha: "cccccccccc3", path: "src/a.ts", line: 12, termLine: 2 },
      { kind: "term", where: "new file path", sha: "cccccccccc3", termLine: 2 },
    ]);
  });

  it("names where a term is and how to fix it without repeating the term", () => {
    const text = formatDeployGuardFailure(
      [
        { kind: "email", sha: "aaaaaaaaaaaa", field: "committer", email: "dev@corp.example.com", pattern: "*@corp.example.com" },
        { kind: "term", where: "added line", sha: "bbbbbbbbbbbb", path: "src/a.ts", line: 7, termLine: 2 },
      ],
      { prodBranch: "main", stagingDir: "/work/stage", denylistFile: "/home/user/denylist.txt" },
    );
    expect(text).toContain("aaaaaaaaaa committer email dev@corp.example.com matches blocked pattern *@corp.example.com");
    expect(text).toContain("--reset-author");
    expect(text).toContain("src/a.ts:7 in bbbbbbbbbb adds the term on denylist line 2");
    expect(text).toContain("/home/user/denylist.txt");
    expect(text).toContain("git rebase -i main");
  });
});
