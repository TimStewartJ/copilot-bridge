import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  deleteStagingValidationStamp,
  readStagingValidationStamp,
  validateStagingValidationStamp,
  writeStagingValidationStamp,
} from "../staging-validation-stamp.js";
import { makeTestDir } from "./helpers.js";

const STAMP = {
  stagingPrefix: "preview-deploy",
  stagingCommitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  dependencyHash: "deps-1",
  gateId: "preview",
  gateVersion: 1,
  command: "npm run check:fast && npm run check:pr",
  source: "staging_preview",
  validatedAt: "2026-05-16T23:00:00.000Z",
};

describe("staging validation stamps", () => {
  it("round-trips and validates a current staging validation stamp", () => {
    const dataDir = makeTestDir("staging-stamp");

    writeStagingValidationStamp(dataDir, STAMP);

    expect(readStagingValidationStamp(dataDir, STAMP.stagingPrefix)).toEqual(STAMP);
    expect(validateStagingValidationStamp(readStagingValidationStamp(dataDir, STAMP.stagingPrefix), {
      stagingPrefix: STAMP.stagingPrefix,
      stagingCommitSha: STAMP.stagingCommitSha,
      dependencyHash: STAMP.dependencyHash,
      gateId: STAMP.gateId,
      gateVersion: STAMP.gateVersion,
      command: STAMP.command,
    })).toEqual({ valid: true, stamp: STAMP });
  });

  it("rejects malformed and mismatched staging validation stamps", () => {
    const dataDir = makeTestDir("staging-stamp-invalid");

    expect(readStagingValidationStamp(dataDir, STAMP.stagingPrefix)).toBeNull();
    writeStagingValidationStamp(dataDir, STAMP);

    expect(validateStagingValidationStamp(readStagingValidationStamp(dataDir, STAMP.stagingPrefix), {
      stagingPrefix: STAMP.stagingPrefix,
      stagingCommitSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      dependencyHash: STAMP.dependencyHash,
      gateId: STAMP.gateId,
      gateVersion: STAMP.gateVersion,
      command: STAMP.command,
    })).toMatchObject({ valid: false, reason: expect.stringContaining("commit") });

    expect(validateStagingValidationStamp(readStagingValidationStamp(dataDir, STAMP.stagingPrefix), {
      stagingPrefix: STAMP.stagingPrefix,
      stagingCommitSha: STAMP.stagingCommitSha,
      dependencyHash: "deps-2",
      gateId: STAMP.gateId,
      gateVersion: STAMP.gateVersion,
      command: STAMP.command,
    })).toMatchObject({ valid: false, reason: expect.stringContaining("dependency") });
  });

  it("deletes stale staging validation stamps", () => {
    const dataDir = makeTestDir("staging-stamp-delete");
    writeStagingValidationStamp(dataDir, STAMP);

    deleteStagingValidationStamp(dataDir, STAMP.stagingPrefix);

    expect(readStagingValidationStamp(dataDir, STAMP.stagingPrefix)).toBeNull();
  });

  it("ignores unreadable stamp content", () => {
    const dataDir = makeTestDir("staging-stamp-malformed");
    writeStagingValidationStamp(dataDir, STAMP);
    writeFileSync(join(dataDir, "staging-validation-stamps", `${STAMP.stagingPrefix}.json`), "{nope");

    expect(readStagingValidationStamp(dataDir, STAMP.stagingPrefix)).toBeNull();
  });
});
