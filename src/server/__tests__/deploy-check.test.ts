import { describe, expect, it } from "vitest";
import { DEPLOY_CHECK_STEPS } from "../deploy-check.js";

describe("deploy check contract", () => {
  it("does not run coverage during interactive deploy validation", () => {
    const commands = DEPLOY_CHECK_STEPS.map((step) => step.join(" "));

    expect(commands).toEqual([
      "npm run check:pr",
      "npm run preview:smoke",
    ]);
    expect(commands).not.toContain("npm run test:coverage");
  });
});
