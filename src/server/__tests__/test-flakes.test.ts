import { describe, expect, it } from "vitest";
import { decideFlakeOutcome } from "../test-flakes.js";

describe("decideFlakeOutcome", () => {
  it("passes only when every failure passed on rerun and the change reaches none of them", () => {
    expect(decideFlakeOutcome({ failed: ["a", "b"], rerunFailed: new Set(), affected: new Set(["c"]) }))
      .toEqual({ pass: true, flakes: [{ file: "a", excused: true }, { file: "b", excused: true }] });
  });

  it("fails when a file fails again, while still recording the files that passed", () => {
    expect(decideFlakeOutcome({ failed: ["a", "b"], rerunFailed: new Set(["b"]), affected: new Set() }))
      .toEqual({ pass: false, flakes: [{ file: "a", excused: true }] });
  });

  it("does not excuse a flake the change reaches, or any flake when the change is unknown", () => {
    expect(decideFlakeOutcome({ failed: ["a"], rerunFailed: new Set(), affected: new Set(["a"]) }))
      .toEqual({ pass: false, flakes: [{ file: "a", excused: false, blockedBecause: "changed" }] });
    expect(decideFlakeOutcome({ failed: ["a"], rerunFailed: new Set() }))
      .toEqual({ pass: false, flakes: [{ file: "a", excused: false, blockedBecause: "no-base" }] });
  });
});
