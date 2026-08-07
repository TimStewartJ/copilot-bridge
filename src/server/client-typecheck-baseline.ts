import { readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";
import {
  compareClientTypecheckBaselines,
  createClientTypecheckBaseline,
  parseClientTypecheckBaseline,
  sortDiagnosticEntries,
  type DiagnosticBaselineChange,
  type DiagnosticRecord,
} from "./client-typecheck-baseline-core.js";

const CONFIG_PATH = resolve("tsconfig.client.json");
const BASELINE_PATH = resolve("client-typecheck-baseline.json");
const WRITE_BASELINE = process.argv.includes("--write-baseline");

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function loadClientProgram(): ts.Program {
  const configFile = ts.readConfigFile(CONFIG_PATH, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"));
  }

  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    dirname(CONFIG_PATH),
    undefined,
    CONFIG_PATH,
  );
  if (parsed.errors.length > 0) {
    throw new Error(parsed.errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n")).join("\n"));
  }

  return ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
  });
}

function toDiagnosticRecord(diagnostic: ts.Diagnostic): DiagnosticRecord {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  if (!diagnostic.file || diagnostic.start === undefined) {
    return {
      code: diagnostic.code,
      file: "<global>",
      line: 0,
      character: 0,
      message,
    };
  }

  const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
  return {
    code: diagnostic.code,
    file: normalizePath(relative(process.cwd(), diagnostic.file.fileName)),
    line: position.line + 1,
    character: position.character + 1,
    message,
  };
}

function sortDiagnostics(left: DiagnosticRecord, right: DiagnosticRecord): number {
  return left.file.localeCompare(right.file)
    || left.line - right.line
    || left.character - right.character
    || left.code - right.code
    || left.message.localeCompare(right.message);
}

function readBaseline() {
  const parsed = JSON.parse(readFileSync(BASELINE_PATH, "utf-8")) as unknown;
  return parseClientTypecheckBaseline(parsed);
}

function formatChange(change: DiagnosticBaselineChange): string {
  return `${change.file}:TS${change.code}:${change.message} (${change.previousCount} -> ${change.currentCount})`;
}

const currentRecords = ts.getPreEmitDiagnostics(loadClientProgram())
  .map(toDiagnosticRecord)
  .sort(sortDiagnostics);
const current = createClientTypecheckBaseline(currentRecords);

if (WRITE_BASELINE) {
  writeFileSync(BASELINE_PATH, `${JSON.stringify(current, null, 2)}\n`);
  process.stdout.write(
    `Wrote client typecheck baseline with ${currentRecords.length} diagnostic(s) across ${current.diagnostics.length} identities.\n`,
  );
  process.exit(0);
}

const baseline = readBaseline();
const { added, removed } = compareClientTypecheckBaselines(current, baseline);

if (added.length === 0 && removed.length === 0) {
  process.stdout.write(
    `Client typecheck baseline matched ${currentRecords.length} existing diagnostic(s) across ${current.diagnostics.length} identities.\n`,
  );
  process.exit(0);
}

process.stderr.write("Client typecheck baseline changed.\n");
if (added.length > 0) {
  process.stderr.write("\nNew diagnostics or increased occurrence counts:\n");
  for (const change of added.sort(sortDiagnosticEntries)) {
    process.stderr.write(`- ${formatChange(change)}\n`);
  }
}
if (removed.length > 0) {
  process.stderr.write("\nResolved diagnostics or reduced occurrence counts:\n");
  for (const change of removed.sort(sortDiagnosticEntries)) {
    process.stderr.write(`- ${formatChange(change)}\n`);
  }
}
process.stderr.write("\nRun npm run typecheck:client:update-baseline only when the client type debt intentionally changes.\n");
process.exit(1);
