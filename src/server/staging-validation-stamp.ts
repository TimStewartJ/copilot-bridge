import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface StagingValidationStamp {
  stagingPrefix: string;
  stagingCommitSha: string;
  dependencyHash: string;
  gateId: string;
  gateVersion: number;
  command: string;
  source: string;
  validatedAt: string;
}

export interface StagingValidationStampExpectation {
  stagingPrefix: string;
  stagingCommitSha: string;
  dependencyHash: string;
  gateId: string;
  gateVersion: number;
  command: string;
}

const STAGING_VALIDATION_STAMPS_DIR = "staging-validation-stamps";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizePrefix(prefix: string): string {
  return prefix.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "staging";
}

function stampsDir(dataDir: string): string {
  return join(dataDir, STAGING_VALIDATION_STAMPS_DIR);
}

function stampPath(dataDir: string, stagingPrefix: string): string {
  return join(stampsDir(dataDir), `${sanitizePrefix(stagingPrefix)}.json`);
}

export function readStagingValidationStamp(dataDir: string, stagingPrefix: string): StagingValidationStamp | null {
  const path = stampPath(dataDir, stagingPrefix);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!isRecord(parsed)) return null;
    const {
      stagingPrefix: parsedPrefix,
      stagingCommitSha,
      dependencyHash,
      gateId,
      gateVersion,
      command,
      source,
      validatedAt,
    } = parsed;
    if (
      typeof parsedPrefix !== "string"
      || typeof stagingCommitSha !== "string"
      || typeof dependencyHash !== "string"
      || typeof gateId !== "string"
      || typeof gateVersion !== "number"
      || typeof command !== "string"
      || typeof source !== "string"
      || typeof validatedAt !== "string"
    ) {
      return null;
    }
    return {
      stagingPrefix: parsedPrefix,
      stagingCommitSha,
      dependencyHash,
      gateId,
      gateVersion,
      command,
      source,
      validatedAt,
    };
  } catch {
    return null;
  }
}

export function writeStagingValidationStamp(dataDir: string, stamp: StagingValidationStamp): void {
  const dir = stampsDir(dataDir);
  mkdirSync(dir, { recursive: true });
  const target = stampPath(dataDir, stamp.stagingPrefix);
  const tmp = join(dir, `${sanitizePrefix(stamp.stagingPrefix)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(stamp, null, 2)}\n`);
  renameSync(tmp, target);
}

export function deleteStagingValidationStamp(dataDir: string, stagingPrefix: string): void {
  rmSync(stampPath(dataDir, stagingPrefix), { force: true });
}

export function validateStagingValidationStamp(
  stamp: StagingValidationStamp | null,
  expected: StagingValidationStampExpectation,
): { valid: true; stamp: StagingValidationStamp } | { valid: false; reason: string } {
  if (!stamp) return { valid: false, reason: "missing staging validation stamp" };
  if (stamp.stagingPrefix !== expected.stagingPrefix) {
    return { valid: false, reason: "stamp staging prefix does not match current staging worktree" };
  }
  if (stamp.stagingCommitSha !== expected.stagingCommitSha) {
    return { valid: false, reason: "stamp commit does not match current staging HEAD" };
  }
  if (stamp.dependencyHash !== expected.dependencyHash) {
    return { valid: false, reason: "stamp dependency hash does not match current dependencies" };
  }
  if (stamp.gateId !== expected.gateId || stamp.gateVersion !== expected.gateVersion) {
    return { valid: false, reason: "stamp validation gate does not match current preview gate" };
  }
  if (stamp.command !== expected.command) {
    return { valid: false, reason: "stamp command does not match current preview command" };
  }
  return { valid: true, stamp };
}
