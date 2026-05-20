import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { writeFileSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { makeTestDir } from "./helpers.js";

describe("coverage summary script", () => {
  it("writes total and per-file coverage to stdout and the GitHub step summary", () => {
    const dir = makeTestDir("coverage-summary-script");
    const coveragePath = join(dir, "coverage-summary.json");
    const stepSummaryPath = join(dir, "step-summary.md");
    writeFileSync(coveragePath, `${JSON.stringify({
      total: {
        statements: { total: 10, covered: 8, pct: 80 },
        branches: { total: 5, covered: 3, pct: 60 },
        functions: { total: 4, covered: 4, pct: 100 },
        lines: { total: 12, covered: 9, pct: 75 },
      },
      "src/server/example.ts": {
        statements: { total: 10, covered: 8, pct: 80 },
        branches: { total: 5, covered: 3, pct: 60 },
        functions: { total: 4, covered: 4, pct: 100 },
        lines: { total: 12, covered: 9, pct: 75 },
      },
    })}\n`, "utf-8");

    const output = execFileSync(
      process.execPath,
      ["scripts/write-coverage-summary.mjs", coveragePath],
      {
        cwd: process.cwd(),
        encoding: "utf-8",
        env: { ...process.env, GITHUB_STEP_SUMMARY: stepSummaryPath },
      },
    );

    expect(output).toContain("## Coverage");
    expect(output).toContain("80.00%");
    expect(output).toContain("src/server/example.ts");
    const stepSummary = readFileSync(stepSummaryPath, "utf-8");
    expect(stepSummary).toContain("File coverage breakdown (1 files)");
    expect(stepSummary).toContain("src/server/example.ts");
  });
});

