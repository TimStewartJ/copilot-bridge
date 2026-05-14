import { readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

interface JsonTestResult {
  name?: unknown;
  startTime?: unknown;
  endTime?: unknown;
  perfStats?: {
    start?: unknown;
    end?: unknown;
    runtime?: unknown;
  };
}

interface JsonTestReport {
  testResults?: unknown;
}

interface SlowTestFile {
  name: string;
  durationMs: number;
}

function getDurationMs(result: JsonTestResult): number | undefined {
  if (typeof result.startTime === "number" && typeof result.endTime === "number") {
    return Math.max(0, result.endTime - result.startTime);
  }
  if (typeof result.perfStats?.runtime === "number") {
    return Math.max(0, result.perfStats.runtime);
  }
  if (typeof result.perfStats?.start === "number" && typeof result.perfStats?.end === "number") {
    return Math.max(0, result.perfStats.end - result.perfStats.start);
  }
  return undefined;
}

function parseSlowTestFiles(reportPath: string): SlowTestFile[] {
  const parsed = JSON.parse(readFileSync(reportPath, "utf-8")) as JsonTestReport;
  if (!Array.isArray(parsed.testResults)) {
    throw new Error("Vitest JSON report did not contain a testResults array.");
  }

  return parsed.testResults
    .map((value): SlowTestFile | undefined => {
      if (!value || typeof value !== "object") return undefined;
      const result = value as JsonTestResult;
      const durationMs = getDurationMs(result);
      if (typeof result.name !== "string" || durationMs === undefined) return undefined;
      return { name: result.name, durationMs };
    })
    .filter((value): value is SlowTestFile => value !== undefined)
    .sort((left, right) => right.durationMs - left.durationMs);
}

const reportArg = process.argv[2];
if (!reportArg) {
  throw new Error("Usage: tsx src/server/slow-test-report.ts <vitest-json-report>");
}

const reportPath = resolve(reportArg);
const slowFiles = parseSlowTestFiles(reportPath).slice(0, 15);
rmSync(reportPath, { force: true });

process.stdout.write("Slowest Vitest files:\n");
for (const file of slowFiles) {
  process.stdout.write(`- ${file.durationMs.toFixed(0).padStart(6, " ")} ms  ${file.name}\n`);
}
