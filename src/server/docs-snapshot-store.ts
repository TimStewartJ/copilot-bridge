import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { basename, dirname, join, resolve, sep } from "node:path";

export const STARTUP_SNAPSHOT_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const PRE_DELETE_SNAPSHOT_MIN_INTERVAL_MS = 15 * 60 * 1000;

const DEFAULT_MAX_SNAPSHOTS = 50;
const DEFAULT_OLDEST_SNAPSHOTS_TO_KEEP = 5;
const METADATA_FILE = "metadata.json";
const SNAPSHOT_DOCS_DIR = "docs";
const SAFE_SNAPSHOT_ID = /^[A-Za-z0-9._-]+$/;
const REMOVE_RETRIES = { maxRetries: 5, retryDelay: 100 };

export interface DocsSnapshotMetadata {
  id: string;
  createdAt: string;
  reason: string;
  sourceDocsDir: string;
  fileCount: number;
  totalBytes: number;
  contentHash: string;
  appVersion: string;
}

export interface DocsSnapshotCreateOptions {
  reason?: string;
  allowEmpty?: boolean;
  skipIfRecentMs?: number;
  skipIfUnchanged?: boolean;
  prune?: boolean;
}

export interface DocsSnapshotCreateResult {
  snapshot: DocsSnapshotMetadata | null;
  created: boolean;
  skippedReason?: "empty" | "recent";
}

export interface DocsSnapshotRestoreResult {
  restoredFrom: DocsSnapshotMetadata;
  preRestoreSnapshotId: string;
  fileCount: number;
  totalBytes: number;
}

interface DocsTreeSummary {
  fileCount: number;
  totalBytes: number;
  contentHash: string;
}

export class DocsSnapshotNotFoundError extends Error {
  constructor(snapshotId: string) {
    super(`Docs snapshot not found: ${snapshotId}`);
    this.name = "DocsSnapshotNotFoundError";
  }
}

export class DocsSnapshotValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocsSnapshotValidationError";
  }
}

function normalizePathForContainment(filePath: string): string {
  const resolved = resolve(filePath);
  return process.platform === "win32" || process.platform === "darwin" ? resolved.toLowerCase() : resolved;
}

function isPathAtOrUnder(parent: string, candidate: string): boolean {
  const normalizedParent = normalizePathForContainment(parent);
  const normalizedCandidate = normalizePathForContainment(candidate);
  const parentWithSeparator = normalizedParent.endsWith(sep) ? normalizedParent : `${normalizedParent}${sep}`;
  return normalizedCandidate === normalizedParent || normalizedCandidate.startsWith(parentWithSeparator);
}

function assertSafeSnapshotId(snapshotId: string): void {
  if (!SAFE_SNAPSHOT_ID.test(snapshotId) || snapshotId === "." || snapshotId === "..") {
    throw new DocsSnapshotValidationError(`Invalid docs snapshot id: ${snapshotId}`);
  }
}

function formatSnapshotTimestamp(date: Date): string {
  const pad = (value: number, length = 2) => String(value).padStart(length, "0");
  return [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    "-",
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds()),
    "-",
    pad(date.getUTCMilliseconds(), 3),
  ].join("");
}

function makeSnapshotId(date = new Date()): string {
  return `${formatSnapshotTimestamp(date)}-${randomBytes(3).toString("hex")}`;
}

function makeContentHash(rootDir: string): DocsTreeSummary {
  const files: Array<{ absolutePath: string; relativePath: string; kind: "file" | "symlink"; size: number }> = [];

  function walk(currentDir: string, prefix: string): void {
    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      const absolutePath = join(currentDir, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(absolutePath, relativePath);
        continue;
      }
      const stat = lstatSync(absolutePath);
      if (entry.isFile()) {
        files.push({ absolutePath, relativePath, kind: "file", size: stat.size });
      } else if (entry.isSymbolicLink()) {
        files.push({ absolutePath, relativePath, kind: "symlink", size: stat.size });
      }
    }
  }

  walk(rootDir, "");

  const hash = createHash("sha256");
  let totalBytes = 0;
  for (const file of files.sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0))) {
    totalBytes += file.size;
    hash.update(file.kind);
    hash.update("\0");
    hash.update(file.relativePath);
    hash.update("\0");
    hash.update(String(file.size));
    hash.update("\0");
    if (file.kind === "file") {
      hash.update(readFileSync(file.absolutePath));
    } else {
      hash.update(readlinkSync(file.absolutePath));
    }
    hash.update("\0");
  }

  return { fileCount: files.length, totalBytes, contentHash: hash.digest("hex") };
}

function emptyTreeSummary(): DocsTreeSummary {
  return { fileCount: 0, totalBytes: 0, contentHash: createHash("sha256").digest("hex") };
}

function isMetadata(value: unknown): value is DocsSnapshotMetadata {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string"
    && typeof record.createdAt === "string"
    && typeof record.reason === "string"
    && typeof record.sourceDocsDir === "string"
    && typeof record.fileCount === "number"
    && typeof record.totalBytes === "number"
    && typeof record.contentHash === "string"
    && typeof record.appVersion === "string";
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.floor(parsed);
}

export function createDocsSnapshotStore(
  docsDir: string,
  snapshotsDir: string,
  options: { appVersion?: string; maxSnapshots?: number } = {},
) {
  const appVersion = options.appVersion ?? process.env.BRIDGE_APP_VERSION ?? "unknown";
  const maxSnapshots = options.maxSnapshots
    ?? parsePositiveInt(process.env.BRIDGE_DOCS_SNAPSHOT_MAX_COUNT, DEFAULT_MAX_SNAPSHOTS);
  let lastCreatedAtMs = 0;

  function assertSnapshotPathsSafe(): void {
    if (isPathAtOrUnder(docsDir, snapshotsDir)) {
      throw new Error(`Docs snapshots directory must not be inside docs directory: ${snapshotsDir}`);
    }
    if (isPathAtOrUnder(snapshotsDir, docsDir)) {
      throw new Error(`Docs directory must not be inside docs snapshots directory: ${docsDir}`);
    }
  }

  function snapshotDir(snapshotId: string): string {
    assertSafeSnapshotId(snapshotId);
    return join(snapshotsDir, snapshotId);
  }

  function metadataPath(snapshotId: string): string {
    return join(snapshotDir(snapshotId), METADATA_FILE);
  }

  function snapshotDocsDir(snapshotId: string): string {
    return join(snapshotDir(snapshotId), SNAPSHOT_DOCS_DIR);
  }

  function readDocsSummary(allowEmpty: boolean): DocsTreeSummary | null {
    if (!existsSync(docsDir)) return allowEmpty ? emptyTreeSummary() : null;
    if (!statSync(docsDir).isDirectory()) {
      throw new Error(`Docs path is not a directory: ${docsDir}`);
    }
    const summary = makeContentHash(docsDir);
    if (summary.fileCount === 0 && !allowEmpty) return null;
    return summary;
  }

  function readSnapshotMetadata(snapshotId: string): DocsSnapshotMetadata | null {
    const filePath = metadataPath(snapshotId);
    if (!existsSync(filePath) || !existsSync(snapshotDocsDir(snapshotId))) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(filePath, "utf-8"));
    } catch {
      return null;
    }
    if (!isMetadata(parsed)) return null;
    if (parsed.id !== snapshotId) return null;
    return parsed;
  }

  function listSnapshots(): DocsSnapshotMetadata[] {
    assertSnapshotPathsSafe();
    if (!existsSync(snapshotsDir)) return [];
    return readdirSync(snapshotsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && SAFE_SNAPSHOT_ID.test(entry.name))
      .map((entry) => {
        try {
          return readSnapshotMetadata(entry.name);
        } catch {
          return null;
        }
      })
      .filter((metadata): metadata is DocsSnapshotMetadata => metadata !== null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  function findRecentSnapshot(summary: DocsTreeSummary, maxAgeMs: number, skipIfUnchanged: boolean): DocsSnapshotMetadata | null {
    const cutoff = Date.now() - maxAgeMs;
    return listSnapshots().find((snapshot) => {
      const createdAt = Date.parse(snapshot.createdAt);
      if (!Number.isFinite(createdAt) || createdAt < cutoff) return false;
      return !skipIfUnchanged || snapshot.contentHash === summary.contentHash;
    }) ?? null;
  }

  function reserveSnapshotDir(): { id: string; dir: string } {
    mkdirSync(snapshotsDir, { recursive: true });
    for (let attempt = 0; attempt < 20; attempt++) {
      const id = makeSnapshotId();
      const dir = snapshotDir(id);
      if (existsSync(dir)) continue;
      mkdirSync(dir);
      return { id, dir };
    }
    throw new Error("Unable to allocate a unique docs snapshot id");
  }

  function nextCreatedAt(): string {
    const timestamp = Math.max(Date.now(), lastCreatedAtMs + 1);
    lastCreatedAtMs = timestamp;
    return new Date(timestamp).toISOString();
  }

  function writeMetadata(snapshotId: string, metadata: DocsSnapshotMetadata): void {
    const finalPath = metadataPath(snapshotId);
    const tempPath = `${finalPath}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf-8");
    renameSync(tempPath, finalPath);
  }

  function copyDocsToSnapshot(targetDocsDir: string): void {
    if (!existsSync(docsDir)) {
      mkdirSync(targetDocsDir, { recursive: true });
      return;
    }
    cpSync(docsDir, targetDocsDir, {
      recursive: true,
      dereference: false,
      errorOnExist: false,
      force: true,
      filter: (source) => !isPathAtOrUnder(snapshotsDir, source),
    });
  }

  function pruneSnapshots(currentSummary?: DocsTreeSummary): { deleted: number; skippedReason?: "suspicious-empty-live-docs" } {
    const snapshots = listSnapshots();
    if (snapshots.length <= maxSnapshots) return { deleted: 0 };

    const liveSummary = currentSummary ?? readDocsSummary(true) ?? emptyTreeSummary();
    if (liveSummary.fileCount === 0 && snapshots.some((snapshot) => snapshot.fileCount > 0)) {
      return { deleted: 0, skippedReason: "suspicious-empty-live-docs" };
    }

    const oldestCount = Math.min(DEFAULT_OLDEST_SNAPSHOTS_TO_KEEP, Math.max(0, maxSnapshots - 1));
    const newestCount = Math.max(1, maxSnapshots - oldestCount);
    const keep = new Set([
      ...snapshots.slice(0, newestCount).map((snapshot) => snapshot.id),
      ...snapshots.slice(-oldestCount).map((snapshot) => snapshot.id),
    ]);

    let deleted = 0;
    for (const snapshot of snapshots) {
      if (keep.has(snapshot.id)) continue;
      rmSync(snapshotDir(snapshot.id), { recursive: true, force: true, ...REMOVE_RETRIES });
      deleted++;
    }
    return { deleted };
  }

  function createSnapshot(createOptions: DocsSnapshotCreateOptions = {}): DocsSnapshotCreateResult {
    assertSnapshotPathsSafe();
    const reason = createOptions.reason ?? "manual";
    const allowEmpty = createOptions.allowEmpty ?? false;
    const sourceSummary = readDocsSummary(allowEmpty);
    if (!sourceSummary) return { snapshot: null, created: false, skippedReason: "empty" };

    if (createOptions.skipIfRecentMs && createOptions.skipIfRecentMs > 0) {
      const recent = findRecentSnapshot(sourceSummary, createOptions.skipIfRecentMs, createOptions.skipIfUnchanged === true);
      if (recent) return { snapshot: recent, created: false, skippedReason: "recent" };
    }

    const { id, dir } = reserveSnapshotDir();
    const targetDocsDir = join(dir, SNAPSHOT_DOCS_DIR);
    copyDocsToSnapshot(targetDocsDir);
    const snapshotSummary = makeContentHash(targetDocsDir);
    const metadata: DocsSnapshotMetadata = {
      id,
      createdAt: nextCreatedAt(),
      reason,
      sourceDocsDir: docsDir,
      fileCount: snapshotSummary.fileCount,
      totalBytes: snapshotSummary.totalBytes,
      contentHash: snapshotSummary.contentHash,
      appVersion,
    };
    writeMetadata(id, metadata);
    if (createOptions.prune !== false) pruneSnapshots(sourceSummary);
    return { snapshot: metadata, created: true };
  }

  function getSnapshot(snapshotId: string): DocsSnapshotMetadata {
    assertSnapshotPathsSafe();
    const metadata = readSnapshotMetadata(snapshotId);
    if (!metadata) throw new DocsSnapshotNotFoundError(snapshotId);
    return metadata;
  }

  function validateSnapshotContents(metadata: DocsSnapshotMetadata): DocsTreeSummary {
    const docsPath = snapshotDocsDir(metadata.id);
    if (!existsSync(docsPath) || !statSync(docsPath).isDirectory()) {
      throw new DocsSnapshotValidationError(`Docs snapshot "${metadata.id}" is missing its docs directory`);
    }
    const summary = makeContentHash(docsPath);
    if (
      summary.fileCount !== metadata.fileCount
      || summary.totalBytes !== metadata.totalBytes
      || summary.contentHash !== metadata.contentHash
    ) {
      throw new DocsSnapshotValidationError(`Docs snapshot "${metadata.id}" failed integrity validation`);
    }
    return summary;
  }

  function makeRestoreSibling(label: string, snapshotId: string): string {
    return join(dirname(docsDir), `${basename(docsDir)}.${label}-${snapshotId}-${randomBytes(3).toString("hex")}`);
  }

  function restoreSnapshot(snapshotId: string): DocsSnapshotRestoreResult {
    const metadata = getSnapshot(snapshotId);
    const summary = validateSnapshotContents(metadata);
    const preRestore = createSnapshot({ reason: "pre-restore", allowEmpty: true, prune: false });
    if (!preRestore.snapshot) {
      throw new DocsSnapshotValidationError("Unable to create pre-restore docs snapshot");
    }

    const stagedDocsDir = makeRestoreSibling("restore-new", metadata.id);
    const oldDocsDir = makeRestoreSibling("restore-old", preRestore.snapshot.id);
    mkdirSync(dirname(docsDir), { recursive: true });
    rmSync(stagedDocsDir, { recursive: true, force: true, ...REMOVE_RETRIES });
    cpSync(snapshotDocsDir(metadata.id), stagedDocsDir, {
      recursive: true,
      dereference: false,
      errorOnExist: false,
      force: true,
    });

    const stagedSummary = makeContentHash(stagedDocsDir);
    if (
      stagedSummary.fileCount !== summary.fileCount
      || stagedSummary.totalBytes !== summary.totalBytes
      || stagedSummary.contentHash !== summary.contentHash
    ) {
      rmSync(stagedDocsDir, { recursive: true, force: true, ...REMOVE_RETRIES });
      throw new DocsSnapshotValidationError(`Staged docs restore for snapshot "${metadata.id}" failed integrity validation`);
    }

    let movedLiveDocs = false;
    try {
      if (existsSync(docsDir)) {
        renameSync(docsDir, oldDocsDir);
        movedLiveDocs = true;
      }
      renameSync(stagedDocsDir, docsDir);
    } catch (error) {
      if (!existsSync(docsDir) && movedLiveDocs && existsSync(oldDocsDir)) {
        renameSync(oldDocsDir, docsDir);
      }
      rmSync(stagedDocsDir, { recursive: true, force: true, ...REMOVE_RETRIES });
      throw error;
    }

    rmSync(oldDocsDir, { recursive: true, force: true, ...REMOVE_RETRIES });
    pruneSnapshots(summary);

    return {
      restoredFrom: metadata,
      preRestoreSnapshotId: preRestore.snapshot.id,
      fileCount: metadata.fileCount,
      totalBytes: metadata.totalBytes,
    };
  }

  assertSnapshotPathsSafe();

  return {
    createSnapshot,
    listSnapshots,
    restoreSnapshot,
    pruneSnapshots,
    getSnapshot,
    docsDir,
    snapshotsDir,
  };
}

export type DocsSnapshotStore = ReturnType<typeof createDocsSnapshotStore>;
