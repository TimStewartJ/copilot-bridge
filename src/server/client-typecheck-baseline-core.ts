export interface DiagnosticRecord {
  code: number;
  file: string;
  line: number;
  character: number;
  message: string;
}

export interface DiagnosticLocation {
  line: number;
  character: number;
}

export interface DiagnosticBaselineEntry {
  code: number;
  file: string;
  message: string;
  count: number;
  locations: DiagnosticLocation[];
}

export interface ClientTypecheckBaseline {
  version: 1;
  diagnostics: DiagnosticBaselineEntry[];
}

export interface DiagnosticBaselineChange {
  code: number;
  file: string;
  message: string;
  previousCount: number;
  currentCount: number;
}

export interface DiagnosticBaselineDiff {
  added: DiagnosticBaselineChange[];
  removed: DiagnosticBaselineChange[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeFile(file: string): string {
  return file.replaceAll("\\", "/");
}

function normalizeMessage(message: string): string {
  return message.replace(/\r\n?/g, "\n");
}

function diagnosticIdentity(
  diagnostic: Pick<DiagnosticBaselineEntry, "code" | "file" | "message">,
): string {
  return JSON.stringify([
    normalizeFile(diagnostic.file),
    diagnostic.code,
    normalizeMessage(diagnostic.message),
  ]);
}

function sortLocations(left: DiagnosticLocation, right: DiagnosticLocation): number {
  return left.line - right.line || left.character - right.character;
}

export function sortDiagnosticEntries(
  left: Pick<DiagnosticBaselineEntry, "code" | "file" | "message">,
  right: Pick<DiagnosticBaselineEntry, "code" | "file" | "message">,
): number {
  return left.file.localeCompare(right.file)
    || left.code - right.code
    || left.message.localeCompare(right.message);
}

export function createClientTypecheckBaseline(
  records: DiagnosticRecord[],
): ClientTypecheckBaseline {
  const byIdentity = new Map<string, DiagnosticBaselineEntry>();

  for (const record of records) {
    const normalized = {
      code: record.code,
      file: normalizeFile(record.file),
      message: normalizeMessage(record.message),
    };
    const identity = diagnosticIdentity(normalized);
    const existing = byIdentity.get(identity);
    const location = { line: record.line, character: record.character };
    if (existing) {
      existing.count += 1;
      existing.locations.push(location);
    } else {
      byIdentity.set(identity, {
        ...normalized,
        count: 1,
        locations: [location],
      });
    }
  }

  const diagnostics = [...byIdentity.values()].sort(sortDiagnosticEntries);
  for (const diagnostic of diagnostics) {
    diagnostic.locations.sort(sortLocations);
  }
  return { version: 1, diagnostics };
}

function parseLocation(value: unknown, entryIndex: number, locationIndex: number): DiagnosticLocation {
  if (!isRecord(value)
    || typeof value.line !== "number"
    || !Number.isInteger(value.line)
    || value.line < 0
    || typeof value.character !== "number"
    || !Number.isInteger(value.character)
    || value.character < 0) {
    throw new Error(
      `Client typecheck baseline diagnostic ${entryIndex} location ${locationIndex} is invalid.`,
    );
  }
  return { line: value.line, character: value.character };
}

function parseEntry(value: unknown, index: number): DiagnosticBaselineEntry {
  if (!isRecord(value)
    || typeof value.code !== "number"
    || !Number.isInteger(value.code)
    || typeof value.file !== "string"
    || value.file.length === 0
    || typeof value.message !== "string"
    || typeof value.count !== "number"
    || !Number.isInteger(value.count)
    || value.count <= 0
    || !Array.isArray(value.locations)) {
    throw new Error(`Client typecheck baseline diagnostic ${index} is invalid.`);
  }

  const locations = value.locations.map((location, locationIndex) =>
    parseLocation(location, index, locationIndex)
  );
  if (locations.length !== value.count) {
    throw new Error(
      `Client typecheck baseline diagnostic ${index} count does not match its location hints.`,
    );
  }

  return {
    code: value.code,
    file: normalizeFile(value.file),
    message: normalizeMessage(value.message),
    count: value.count,
    locations: locations.sort(sortLocations),
  };
}

export function parseClientTypecheckBaseline(value: unknown): ClientTypecheckBaseline {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.diagnostics)) {
    throw new Error("Client typecheck baseline must use version 1 with a diagnostics array.");
  }

  const diagnostics = value.diagnostics.map(parseEntry).sort(sortDiagnosticEntries);
  const identities = new Set<string>();
  for (const diagnostic of diagnostics) {
    const identity = diagnosticIdentity(diagnostic);
    if (identities.has(identity)) {
      throw new Error(`Client typecheck baseline contains a duplicate diagnostic identity: ${identity}`);
    }
    identities.add(identity);
  }

  return { version: 1, diagnostics };
}

export function compareClientTypecheckBaselines(
  current: ClientTypecheckBaseline,
  baseline: ClientTypecheckBaseline,
): DiagnosticBaselineDiff {
  const currentByIdentity = new Map(
    current.diagnostics.map((diagnostic) => [diagnosticIdentity(diagnostic), diagnostic]),
  );
  const baselineByIdentity = new Map(
    baseline.diagnostics.map((diagnostic) => [diagnosticIdentity(diagnostic), diagnostic]),
  );
  const changes: DiagnosticBaselineChange[] = [];

  for (const identity of new Set([...currentByIdentity.keys(), ...baselineByIdentity.keys()])) {
    const currentDiagnostic = currentByIdentity.get(identity);
    const baselineDiagnostic = baselineByIdentity.get(identity);
    const diagnostic = currentDiagnostic ?? baselineDiagnostic;
    if (!diagnostic) continue;
    const currentCount = currentDiagnostic?.count ?? 0;
    const previousCount = baselineDiagnostic?.count ?? 0;
    if (currentCount === previousCount) continue;
    changes.push({
      code: diagnostic.code,
      file: diagnostic.file,
      message: diagnostic.message,
      previousCount,
      currentCount,
    });
  }

  changes.sort(sortDiagnosticEntries);
  return {
    added: changes.filter((change) => change.currentCount > change.previousCount),
    removed: changes.filter((change) => change.currentCount < change.previousCount),
  };
}

