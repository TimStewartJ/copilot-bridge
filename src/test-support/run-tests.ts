// In validation gates, reruns failed files once and excuses flakes the change does not reach.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decideFlakeOutcome,
  TEST_FLAKE_BASE_ENV,
  TEST_FLAKE_LEDGER_ENV,
  type TestFlakeRecord,
} from "../server/test-flakes.js";

// More failed files than this is a broken change, not a flake; rerunning them only costs time.
const MAX_RERUN_FILES = 10;

const VITEST_BIN = join(dirname(createRequire(import.meta.url).resolve("vitest/package.json")), "vitest.mjs");

interface JsonReport {
  testResults?: Array<{
    name: string;
    status: string;
    assertionResults?: Array<{ fullName: string; status: string }>;
  }>;
}

function run(command: string, args: string[], capture: boolean): Promise<{ code: number; stdout: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { stdio: capture ? ["ignore", "pipe", "ignore"] : "inherit" });
    let stdout = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.on("error", () => resolvePromise({ code: 1, stdout }));
    child.on("close", (code) => resolvePromise({ code: code ?? 1, stdout }));
  });
}

function vitest(args: string[]): Promise<{ code: number }> {
  return run(process.execPath, [VITEST_BIN, ...args], false);
}

async function git(args: string[]): Promise<string | undefined> {
  const result = await run("git", args, true);
  return result.code === 0 ? result.stdout.trim() || undefined : undefined;
}

function readReport(path: string): JsonReport | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as JsonReport;
  } catch {
    return undefined;
  }
}

const SUMMARY_REPORTER = fileURLToPath(new URL("./run-summary-reporter.ts", import.meta.url));

/** Runs vitest with the JSON report and a summary of what that report leaves out. */
async function reportedRun(args: string[], reportPath: string): Promise<{ code: number; report?: JsonReport; confinedToFiles: boolean }> {
  const { code } = await vitest([
    "run", ...args,
    "--reporter=default", "--reporter=json", `--reporter=${SUMMARY_REPORTER}`, `--outputFile.json=${reportPath}`,
  ]);
  const report = readReport(reportPath);
  let summary: { unhandledErrors?: number; reason?: string } | undefined;
  try {
    summary = JSON.parse(readFileSync(`${reportPath}.run.json`, "utf8"));
  } catch {
    summary = undefined;
  }
  // Unhandled, teardown and run errors fail a run without failing any file in the JSON report.
  const confinedToFiles = Boolean(report && summary && summary.unhandledErrors === 0 && summary.reason !== "interrupted");
  return { code, report, confinedToFiles };
}

const fileKey = (file: string) => {
  const absolute = resolve(file);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
};

const displayPath = (file: string) => relative(process.cwd(), file).replaceAll("\\", "/");

function failedFiles(report: JsonReport): string[] {
  return (report.testResults ?? []).filter((result) => result.status === "failed").map((result) => result.name);
}

/** Test files the change since the base reaches, through vitest's own import graph. */
async function listAffectedFiles(scratch: string): Promise<Set<string> | undefined> {
  const baseCheckout = process.env[TEST_FLAKE_BASE_ENV]?.trim();
  if (!baseCheckout) return undefined;
  const base = await git(["-C", baseCheckout, "rev-parse", "HEAD"]);
  const mergeBase = base ? await git(["merge-base", "HEAD", base]) : undefined;
  if (!mergeBase) return undefined;
  const listPath = join(scratch, "affected.json");
  const listed = await run(process.execPath, [VITEST_BIN, "list", "--changed", mergeBase, "--filesOnly", `--json=${listPath}`], true);
  if (listed.code !== 0 || !existsSync(listPath)) return undefined;
  try {
    const files = JSON.parse(readFileSync(listPath, "utf8")) as Array<{ file: string }>;
    return new Set(files.map((entry) => fileKey(entry.file)));
  } catch {
    return undefined;
  }
}

async function runWithFlakeRerun(args: string[], ledgerPath: string): Promise<number> {
  const scratch = mkdtempSync(join(tmpdir(), "bridge-test-run-"));
  try {
    const first = await reportedRun(args, join(scratch, "first.json"));
    if (first.code === 0) return 0;
    const report = first.report;
    const failed = report ? failedFiles(report) : [];
    if (!first.confinedToFiles || failed.length === 0 || failed.length > MAX_RERUN_FILES) return first.code;

    console.log(`\n[run-tests] Rerunning ${failed.length} failed test file(s) once to tell a flake from a failure.\n`);
    const rerun = await reportedRun(failed.map(displayPath), join(scratch, "rerun.json"));
    const rerunFailed = new Set((rerun.report && rerun.confinedToFiles ? failedFiles(rerun.report) : failed).map(fileKey));
    if (rerun.code !== 0 && rerunFailed.size === 0) failed.forEach((file) => rerunFailed.add(fileKey(file)));
    const decision = decideFlakeOutcome({
      failed: failed.map(fileKey),
      rerunFailed,
      affected: rerunFailed.size < failed.length ? await listAffectedFiles(scratch) : undefined,
    });

    const commit = await git(["rev-parse", "HEAD"]);
    const at = new Date().toISOString();
    const records: TestFlakeRecord[] = decision.flakes.map((flake) => {
      const result = report?.testResults?.find((entry) => fileKey(entry.name) === flake.file);
      return {
        at,
        cwd: process.cwd(),
        ...(commit ? { commit } : {}),
        file: displayPath(result?.name ?? flake.file),
        failedTests: (result?.assertionResults ?? []).filter((test) => test.status === "failed").map((test) => test.fullName),
        excused: flake.excused,
        ...(flake.blockedBecause ? { blockedBecause: flake.blockedBecause } : {}),
      };
    });
    if (records.length > 0) {
      try {
        mkdirSync(dirname(ledgerPath), { recursive: true });
        appendFileSync(ledgerPath, records.map((record) => `${JSON.stringify(record)}\n`).join(""));
      } catch (error) {
        console.error(`[run-tests] Could not record flakes in ${ledgerPath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    for (const record of records) {
      const verdict = record.excused
        ? "excused: the change does not reach it"
        : record.blockedBecause === "changed"
          ? "not excused: the change reaches this test"
          : "not excused: no base commit to compare the change against";
      console.log(`[run-tests] FLAKE ${record.file} failed, then passed on rerun (${verdict}). Recorded in ${ledgerPath}.`);
    }
    for (const file of failed.filter((file) => rerunFailed.has(fileKey(file)))) {
      console.log(`[run-tests] FAILED AGAIN ${displayPath(file)}`);
    }
    console.log(decision.pass
      ? "[run-tests] Passing: every failure was a recorded flake outside this change. Fix them; the ledger keeps them."
      : "[run-tests] Failing.");
    return decision.pass ? 0 : 1;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const args = process.argv.slice(2);
const ledgerPath = process.env[TEST_FLAKE_LEDGER_ENV]?.trim();
process.exitCode = ledgerPath ? await runWithFlakeRerun(args, ledgerPath) : (await vitest(["run", ...args])).code;
