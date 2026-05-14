import { readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";

const CONFIG_PATH = resolve("tsconfig.client.json");
const BASELINE_PATH = resolve("client-typecheck-baseline.json");
const WRITE_BASELINE = process.argv.includes("--write-baseline");

interface DiagnosticRecord {
  code: number;
  file: string;
  line: number;
  character: number;
  message: string;
}

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

function readBaseline(): DiagnosticRecord[] {
  try {
    const parsed = JSON.parse(readFileSync(BASELINE_PATH, "utf-8")) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error("Client typecheck baseline must be an array.");
    }
    return parsed as DiagnosticRecord[];
  } catch (error) {
    if (WRITE_BASELINE) return [];
    throw error;
  }
}

function toSignature(record: DiagnosticRecord): string {
  return `${record.file}:${record.line}:${record.character}:TS${record.code}:${record.message}`;
}

const current = ts.getPreEmitDiagnostics(loadClientProgram())
  .map(toDiagnosticRecord)
  .sort(sortDiagnostics);

if (WRITE_BASELINE) {
  writeFileSync(BASELINE_PATH, `${JSON.stringify(current, null, 2)}\n`);
  process.stdout.write(`Wrote client typecheck baseline with ${current.length} diagnostic(s).\n`);
  process.exit(0);
}

const baseline = readBaseline().sort(sortDiagnostics);
const currentSignatures = new Set(current.map(toSignature));
const baselineSignatures = new Set(baseline.map(toSignature));
const added = current.filter((record) => !baselineSignatures.has(toSignature(record)));
const removed = baseline.filter((record) => !currentSignatures.has(toSignature(record)));

if (added.length === 0 && removed.length === 0) {
  process.stdout.write(`Client typecheck baseline matched ${current.length} existing diagnostic(s).\n`);
  process.exit(0);
}

process.stderr.write("Client typecheck baseline changed.\n");
if (added.length > 0) {
  process.stderr.write("\nNew diagnostics:\n");
  for (const record of added) {
    process.stderr.write(`- ${toSignature(record)}\n`);
  }
}
if (removed.length > 0) {
  process.stderr.write("\nResolved diagnostics missing from the committed baseline:\n");
  for (const record of removed) {
    process.stderr.write(`- ${toSignature(record)}\n`);
  }
}
process.stderr.write("\nRun npm run typecheck:client:update-baseline only when the client type debt intentionally changes.\n");
process.exit(1);
