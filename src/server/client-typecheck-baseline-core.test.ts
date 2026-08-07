import { describe, expect, it } from "vitest";
import {
  compareClientTypecheckBaselines,
  createClientTypecheckBaseline,
  type DiagnosticRecord,
} from "./client-typecheck-baseline-core.js";

function diagnostic(overrides: Partial<DiagnosticRecord> = {}): DiagnosticRecord {
  return {
    code: 2345,
    file: "src/client/example.tsx",
    line: 10,
    character: 5,
    message: "Argument is not assignable.",
    ...overrides,
  };
}

describe("client typecheck baseline comparison", () => {
  it("ignores line and character movement", () => {
    const baseline = createClientTypecheckBaseline([diagnostic()]);
    const current = createClientTypecheckBaseline([
      diagnostic({ line: 48, character: 11 }),
    ]);

    expect(compareClientTypecheckBaselines(current, baseline)).toEqual({
      added: [],
      removed: [],
    });
  });

  it("reports a new diagnostic identity in a baselined file", () => {
    const baseline = createClientTypecheckBaseline([diagnostic()]);
    const current = createClientTypecheckBaseline([
      diagnostic(),
      diagnostic({ code: 18047, message: "'value' is possibly null." }),
    ]);

    expect(compareClientTypecheckBaselines(current, baseline).added).toEqual([
      expect.objectContaining({
        code: 18047,
        previousCount: 0,
        currentCount: 1,
      }),
    ]);
  });

  it("reports an extra occurrence of an existing diagnostic", () => {
    const baseline = createClientTypecheckBaseline([diagnostic()]);
    const current = createClientTypecheckBaseline([
      diagnostic(),
      diagnostic({ line: 22, character: 9 }),
    ]);

    expect(compareClientTypecheckBaselines(current, baseline).added).toEqual([
      expect.objectContaining({
        code: 2345,
        previousCount: 1,
        currentCount: 2,
      }),
    ]);
  });

  it("reports a resolved diagnostic or reduced occurrence count", () => {
    const baseline = createClientTypecheckBaseline([
      diagnostic(),
      diagnostic({ line: 22, character: 9 }),
    ]);
    const current = createClientTypecheckBaseline([diagnostic()]);

    expect(compareClientTypecheckBaselines(current, baseline).removed).toEqual([
      expect.objectContaining({
        code: 2345,
        previousCount: 2,
        currentCount: 1,
      }),
    ]);
  });
});

