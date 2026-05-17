import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  readDeployValidationStamp,
  validateDeployValidationStamp,
  writeDeployValidationStamp,
} from "../deploy-validation-stamp.js";
import { makeTestDir } from "./helpers.js";

const STAMP = {
  commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  dependencyHash: "deps-1",
  gateId: "deploy",
  gateVersion: 1,
  command: "npm run check:deploy",
  source: "staging_deploy",
  validatedAt: "2026-05-16T23:00:00.000Z",
};

describe("deploy validation stamps", () => {
  it("round-trips a current deploy validation stamp", () => {
    const dataDir = makeTestDir("deploy-stamp");

    writeDeployValidationStamp(dataDir, STAMP);

    expect(readDeployValidationStamp(dataDir)).toEqual(STAMP);
    expect(validateDeployValidationStamp(readDeployValidationStamp(dataDir), {
      commitSha: STAMP.commitSha,
      dependencyHash: STAMP.dependencyHash,
      gateId: STAMP.gateId,
      gateVersion: STAMP.gateVersion,
      command: STAMP.command,
    })).toEqual({ valid: true, stamp: STAMP });
  });

  it("rejects malformed and mismatched stamps", () => {
    const dataDir = makeTestDir("deploy-stamp-invalid");

    expect(readDeployValidationStamp(dataDir)).toBeNull();
    writeDeployValidationStamp(dataDir, STAMP);

    expect(validateDeployValidationStamp(readDeployValidationStamp(dataDir), {
      commitSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      dependencyHash: STAMP.dependencyHash,
      gateId: STAMP.gateId,
      gateVersion: STAMP.gateVersion,
      command: STAMP.command,
    })).toMatchObject({ valid: false, reason: expect.stringContaining("commit") });

    expect(validateDeployValidationStamp(readDeployValidationStamp(dataDir), {
      commitSha: STAMP.commitSha,
      dependencyHash: "deps-2",
      gateId: STAMP.gateId,
      gateVersion: STAMP.gateVersion,
      command: STAMP.command,
    })).toMatchObject({ valid: false, reason: expect.stringContaining("dependency") });
  });

  it("ignores unreadable stamp content", () => {
    const dataDir = makeTestDir("deploy-stamp-malformed");
    const path = join(dataDir, "deploy-validation-stamp.json");
    writeDeployValidationStamp(dataDir, STAMP);
    writeFileSync(path, "{nope");

    expect(readDeployValidationStamp(dataDir)).toBeNull();
  });
});
