import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export interface DeployValidationStamp {
  commitSha: string;
  dependencyHash: string;
  gateId: string;
  gateVersion: number;
  command: string;
  source: string;
  validatedAt: string;
}

export interface DeployValidationStampExpectation {
  commitSha: string;
  dependencyHash: string;
  gateId: string;
  gateVersion: number;
  command: string;
}

const STAMP_FILE = "deploy-validation-stamp.json";

function stampPath(dataDir: string): string {
  return join(dataDir, STAMP_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readDeployValidationStamp(dataDir: string): DeployValidationStamp | null {
  const path = stampPath(dataDir);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!isRecord(parsed)) return null;
    const {
      commitSha,
      dependencyHash,
      gateId,
      gateVersion,
      command,
      source,
      validatedAt,
    } = parsed;
    if (
      typeof commitSha !== "string"
      || typeof dependencyHash !== "string"
      || typeof gateId !== "string"
      || typeof gateVersion !== "number"
      || typeof command !== "string"
      || typeof source !== "string"
      || typeof validatedAt !== "string"
    ) {
      return null;
    }
    return { commitSha, dependencyHash, gateId, gateVersion, command, source, validatedAt };
  } catch {
    return null;
  }
}

export function writeDeployValidationStamp(dataDir: string, stamp: DeployValidationStamp): void {
  mkdirSync(dataDir, { recursive: true });
  const target = stampPath(dataDir);
  const tmp = join(dataDir, `${STAMP_FILE}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(stamp, null, 2)}\n`);
  renameSync(tmp, target);
}

export function validateDeployValidationStamp(
  stamp: DeployValidationStamp | null,
  expected: DeployValidationStampExpectation,
): { valid: true; stamp: DeployValidationStamp } | { valid: false; reason: string } {
  if (!stamp) return { valid: false, reason: "missing deploy validation stamp" };
  if (stamp.commitSha !== expected.commitSha) {
    return { valid: false, reason: "stamp commit does not match current HEAD" };
  }
  if (stamp.dependencyHash !== expected.dependencyHash) {
    return { valid: false, reason: "stamp dependency hash does not match current dependencies" };
  }
  if (stamp.gateId !== expected.gateId || stamp.gateVersion !== expected.gateVersion) {
    return { valid: false, reason: "stamp validation gate does not match current deploy gate" };
  }
  if (stamp.command !== expected.command) {
    return { valid: false, reason: "stamp command does not match current deploy command" };
  }
  return { valid: true, stamp };
}
